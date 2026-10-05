import { describe, expect, it } from 'vitest';
import { PluginDeclarativeDocumentV1Schema } from './declarativeDocumentAuthoringV1.js';
import { SessionSurfaceDeclarativeDocumentV1Schema } from '../../../sessions/board/declarative/authoring.js';
import { freezePluginDeclarativeDataNodeV1 } from './declarativeDataV1.js';

const metricDocument = {
  version: 1,
  root: {
    kind: 'metric', label: 'Checks',
    data: { kind: 'resource', resource: { pluginId: 'com.acme.checks', localId: 'summary' },
      inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'], additionalProperties: false },
      input: { sessionId: 'session-b' },
      outputSchema: { type: 'object', properties: { count: { type: 'number' }, privateToken: { type: 'string' } }, required: ['count'], additionalProperties: false } },
    value: { path: ['count'], type: 'number' },
  },
};

describe('declarative typed data admission', () => {
  it('admits and freezes metric comparisons without carrying undisplayed output', () => {
    const root = { ...metricDocument.root,
      comparison: { value: { path: ['change'], type: 'string' }, label: 'vs last week', meaning: 'good' },
      data: { ...metricDocument.root.data, outputSchema: { type: 'object', properties: {
        count: { type: 'number' }, change: { type: 'string' }, token: { type: 'string' },
      }, required: ['count', 'change'], additionalProperties: false } },
    };
    const parsed = PluginDeclarativeDocumentV1Schema.safeParse({ version: 1, root });
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.root.kind !== 'metric') throw new Error('Expected metric');
    const frozen = freezePluginDeclarativeDataNodeV1(parsed.data.root, { count: 7, change: '+18%', token: 'private' });
    expect(frozen.data).toEqual({ kind: 'value', value: { value: 7, comparison: '+18%' } });
    expect(SessionSurfaceDeclarativeDocumentV1Schema.safeParse({ version: 1, root: frozen }).success).toBe(true);
    expect(PluginDeclarativeDocumentV1Schema.safeParse({ version: 1, root: { ...root,
      comparison: { ...root.comparison, value: { path: ['token'], type: 'number' } },
    } }).success).toBe(false);
  });

  it('admits and freezes typed CI marks and rejects marks with nonboolean fields', () => {
    const root = { kind: 'rows', data: { kind: 'value', value: [{ name: 'Unit', passed: true, token: 'private' }] }, rows: [],
      columns: [{ label: 'Check', field: { path: ['name'], type: 'string' } }],
      mark: { field: { path: ['passed'], type: 'boolean' }, whenTrue: { label: 'Passed', meaning: 'good' },
        whenFalse: { label: 'Failed', meaning: 'bad' } },
    };
    const parsed = PluginDeclarativeDocumentV1Schema.safeParse({ version: 1, root });
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.root.kind !== 'rows') throw new Error('Expected rows');
    const frozen = freezePluginDeclarativeDataNodeV1(parsed.data.root, undefined);
    expect(frozen.data).toEqual({ kind: 'value', value: [{ c0: 'Unit', mark: true }] });
    expect(SessionSurfaceDeclarativeDocumentV1Schema.safeParse({ version: 1, root: frozen }).success).toBe(true);
    expect(PluginDeclarativeDocumentV1Schema.safeParse({ version: 1, root: { ...root,
      mark: { ...root.mark, field: { path: ['name'], type: 'string' } },
    } }).success).toBe(false);
  });
  it('admits a typed Resource metric and rejects invalid input or mismatched field paths', () => {
    expect(PluginDeclarativeDocumentV1Schema.safeParse(metricDocument).success).toBe(true);
    for (const root of [
      { ...metricDocument.root, value: { path: ['missing'], type: 'number' } },
      { ...metricDocument.root, value: { path: ['count'], type: 'string' } },
      { ...metricDocument.root, data: { ...metricDocument.root.data, input: { sessionId: 42 } } },
      { ...metricDocument.root, data: { ...metricDocument.root.data, url: 'https://example.com' } },
    ]) expect(PluginDeclarativeDocumentV1Schema.safeParse({ version: 1, root }).success).toBe(false);
    expect(SessionSurfaceDeclarativeDocumentV1Schema.safeParse(metricDocument).success).toBe(false);
  });

  it('admits literal data for shared inert metric content', () => {
    expect(SessionSurfaceDeclarativeDocumentV1Schema.safeParse({ version: 1, root: {
      kind: 'metric', label: 'Checks', data: { kind: 'value', value: 7 }, value: { path: [], type: 'number' },
    } }).success).toBe(true);
  });
  it('freezes only the displayed projection, rejects changed output and never copies credentials', () => {
    const document = PluginDeclarativeDocumentV1Schema.parse(metricDocument);
    if (document.root.kind !== 'metric') throw new Error('Expected metric');
    const frozen = freezePluginDeclarativeDataNodeV1(document.root, { count: 7, privateToken: 'secret' });
    expect(frozen).toEqual({ kind: 'metric', label: 'Checks', data: { kind: 'value', value: 7 }, value: { path: [], type: 'number' } });
    expect(() => freezePluginDeclarativeDataNodeV1(document.root, { count: 'seven', privateToken: 'secret' })).toThrow();
  });

  it('admits one-series chart and typed rows and copies only their displayed scalar fields', () => {
    const data = { ...metricDocument.root.data, outputSchema: { type: 'object', properties: {
      samples: { type: 'array', items: { type: 'object', properties: { day: { type: 'string' }, count: { type: 'number' },
        credential: { type: 'string' } }, required: ['day', 'count'], additionalProperties: false } },
    }, required: ['samples'], additionalProperties: false } };
    const output = { samples: [{ day: 'Mon', count: 3, credential: 'private' }] };
    for (const kind of ['table', 'rows'] as const) {
      const document = PluginDeclarativeDocumentV1Schema.parse({ version: 1, root: { kind, data, rows: ['samples'],
        columns: [{ label: 'Day', field: { path: ['day'], type: 'string' } }, { label: 'Checks', field: { path: ['count'], type: 'number' } }] } });
      if (document.root.kind !== kind) throw new Error('Expected row data');
      expect(freezePluginDeclarativeDataNodeV1(document.root, output).data).toEqual({ kind: 'value', value: [{ c0: 'Mon', c1: 3 }] });
    }
    const chart = { kind: 'chart', label: 'Checks', style: 'bar', data, rows: ['samples'],
      x: { path: ['day'], type: 'string' }, y: { path: ['count'], type: 'number' } };
    const document = PluginDeclarativeDocumentV1Schema.parse({ version: 1, root: chart });
    if (document.root.kind !== 'chart') throw new Error('Expected chart');
    expect(freezePluginDeclarativeDataNodeV1(document.root, output).data).toEqual({ kind: 'value', value: [{ x: 'Mon', y: 3 }] });
    expect(PluginDeclarativeDocumentV1Schema.safeParse({ version: 1, root: { ...chart, y: { path: ['day'], type: 'string' } } }).success).toBe(false);
    expect(PluginDeclarativeDocumentV1Schema.safeParse({ version: 1, root: { ...chart, rows: ['missing'] } }).success).toBe(false);
  });
});
