import { describe, expect, it } from 'vitest';

import { PluginDeclarativeDocumentNormalizationErrorV1 } from '../../../plugins/contributions/ui/declarativeDocument.js';
import { normalizeSessionSurfaceDeclarativeDocumentV1 } from './normalize.js';

describe('Session surface declarative document normalization', () => {
  it('refuses plugin drag declarations without an installed declaration authority', () => {
    for (const root of [
      { kind: 'dragSource', sourceId: 'card', reference: '42', children: [] },
      { kind: 'dropTarget', targetId: 'tray', children: [] },
      { kind: 'widgetArea', area: 'pinned' },
    ]) expect(() => normalizeSessionSurfaceDeclarativeDocumentV1({ document: { version: 1, root }, admittedHostActions: [] })).toThrow();
  });
  it('normalizes the restricted Session document through the shared declarative owner', () => {
    const normalized = normalizeSessionSurfaceDeclarativeDocumentV1({
      document: {
        version: 1,
        root: {
          kind: 'stack',
          children: [
            { kind: 'markdown', text: '# Status' },
            {
              kind: 'action',
              label: 'Send',
              hostAction: 'session.message.send',
              input: { text: 'Hello' },
            },
          ],
        },
      },
      admittedHostActions: ['session.message.send'],
    });

    expect(normalized.root).toMatchObject({ kind: 'stack', path: 'root', order: 0 });
    expect(normalized.nodes.map((node) => ({ kind: node.kind, path: node.path, order: node.order }))).toEqual([
      { kind: 'stack', path: 'root', order: 0 },
      { kind: 'markdown', path: 'root.children[0]', order: 1 },
      { kind: 'action', path: 'root.children[1]', order: 2 },
    ]);
  });

  it('fails closed when a canonical host Action was not admitted by the Session caller', () => {
    expect(() => normalizeSessionSurfaceDeclarativeDocumentV1({
      document: {
        version: 1,
        root: { kind: 'action', label: 'Send', hostAction: 'session.message.send' },
      },
      admittedHostActions: [],
    })).toThrowError(PluginDeclarativeDocumentNormalizationErrorV1);
  });
});
