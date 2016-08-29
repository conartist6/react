/**
 * Copyright 2013-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactEventListener
 */

'use strict';

var EventListener = require('EventListener');
var ExecutionEnvironment = require('ExecutionEnvironment');
var PooledClass = require('PooledClass');
var ReactDOMComponentTree = require('ReactDOMComponentTree');
var ReactUpdates = require('ReactUpdates');

var getEventTarget = require('getEventTarget');
var getUnboundedScrollPosition = require('getUnboundedScrollPosition');

// Used to store metadata about DOM events
function DOMEventMetadata(isRelatedTarget) {
  this.isRelatedTarget = isRelatedTarget;
}
Object.assign(DOMEventMetadata.prototype, {
  destructor: function() {
    this.isRelatedTarget = null;
  },
});
PooledClass.addPoolingTo(DOMEventMetadata);

// Used to store ancestor hierarchy in top level callback
function TopLevelCallbackBookKeeping(topLevelType, nativeEvent) {
  this.topLevelType = topLevelType;
  this.nativeEvent = nativeEvent;
  this.ancestors = [];
  this.ancestorMetadata = [];
  this.relatedAncestors = [];
  this.roots = [];
  this.relatedRoots = [];
}
Object.assign(TopLevelCallbackBookKeeping.prototype, {
  destructor: function() {
    this.topLevelType = null;
    this.nativeEvent = null;
    this.ancestors.length = 0;
    for(let i=0; i<this.ancestorMetadata.length; i++) {
      DOMEventMetadata.release(this.ancestorMetadata[i]);
    }
    this.roots.length = 0;
    this.relatedRoots.length = 0;
    this.ancestorMetadata.length = 0;
    this.relatedAncestors.length = 0;
  },
});
PooledClass.addPoolingTo(
  TopLevelCallbackBookKeeping,
  PooledClass.twoArgumentPooler
);

function _collectAncestors(ancestors, roots, targetInst) {
  // Loop through the hierarchy, in case there's any nested components.
  // It's important that we build the array of ancestors before calling any
  // event handlers, because event handlers can modify the DOM, leading to
  // inconsistencies with ReactMount's node cache. See #1105.
  if(!targetInst) { return; }

  var ancestor = targetInst;
  do {
    ancestors.push(ancestor);
    while (ancestor._hostParent) {
      ancestor = ancestor._hostParent;
    }
    var rootNode = ReactDOMComponentTree.getNodeFromInstance(ancestor);
    roots.push(rootNode);
    var container = rootNode.parentNode;
    ancestor = ReactDOMComponentTree.getClosestInstanceFromNode(container);
  } while (ancestor);
}

function handleTopLevelImpl(bookKeeping) {
  // TODO There is another bug here. There may be two targets.
  // If nativeEventTarget is not in a react root, but relatedTarget is,
  // EnterLeaveEventPlugin will fail to trigger enter in a root containing
  // a nested root.
  var nativeEventTarget = getEventTarget(bookKeeping.nativeEvent);

  var targetInst = ReactDOMComponentTree.getClosestInstanceFromNode(
    nativeEventTarget
  );

  _collectAncestors(bookKeeping.ancestors, bookKeeping.roots, targetInst);

  for(let i=0; i < bookKeeping.ancestors.length; i++) {
    bookKeeping.ancestorMetadata[i] = DOMEventMetadata.getPooled(false);
  }

  if(bookKeeping.nativeEvent.relatedTarget) {
    let relatedTargetInst = ReactDOMComponentTree.getClosestInstanceFromNode(
        bookKeeping.nativeEvent.relatedTarget
    );

    _collectAncestors(
      bookKeeping.relatedAncestors,
      bookKeeping.relatedRoots,
      relatedTargetInst);

    for(let i = -1; i < bookKeeping.relatedAncestors.length - 1; i++) {
      let root = bookKeeping.roots[bookKeeping.roots.length - i];
      let relatedRoot =
        bookKeeping.relatedRoots[bookKeeping.relatedRoots.length - i];

      if(!root || root !== relatedRoot) {
        bookKeeping.ancestorMetadata[bookKeeping.ancestors.length] =
          DOMEventMetadata.getPooled(true);
        bookKeeping.ancestors.push(
          bookKeeping.relatedAncestors[bookKeeping.relatedAncestors.length - i]);
      }
    }
  }

  for (let i = 0; i < bookKeeping.ancestors.length; i++) {
    targetInst = bookKeeping.ancestors[i];
    ReactEventListener._handleTopLevel(
      bookKeeping.topLevelType,
      targetInst,
      bookKeeping.nativeEvent,
      getEventTarget(bookKeeping.nativeEvent),
      bookKeeping.ancestorMetadata[i],
    );
  }
}

function scrollValueMonitor(cb) {
  var scrollPosition = getUnboundedScrollPosition(window);
  cb(scrollPosition);
}

var ReactEventListener = {
  _enabled: true,
  _handleTopLevel: null,

  WINDOW_HANDLE: ExecutionEnvironment.canUseDOM ? window : null,

  setHandleTopLevel: function(handleTopLevel) {
    ReactEventListener._handleTopLevel = handleTopLevel;
  },

  setEnabled: function(enabled) {
    ReactEventListener._enabled = !!enabled;
  },

  isEnabled: function() {
    return ReactEventListener._enabled;
  },


  /**
   * Traps top-level events by using event bubbling.
   *
   * @param {string} topLevelType Record from `EventConstants`.
   * @param {string} handlerBaseName Event name (e.g. "click").
   * @param {object} handle Element on which to attach listener.
   * @return {?object} An object with a remove function which will forcefully
   *                  remove the listener.
   * @internal
   */
  trapBubbledEvent: function(topLevelType, handlerBaseName, handle) {
    var element = handle;
    if (!element) {
      return null;
    }
    return EventListener.listen(
      element,
      handlerBaseName,
      ReactEventListener.dispatchEvent.bind(null, topLevelType)
    );
  },

  /**
   * Traps a top-level event by using event capturing.
   *
   * @param {string} topLevelType Record from `EventConstants`.
   * @param {string} handlerBaseName Event name (e.g. "click").
   * @param {object} handle Element on which to attach listener.
   * @return {?object} An object with a remove function which will forcefully
   *                  remove the listener.
   * @internal
   */
  trapCapturedEvent: function(topLevelType, handlerBaseName, handle) {
    var element = handle;
    if (!element) {
      return null;
    }
    return EventListener.capture(
      element,
      handlerBaseName,
      ReactEventListener.dispatchEvent.bind(null, topLevelType)
    );
  },

  monitorScrollValue: function(refresh) {
    var callback = scrollValueMonitor.bind(null, refresh);
    EventListener.listen(window, 'scroll', callback);
  },

  dispatchEvent: function(topLevelType, nativeEvent) {
    if (!ReactEventListener._enabled) {
      return;
    }

    var bookKeeping = TopLevelCallbackBookKeeping.getPooled(
      topLevelType,
      nativeEvent
    );
    try {
      // Event queue being processed in the same cycle allows
      // `preventDefault`.
      ReactUpdates.batchedUpdates(handleTopLevelImpl, bookKeeping);
    } finally {
      TopLevelCallbackBookKeeping.release(bookKeeping);
    }
  },
};

module.exports = ReactEventListener;
