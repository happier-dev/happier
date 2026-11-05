import { describe, expect, it } from 'vitest';
import { interactiveElementsExpression, parseAxNodes, parseInteractiveElements } from './snapshotEvaluators';
import { readSnapshotMasking, snapshotTextMasker } from './snapshotMasking';
import { createSnapshotMaskingFixture } from './snapshotMasking.testkit';

describe('CDP editable AX values', () => {
  it('excludes secret fields and omits values without DOM evidence', () => {
    const tree = { nodes: [1, 2, 3].map(id => ({ backendDOMNodeId: id, role: { value: 'textbox' },
      value: { value: `field-${id}` }, properties: [{ name: 'editable', value: { value: 'plaintext' } }],
    })) };
    const masking = readSnapshotMasking(createSnapshotMaskingFixture([
      { backendNodeId: 1, type: 'PASSWORD', value: 'field-1' },
      { backendNodeId: 2, autocomplete: 'one-time-code', value: 'field-2' },
      { backendNodeId: 3, nodeName: 'TEXTAREA', value: 'field-3' },
    ]));
    expect(parseAxNodes(tree, masking).nodes).toEqual([
      { role: 'textbox' }, { role: 'textbox' }, { role: 'textbox', value: 'field-3' },
    ]);
    const unavailable = parseAxNodes(tree);
    expect(unavailable.nodes).toEqual([
      { role: 'textbox' }, { role: 'textbox' }, { role: 'textbox' },
    ]);
    expect(unavailable.truncated).toBe(true);
  });

  it('omits CSS-masked editable values using census node identities', () => {
    const masking = readSnapshotMasking(createSnapshotMaskingFixture([{ backendNodeId: 7,
      type: 'text', security: 'disc', value: 'css-secret' }]));
    expect(parseAxNodes({ nodes: [{ backendDOMNodeId: 7, role: { value: 'textbox' },
      properties: [{ name: 'editable', value: { value: 'plaintext' } }], value: { value: 'css-secret' },
    }] }, masking).nodes).toEqual([{ role: 'textbox' }]);
  });

  it('preserves ordinary whitespace while masking CSS-sensitive text', () => {
    const mask = snapshotTextMasker(readSnapshotMasking(createSnapshotMaskingFixture([
      { security: 'disc', text: true, value: ' ' }, { security: 'disc', text: true, value: '1234' },
    ])));
    expect(mask('Public page 1234 content')).toBe('Public page [MASKED] content');
    expect(mask('body > button')).toBe('body > button');
  });
});

describe('CDP interactive element extraction', () => {
  it('preserves every valid control and its full accessible name through evaluator and parser', () => {
    const name = 'Accessible label '.repeat(20).trim();
    const nodes = Array.from({ length: 513 }, (_, index) => ({
      id: `element-${index}`, tagName: 'BUTTON', nodeType: 1, textContent: name, parentElement: null,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }),
    }));
    const document = { querySelectorAll: (selector: string) => selector.startsWith('#') ? nodes.filter(node => `#${node.id}` === selector) : nodes };
    const raw = Function('document', 'window', 'CSS', `return ${interactiveElementsExpression()};`)(document, { CSS: true }, { escape: String });
    const parsed = parseInteractiveElements(raw);
    expect(parsed.elements).toHaveLength(513);
    expect(parsed.elements.every(element => element.name === name)).toBe(true);
    expect(parsed.truncated).toBe(false);
  });
  it('preserves complete executable selectors through evaluator and parser', () => {
    const id = 'element-'.repeat(200);
    const name = 'Accessible label '.repeat(12).trim();
    const element = { id, tagName: 'BUTTON', nodeType: 1, textContent: name, getAttribute: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, width: 40, height: 20 }) };
    const document = { querySelectorAll: (selector: string) => selector === `#${id}` ? [element] : [element] };
    const raw = Function('document', 'window', 'CSS', `return ${interactiveElementsExpression()}`)(document, { CSS: { escape: (value: string) => value } }, { escape: (value: string) => value });
    const parsed = parseInteractiveElements(raw);
    expect(parsed.elements[0]?.selector).toBe(`#${id}`);
    expect(parsed.elements[0]?.name).toBe(name);
    expect(parsed.truncated).toBe(false);
  });

  it('marks incomplete extraction when a malformed control has no executable selector', () => {
    const parsed = parseInteractiveElements([{ role: 'button', selector: 42, rect: { x: 0, y: 0, width: 1, height: 1 } }]);
    expect(parsed.elements).toEqual([]);
    expect(parsed.truncated).toBe(true);
  });
});
