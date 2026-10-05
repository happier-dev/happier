import { describe, expect, it } from 'vitest';
import { SessionSurfaceItemV1Schema } from '../sessions/board/item.js';
import { WidgetSnapshotPostInputV1Schema, buildWidgetSnapshotBoardUpsertV1, projectWidgetSnapshotPreviewV1 } from './widgetSnapshotV1.js';
import { freezePluginDeclarativeDataNodeV1 } from '../plugins/contributions/ui/declarativeDataV1.js';
import { PluginDeclarativeDocumentV1Schema } from '../plugins/contributions/ui/declarativeDocumentAuthoringV1.js';
import { executeWidgetSnapshotPostV1 } from './executeWidgetSnapshotPostV1.js';
import { MAX_PLUGIN_DECLARATIVE_DOCUMENT_NODES_V1 } from '../plugins/contributions/ui/declarativeDocumentPreflightV1.js';

describe('frozen widget Board content', () => {
  const preview = { v: 1 as const, document: { version: 1 as const, root: { kind: 'metric' as const, label: 'Checks',
    data: { kind: 'value' as const, value: 7 }, value: { path: [], type: 'number' as const } } },
    asOf: '2026-10-05T01:00:00.000Z', provenance: [{ label: 'Checks summary' }] };
  const input = { surface: { serverId: 'home-a', accountId: 'viewer-a', owner: { kind: 'sessionBoard' as const, sessionId: 'session-a' } },
    itemId: 'snapshot-1', title: 'Checks', preview, placement: {} };

  it('publishes exactly the admitted preview and rejects hidden live or executable state', () => {
    const upsert = buildWidgetSnapshotBoardUpsertV1(input);
    expect(upsert.item.source).toEqual({ kind: 'declarative', document: preview.document });
    expect(upsert.item.snapshot).toEqual({ asOf: preview.asOf, provenance: preview.provenance });
    for (const root of [
      { ...preview.document.root, data: { kind: 'value', value: { number: 7, credential: 'hidden' } }, value: { path: ['number'], type: 'number' } },
      { kind: 'stack', children: [{ kind: 'action', hostAction: 'session.message.send', label: 'Publish' }] },
      { kind: 'markdown', text: '![remote](https://example.com/image.png)' },
    ]) expect(WidgetSnapshotPostInputV1Schema.safeParse({ ...input, preview: { ...preview, document: { version: 1, root } } }).success).toBe(false);
  });

  it('never publishes after cancellation or Account retirement', async () => {
    let writes = 0;
    const deps = { widgetAccountScope: () => ({ serverId: 'home-a', accountId: 'viewer-b' }),
      sessionBoardAction: async () => { writes += 1; return { ok: false as const, errorCode: 'session_board_edit_denied' as const, error: 'Denied' }; } };
    expect(await executeWidgetSnapshotPostV1(deps, input, { serverId: 'home-a' })).toMatchObject({ ok: false, errorCode: 'account_target_mismatch' });
    const controller = new AbortController(); controller.abort();
    expect(await executeWidgetSnapshotPostV1({ ...deps, widgetAccountScope: () => ({ serverId: 'home-a', accountId: 'viewer-a' }) }, input,
      { serverId: 'home-a', signal: controller.signal })).toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(writes).toBe(0);
  });
  it('admits a preview only within the incumbent Session document resource boundary', () => {
    expect(WidgetSnapshotPostInputV1Schema.safeParse({ ...input, preview: { ...preview, document: { version: 1,
      root: { kind: 'stack', children: Array.from({ length: MAX_PLUGIN_DECLARATIVE_DOCUMENT_NODES_V1 }, () => ({ kind: 'text', text: 'Checks' })) },
    } } }).success).toBe(false);
  });
  it('admits frozen exact values with timestamp and inert provenance on an ordinary declarative item', () => {
    const item = { v: 1, title: 'Checks', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
      source: { kind: 'declarative', document: { version: 1, root: { kind: 'metric', label: 'Checks',
        data: { kind: 'value', value: 7 }, value: { path: [], type: 'number' } } } },
      snapshot: { asOf: '2026-10-05T01:00:00.000Z', provenance: [{ label: 'Checks summary', digest: 'version-1' }] } };
    expect(SessionSurfaceItemV1Schema.safeParse(item).success).toBe(true);
    expect(SessionSurfaceItemV1Schema.safeParse({ ...item, source: { kind: 'declarative', document: {
      version: 1, root: { kind: 'action', hostAction: 'session.message.send', label: 'Send', input: { text: 'bad' } },
    } } }).success).toBe(false);
  });
  it('projects the previewed frozen nodes by path, drops executable nodes and refuses a partly current preview', () => {
    const live = { kind: 'resource' as const, resource: { pluginId: 'acme.analytics', localId: 'signups' },
      inputSchema: { type: 'object' as const, additionalProperties: false }, outputSchema: { type: 'object' as const, properties: {
        total: { type: 'number' as const }, days: { type: 'array' as const, items: { type: 'object' as const, properties: { d: { type: 'string' as const }, n: { type: 'number' as const } } } } } } };
    const document = PluginDeclarativeDocumentV1Schema.parse({ version: 1, root: { kind: 'stack', children: [
      { kind: 'metric', label: 'Signups', data: live, value: { path: ['total'], type: 'number' } },
      { kind: 'chart', label: 'Per day', style: 'bar', data: live, rows: ['days'], x: { path: ['d'], type: 'string' }, y: { path: ['n'], type: 'number' } },
      { kind: 'item', title: 'Open', action: 'open' },
      { kind: 'markdown', text: '![remote](https://example.com/a.png)' },
    ] } });
    const output = { total: 1284, secret: 'never', days: [{ d: 'Tue', n: 236 }, { d: 'Wed', n: 183 }] };
    const root = document.root as unknown as { children: Parameters<typeof freezePluginDeclarativeDataNodeV1>[0][] };
    const frozenByPath = new Map([
      ['root.children[0]', freezePluginDeclarativeDataNodeV1(root.children[0]!, output)],
      ['root.children[1]', freezePluginDeclarativeDataNodeV1(root.children[1]!, output)],
    ]);
    const projected = projectWidgetSnapshotPreviewV1({ document, frozenByPath, asOf: '2026-10-05T10:42:00.000Z', provenance: [{ label: 'analytics replica' }] })!;
    expect(projected).not.toBeNull();
    const children = (projected.document.root as unknown as { children: Readonly<Record<string, unknown>>[] }).children;
    expect(children.map((child) => child.kind)).toEqual(['metric', 'chart', 'item']);
    expect(children[2]).toEqual({ kind: 'item', title: 'Open' });
    expect(JSON.stringify(projected)).not.toContain('never');
    expect(JSON.stringify(projected)).not.toContain('acme.analytics');
    expect(WidgetSnapshotPostInputV1Schema.safeParse({ ...input, preview: projected }).success).toBe(true);
    expect(projectWidgetSnapshotPreviewV1({ document, frozenByPath: new Map([...frozenByPath].slice(0, 1)), asOf: projected.asOf, provenance: [] })).toBeNull();
  });
});
