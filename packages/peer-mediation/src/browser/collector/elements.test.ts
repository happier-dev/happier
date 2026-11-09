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
});
