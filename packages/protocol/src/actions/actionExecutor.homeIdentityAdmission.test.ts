import { describe, expect, it } from 'vitest';
import { createActionExecutor } from './actionExecutor.js';
import { markSessionListQueryResultV1 } from '../sessions/awareness/action.js';
import { SessionSummarySchema } from '../sessions/control/listResult.js';
import { createUsageSourceActionPort } from './executor/usageSourceActions.js';

const context = { surface: 'ui' as const, authority: 'present_user' as const,
  serverId: 'local-profile', serverIdentityId: 'canonical-home' };

describe('Home identity admission through Action transports', () => {
  it('copies a visual from the canonical Home and refuses foreign source or returned Homes', async () => {
    const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
    const item = { v: 1, title: 'Result', frame: 'frameless', height: { mode: 'auto', fallback: 'regular' },
      source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'Result' } } } };
    let returnedHome = 'canonical-home';
    const approvals: unknown[] = [];
    const executor = createActionExecutor({ sessionBoardAction: async () => ({ v: 1, serverId: returnedHome,
      sessionId: 'source', capabilities: { readTranscript: true, editSessionRecords: true }, layout: null,
      items: [{ itemId: 'visual', item, revision, title: item.title, sourceKind: item.source.kind }],
      incomplete: false, page: { cursor: null, hasNext: false } }),
      approvalsCreate: async ({ request }) => { approvals.push(request); return { artifactId: 'approval' }; },
    });
    const input = { itemId: 'visual', destination: 'transcript', expectedItemRevision: null,
      copySource: { serverId: 'canonical-home', sessionId: 'source', itemId: 'visual', expectedItemRevision: revision } };
    const caller = { ...context, defaultSessionId: 'session', defaultSessionMachineId: 'machine',
      runtimeAccountId: 'account', actionRequestId: 'copy', actionCaller: { kind: 'host' as const } };
    expect(await executor.execute('session.board.item.upsert', input, caller))
      .toEqual({ ok: true, result: { kind: 'approval_request_created', artifactId: 'approval', actionId: 'session.board.item.upsert' } });
    expect(approvals).toHaveLength(1);
    expect(await executor.execute('session.board.item.upsert', { ...input,
      copySource: { ...input.copySource, serverId: 'foreign-home' } }, caller))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    returnedHome = 'foreign-home';
    expect(await executor.execute('session.board.item.upsert', input, caller))
      .toMatchObject({ ok: false, errorCode: 'session_board_invalid' });
    expect(approvals).toHaveLength(1);
  });

  it('archives canonical same-Home reports without following a foreign report', async () => {
    const archived: string[] = [];
    const executor = createActionExecutor({ sessionArchiveSet: async ({ sessionId }) => {
      archived.push(sessionId); return { ok: true, sessionId, archivedAt: 7 };
    }, sessionList: async () => markSessionListQueryResultV1({ nextCursor: null, hasNext: false,
      attentionNextCursor: null, attentionHasNext: false,
      sessions: ['canonical-home', 'foreign-home'].map((serverId, i) => SessionSummarySchema.parse({
        id: i ? 'foreign-report' : 'report', serverId, manager: { sessionId: 'lead' }, active: false,
        activeAt: 1, createdAt: 1, updatedAt: 1, encryption: null,
      })) }) });
    expect(await executor.execute('session.archive', { sessionId: 'lead', alsoArchiveReports: true }, context))
      .toMatchObject({ ok: true, result: { reports: [{ sessionId: 'report', status: 'archived' }] } });
    expect(archived).toEqual(['lead', 'report']);
  });

  it('checks a picked canonical Session without dropping it at the local profile boundary', async () => {
    const reads: string[] = [];
    const executor = createActionExecutor({ sessionStatusGet: async ({ sessionId }) => {
      reads.push(sessionId);
      return { ok: true, session: { id: sessionId, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        encryptionMode: 'plain', encryption: null }, awareness: { v: 1, sessionId, title: 'Selected Session',
        lifecycle: 'active', runtime: 'idle', freshness: 'live', operational: { primary: 'none', reasons: [] },
        encryption: 'plain', availability: 'complete' } };
    } });
    const address = { serverId: 'canonical-home', sessionId: 'session' };
    const input = { actionId: 'review.apply', fieldPath: 'sessionId', values: [address] };
    expect(await executor.execute('action.options.resolve', input, context))
      .toMatchObject({ ok: true, result: { options: [{ value: address, label: 'Selected Session' }] } });
    expect(await executor.execute('action.options.resolve', { ...input, values: [{ ...address, serverId: 'foreign-home' }] }, context))
      .toMatchObject({ ok: true, result: { options: [] } });
    expect(reads).toEqual(['session']);
  });

  it('offers canonical Machine addresses for a local-profile invocation and refuses foreign inventory', async () => {
    let inventoryHome = 'canonical-home';
    const executor = createActionExecutor({ machinesList: async () => ({ items: [{ serverId: inventoryHome,
      machineId: 'machine', label: 'Machine', active: true }] }),
      widgetAccountScope: () => ({ serverId: 'canonical-home', accountId: 'viewer' }) });
    const input = { consumer: { kind: 'widget', surface: { serverId: 'canonical-home', accountId: 'viewer',
      owner: { kind: 'home' } }, definition: { kind: 'builtin', id: 'machine_vitals' } }, fieldPath: 'machine' };
    expect(await executor.execute('action.options.resolve', input, context))
      .toMatchObject({ ok: true, result: { options: [{ value: { serverId: 'canonical-home', machineId: 'machine' } }] } });
    inventoryHome = 'foreign-home';
    expect(await executor.execute('action.options.resolve', input, context))
      .toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
  });

  it('reads Usage sources through the canonical Home while refusing foreign Homes', async () => {
    const reads: string[] = [];
    const executor = createActionExecutor({ usageSourceAction: createUsageSourceActionPort({
      serverId: 'canonical-home', assertCurrent() {},
      // Machine RPC is the boundary; admission and Usage response projection stay real.
      rpc: async request => { reads.push(request.input.serverId); return { sources: [] }; },
    }) });
    expect(await executor.execute('usage.sources.discover', { serverId: 'canonical-home', machineId: 'machine' }, context))
      .toEqual({ ok: true, result: { sources: [] } });
    expect(await executor.execute('usage.sources.discover', { serverId: 'foreign-home', machineId: 'machine' }, context))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(reads).toEqual(['canonical-home']);
    const port = createUsageSourceActionPort({ serverId: 'canonical-home', assertCurrent() {},
      rpc: async () => ({ sources: [] }) });
    expect(await port({ actionId: 'usage.sources.discover', input: { serverId: 'foreign-home', machineId: 'machine' } }, context))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(await executor.execute('usage.sources.discover', { serverId: 'canonical-home', machineId: 'machine' },
      { ...context, serverId: 'foreign-home', serverIdentityId: 'foreign-home' }))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
  });

  it('lists workflow events through the canonical Home while refusing foreign Homes', async () => {
    const reads: string[] = [];
    const executor = createActionExecutor({ workflowEventsList: async input => {
      // The Machine Event catalog RPC is the boundary.
      reads.push(input.serverId!);
      return { machineId: input.machineId, events: [] };
    } });
    expect(await executor.execute('workflow.events.list', { serverId: 'canonical-home', machineId: 'machine' }, context))
      .toEqual({ ok: true, result: { machineId: 'machine', events: [] } });
    expect(await executor.execute('workflow.events.list', { serverId: 'foreign-home', machineId: 'machine' }, context))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(reads).toEqual(['canonical-home']);
  });
});
