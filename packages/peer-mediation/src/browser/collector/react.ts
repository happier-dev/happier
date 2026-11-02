/** Framework metadata read only when an element is selected, never while highlighting it. */
export const INJECTED_REACT_CONTEXT_RUNTIME = `
  function reactFiberFor(node) {
    try {
      var keys = Object.keys(node);
      for (var index = 0; index < keys.length; index += 1) {
        var key = keys[index];
        if (key.indexOf('__reactFiber$') === 0 || key.indexOf('__reactInternalInstance$') === 0) {
          return node[key];
        }
      }
    } catch (_error) {
      // Proxied or frozen nodes: no component context available.
    }
    return null;
  }

  function componentNameForFiber(fiber) {
    var type = fiber && fiber.type;
    if (typeof type === 'function') {
      return String(type.displayName || type.name || '').slice(0, 128);
    }
    if (type && typeof type === 'object') {
      var render = type.render;
      var name = type.displayName
        || (render && (render.displayName || render.name))
        || '';
      return String(name).slice(0, 128);
    }
    return '';
  }

  function sourceLocationFromDebugStack(debugStack) {
    var stack = debugStack && debugStack.stack;
    if (typeof stack !== 'string') return undefined;
    var frames = stack.split('\\n');
    var skippedRuntimeFrame = false;
    for (var index = 0; index < frames.length; index += 1) {
      var frame = frames[index];
      if (frame.indexOf('react_stack_bottom_frame') !== -1) return undefined;
      // V8 uses "at name (file:line:column)"; Firefox and Safari use "name@file:line:column".
      var match = frame.match(/^\\s*at (?:.*? \\()?(.+):(\\d+):(\\d+)\\)?$/)
        || frame.match(/^(?:.*?@)?(.+):(\\d+):(\\d+)$/);
      if (!match) continue;
      // React 19's raw owner Error starts at jsxDEV/createElement. Like ReactDOM's
      // formatOwnerStack, drop that React runtime frame to expose the JSX callsite.
      if (!skippedRuntimeFrame) {
        skippedRuntimeFrame = true;
        continue;
      }
      var line = Number(match[2]);
      var column = Number(match[3]);
      if (line < 1 || column < 1) return undefined;
      return { file: match[1].slice(0, 1024), line: line, column: column };
    }
    return undefined;
  }

  function sourceLocationForFiber(fiber) {
    var source = fiber && (fiber._debugSource || (fiber._debugOwner && fiber._debugOwner._debugSource));
    if (source && typeof source.fileName === 'string' && source.fileName.length > 0) {
      var line = Number(source.lineNumber || 0);
      var column = Number(source.columnNumber || 0);
      return {
        file: source.fileName.slice(0, 1024),
        ...(line > 0 ? { line: line } : {}),
        ...(column > 0 ? { column: column } : {})
      };
    }
    return sourceLocationFromDebugStack(fiber && fiber._debugStack)
      || sourceLocationFromDebugStack(fiber && fiber._debugOwner && fiber._debugOwner._debugStack);
  }

  // UB-7: React's development metadata supplies an edit site as well as a selector.
  // Production builds and non-React pages simply omit unavailable context.
  function componentContextFor(node) {
    var fiber = reactFiberFor(node);
    var depth = 0;
    var sourceLocation;
    while (fiber && depth < 12) {
      // Keep the nearest JSX location: a named component's own stack describes where
      // its parent mounted it, whereas the selected host fiber points at the actual markup.
      if (!sourceLocation) sourceLocation = sourceLocationForFiber(fiber);
      var componentName = componentNameForFiber(fiber);
      if (componentName) {
        return {
          componentName: componentName,
          ...(sourceLocation ? { sourceLocation: sourceLocation } : {})
        };
      }
      fiber = fiber.return;
      depth += 1;
    }
    return {};
  }
`;
