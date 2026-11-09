import { describe, expect, it } from 'vitest';
import { SessionSurfaceItemV1Schema, SessionSurfaceItemV1StoredSchema } from '../sessions/board/item.js';
import { WidgetSnapshotPostInputV1Schema, buildWidgetSnapshotBoardUpsertV1, projectWidgetSnapshotPreviewV1 } from './widgetSnapshotV1.js';
import { freezePluginDeclarativeDataNodeV1 } from '../plugins/contributions/ui/declarativeDataV1.js';
import { PluginDeclarativeDocumentV1Schema } from '../plugins/contributions/ui/declarativeDocumentAuthoringV1.js';
import { executeWidgetSnapshotPostV1 } from './executeWidgetSnapshotPostV1.js';
import { MAX_PLUGIN_DECLARATIVE_DOCUMENT_NODES_V1 } from '../plugins/contributions/ui/declarativeDocumentPreflightV1.js';
import { createActionExecutor } from '../actions/actionExecutor.js';
import { ActionsSettingsV1Schema } from '../actions/actionSettings.js';
import { isApprovalRequiredByActionsSettings } from '../actions/actionApprovalPolicy.js';
import type { ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { SessionBoardItemUpsertInputV1Schema, projectSessionBoardActionFailureV1, type SessionBoardItemUpsertInputV1 } from '../sessions/board/actions.js';

describe('frozen widget Board content', () => {
  const preview = { v: 1 as const, document: { version: 1 as const, root: { kind: 'metric' as const, label: 'Checks',
    data: { kind: 'value' as const, value: 7 }, value: { path: [], type: 'number' as const } } },
    asOf: '2026-10-05T01:00:00.000Z', provenance: [{ label: 'Checks summary' }] };
  const input = { surface: { serverId: 'home-a', accountId: 'viewer-a', owner: { kind: 'sessionBoard' as const, sessionId: 'session-a' } },
    itemId: 'snapshot-1', title: 'Checks', preview, placement: {} };

  it('admits Voice snapshot publication only after Ask first and posts the exact frozen payload', async () => {
    const published: SessionBoardItemUpsertInputV1[] = [];
    const approvals: ApprovalRequest[] = [];
    const executor = createActionExecutor({
      widgetAccountScope: () => ({ serverId: 'home-a', accountId: 'viewer-a' }),
      isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, context.actionsSettings ?? ActionsSettingsV1Schema.parse({ v: 1 }), context),
      approvalsCreate: async ({ request }) => { approvals.push(request); return { artifactId: 'snapshot-approval' }; },
      // Human approval delivery and persistence are host system boundaries.
      approvalsWaitForDecision: async ({ request }) => {
        expect(published).toEqual([]);
        return { decision: 'reject', request };
      },
      approvalsUpdate: async () => ({ ok: true }),
      // The host's sealed Session Board HTTP port is the system boundary.
      sessionBoardAction: async ({ input: boardInput }) => {
        const upsert = SessionBoardItemUpsertInputV1Schema.parse(boardInput);
        published.push(upsert);
        return { v: 1, serverId: 'home-a', sessionId: 'session-a', result: { operation: 'upsert_item', itemId: upsert.itemId,
          outcome: 'created', itemRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ', layoutRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ' },
          destination: { tabId: 'main', width: 'full' }, preview: { title: upsert.item.title, sourceKind: 'declarative' } };
      },
    });
    const context = { surface: 'voice' as const, serverId: 'home-a', actionCaller: { kind: 'host' as const }, actionRequestId: 'snapshot-post' };
    const approval = await executor.execute('widgets.snapshot.post', input, context);
    expect(approval).toMatchObject({ ok: false, errorCode: 'approval_rejected' });
    expect(approvals).toMatchObject([{ actionId: 'widgets.snapshot.post', actionArgs: input, status: 'open' }]);
    expect(published).toEqual([]);
    expect(await executor.execute('widgets.snapshot.post', input, { ...context,
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: { 'widgets.snapshot.post': { enabled: false } } }),
    })).toMatchObject({ ok: false, errorCode: 'action_disabled' });
    expect(published).toEqual([]);
    expect(await executor.execute('widgets.snapshot.post', input, { ...context,
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'widgets.snapshot.post': ['voice'] } }),
    })).toMatchObject({ ok: true, result: { result: { outcome: 'created' } } });
    expect(published).toEqual([buildWidgetSnapshotBoardUpsertV1(input)]);
  });

  it('admits a snapshot once and publishes exactly one frozen Board item', async () => {
    let scopeReads = 0;
    const published: SessionBoardItemUpsertInputV1[] = [];
    const executor = createActionExecutor({
      // The host Account-scope adapter is the admission boundary.
      widgetAccountScope: () => { scopeReads += 1; return { serverId: 'home-a', accountId: 'viewer-a' }; },
      // The sealed Board HTTP boundary retains destination write authorization.
      sessionBoardAction: async ({ input: boardInput }) => {
        const upsert = SessionBoardItemUpsertInputV1Schema.parse(boardInput);
        published.push(upsert);
        return { v: 1, serverId: 'home-a', sessionId: 'session-a', result: { operation: 'upsert_item', itemId: upsert.itemId,
          outcome: 'created', itemRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ', layoutRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ' },
          destination: { tabId: 'main', width: 'full' } };
      },
    });
    expect(await executor.execute('widgets.snapshot.post', input, { surface: 'ui', authority: 'present_user',
      serverId: 'home-a', bypassApprovals: true })).toMatchObject({ ok: true, result: { result: { outcome: 'created' } } });
    expect(published).toEqual([buildWidgetSnapshotBoardUpsertV1(input)]);
    expect(scopeReads).toBe(1);
  });

  it('publishes exactly the admitted preview and rejects hidden live or executable state', () => {
    const upsert = buildWidgetSnapshotBoardUpsertV1(input);
    expect(upsert.item.source).toEqual({ kind: 'declarative', document: preview.document });
    expect(upsert.item.snapshot).toEqual({ asOf: preview.asOf, provenance: preview.provenance, postedByAccountId: 'viewer-a' });
    expect(SessionSurfaceItemV1StoredSchema.parse({ ...upsert.item, snapshot: { ...upsert.item.snapshot, future: true } }).snapshot)
      .toEqual(upsert.item.snapshot);
    // The posting Account is admitted host scope, never part of the caller's preview.
    expect(WidgetSnapshotPostInputV1Schema.safeParse({ ...input, preview: { ...preview, postedByAccountId: 'other' } }).success).toBe(false);
    for (const root of [
      { ...preview.document.root, data: { kind: 'value', value: { number: 7, credential: 'hidden' } }, value: { path: ['number'], type: 'number' } },
      { kind: 'stack', children: [{ kind: 'action', hostAction: 'session.message.send', label: 'Publish' }] },
      { kind: 'markdown', text: '![remote](https://example.com/image.png)' },
    ]) expect(WidgetSnapshotPostInputV1Schema.safeParse({ ...input, preview: { ...preview, document: { version: 1, root } } }).success).toBe(false);
  });

  it('rejects a foreign Account before the Board port and preserves Board write denial and local cancellation', async () => {
    let writes = 0;
    const deps = { widgetAccountScope: () => ({ serverId: 'home-a', accountId: 'viewer-b' }),
      sessionBoardAction: async () => { writes += 1; return projectSessionBoardActionFailureV1({ error: 'session_board_forbidden' }); } };
    const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: 'home-a', bypassApprovals: true };
    expect(await createActionExecutor(deps).execute('widgets.snapshot.post', input, context))
      .toMatchObject({ ok: false, errorCode: 'account_target_mismatch' });
    const controller = new AbortController(); controller.abort();
    expect(await executeWidgetSnapshotPostV1({ ...deps, widgetAccountScope: () => ({ serverId: 'home-a', accountId: 'viewer-a' }) }, input,
      { serverId: 'home-a', signal: controller.signal })).toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(writes).toBe(0);
    expect(await createActionExecutor({ ...deps, widgetAccountScope: () => ({ serverId: 'home-a', accountId: 'viewer-a' }) })
      .execute('widgets.snapshot.post', input, context)).toMatchObject({ ok: false, errorCode: 'session_board_forbidden' });
    expect(writes).toBe(1);
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
  it('freezes the rendered normalized document without publishing renderer metadata or executable nodes', () => {
    const preview = projectWidgetSnapshotPreviewV1({
      document: { version: 1, root: { kind: 'stack', path: 'root', order: 0, children: [
        { kind: 'metric', path: 'root.children[0]', order: 1, label: 'Files',
          data: { kind: 'value', value: { count: 17, private: 'excluded' } }, value: { path: ['count'], type: 'number' } },
        { kind: 'action', path: 'root.children[1]', order: 2, action: { qualifiedId: 'acme/run' }, label: 'Run' },
      ] } },
      frozenByPath: new Map(), asOf: '2026-10-18T10:00:00.000Z', provenance: [],
    });
    expect(preview).not.toBeNull();
    expect(preview?.document.root).toEqual({ kind: 'stack', children: [
      { kind: 'metric', label: 'Files', data: { kind: 'value', value: 17 }, value: { path: [], type: 'number' } },
    ] });
    expect(JSON.stringify(preview)).not.toContain('excluded');
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
