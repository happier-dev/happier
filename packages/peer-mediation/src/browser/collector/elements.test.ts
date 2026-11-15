import { describe, expect, it } from 'vitest';
import { buildBrowserElementAtPointExpression } from './elements.js';

describe('browser element description', () => {
  it('uses viewport hit-testing and retains the selected React component/source without page-scroll offsets', () => {
    const sourceLocation = { fileName: 'src/Checkout.tsx', lineNumber: 12, columnNumber: 4 };
    function CheckoutButton() {}
    const button = { nodeType: 1, tagName: 'BUTTON', previousElementSibling: null, parentElement: null,
      getAttribute: (name: string) => name === 'aria-label' ? 'Checkout' : null,
      getBoundingClientRect: () => ({ x: 10, y: 20, width: 80, height: 30 }),
      '__reactFiber$test': { type: CheckoutButton, _debugSource: sourceLocation } };
    const hitPoints: unknown[] = [];
    const document = { elementFromPoint: (x: number, y: number) => { hitPoints.push({ x, y }); return button; } };
    // The DOM is the platform boundary; evaluate the exact expression used by CDP.
    const result: unknown = new Function('document', `return ${buildBrowserElementAtPointExpression({ x: 15, y: 25 })}`)(document);
    expect(hitPoints).toEqual([{ x: 15, y: 25 }]);
    expect(result).toEqual({ selectorPath: 'button:nth-of-type(1)', accessibleName: 'Checkout',
      rect: { x: 10, y: 20, width: 80, height: 30 }, componentName: 'CheckoutButton',
      sourceLocation: { file: 'src/Checkout.tsx', line: 12, column: 4 } });
  });
  it('settles a point outside the document as empty', () => {
    const result: unknown = new Function('document', `return ${buildBrowserElementAtPointExpression({ x: 0, y: 0 })}`)({ elementFromPoint: () => null });
    expect(result).toBeNull();
  });

  it.each(['function', 'wrapped render', 'owner stack'])('retains complete element metadata from a %s component', (kind) => {
    const tagName = `x-${'control'.repeat(320)}`;
    const accessibleName = 'Checkout details '.repeat(60).trim();
    const componentName = 'CheckoutComponent'.repeat(12);
    const file = `http://localhost/${'nested/'.repeat(160)}Checkout.tsx`;
    const component = Object.assign(function Component() {}, { displayName: componentName });
    const fiber = {
      type: kind === 'wrapped render' ? { render: component } : component,
      ...(kind === 'owner stack'
        ? { _debugStack: { stack: `Error\n    at jsxDEV (http://localhost/react.js:1:1)\n    at Checkout (${file}:12:4)` } }
        : { _debugSource: { fileName: file, lineNumber: 12, columnNumber: 4 } }),
    };
    const node = {
      nodeType: 1, tagName, previousElementSibling: null, parentElement: null,
      getAttribute: (name: string) => name === 'aria-label' ? accessibleName : null,
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 80, height: 30 }),
      '__reactFiber$test': fiber,
    };
    // DOM and React metadata are page-owned inputs to the exact shipped expression.
    const result: unknown = new Function('document', `return ${buildBrowserElementAtPointExpression({ x: 1, y: 1 })}`)({
      elementFromPoint: () => node,
    });
    expect(result).toEqual({
      selectorPath: `${tagName}:nth-of-type(1)`, accessibleName, componentName,
      rect: { x: 0, y: 0, width: 80, height: 30 },
      sourceLocation: { file, line: 12, column: 4 },
    });
  });
});
