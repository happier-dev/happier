import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { SessionWorkspaceReturnPreviewV1Schema } from './specs/session/projectFilesReturn.js';
import { doesExternalActionConsumeRequesterAccountContentV1, getActionSpec } from './actionSpecs.js';
import { SESSION_WORKSPACE_RETURN_ACTION_IDS_V1, SESSION_WORKSPACE_RETURN_APPLY_ACTION_ID_V1 } from './sessionWorkspaceReturnActionIdsV1.js';
import type { ActionId } from './actionIds.js';

describe('reviewed Project files return', () => {
  it('captures the admitted native Session as a private ordinary Machine source without accepting paths', async () => {
    const actionId = 'session.workspace.return.capture' as ActionId;
    const spec = getActionSpec(actionId);
    expect(spec.inputSchema.safeParse({ sessionId: 'sandbox', machineId: 'controller', stageRoot: '/other-person' }).success).toBe(false);
    const captured = { workspace: { serverId: 'home', machineId: 'controller', workspaceId: 'private-stage', rootPath: '/requester/stage' }, baseline: { entries: [] }, excludedPaths: ['local.env'] };
    expect(spec.outputSchema.parse(captured)).toEqual(captured);
    const executor = createActionExecutor({ sessionWorkspaceReturn: async () => captured } as ActionExecutorDeps);
    await expect(executor.execute(actionId, { sessionId: 'sandbox', machineId: 'controller' }, {
      surface: 'cli', authority: 'present_user', bypassApprovals: true,
    })).resolves.toEqual({ ok: true, result: captured });
  });
  it.each(SESSION_WORKSPACE_RETURN_ACTION_IDS_V1)('places %s at the original host Machine', actionId => {
    expect(getActionSpec(actionId).machineRuntimeDemandForInput?.({ sessionId: 'running-sandbox', machineId: 'host' },
      { serverId: 'home', defaultSessionId: 'running-sandbox' }))
      .toEqual({ target: { kind: 'machine', machineId: 'host' }, serverId: 'home' });
  });
  it('requests Account custody for a fresh reviewed Apply without accepting a caller-selected destination', () => {
    const actionId = SESSION_WORKSPACE_RETURN_APPLY_ACTION_ID_V1;
    const target = { kind: 'machine' as const, machineId: 'controller' };
    const input = { sessionId: 'sandbox', machineId: target.machineId, returnId: 'review', paths: ['file.txt'] };
    expect(doesExternalActionConsumeRequesterAccountContentV1({ actionId, target, input })).toBe(true);
    expect(doesExternalActionConsumeRequesterAccountContentV1({ actionId, target,
      input: { ...input, destination: '/controller' } })).toBe(false);
  });
  it('returns complete review evidence and preserves changed-host refusal without writing', async () => {
    const review = SessionWorkspaceReturnPreviewV1Schema.parse({ returnId: 'return-1', sessionId: 'session-1', repositoryRootPath: '/repo', paths: [{
      path: 'src', conflicts: [{ path: 'src/file.ts', code: 'both_changed' }], files: [{
        path: 'src/file.ts', changeKind: 'modified', binary: false, generated: false, lockfile: false,
        evidence: { state: 'available', unifiedDiff: '--- host\n+++ sandbox\n@@ -1 +1 @@\n-host\n+sandbox\n' }, occurrences: [],
      }],
    }] });
    let hostChangedAfterReview = false;
    const executor = createActionExecutor({
      // Network/effect boundary; real Action parsing and admission stay active.
      sessionWorkspaceReturn: async ({ actionId, input }) => actionId.endsWith('.prepare')
        ? { ...review, sessionId: input.sessionId }
        : hostChangedAfterReview ? { ok: false, errorCode: 'conflict_changed', error: 'host changed' }
          : 'replaceConflictPaths' in input && input.replaceConflictPaths?.length
            ? { appliedPaths: input.replaceConflictPaths, conflicts: [] }
            : { appliedPaths: ['src/unrelated.ts'], conflicts: [{ path: 'src/file.ts', code: 'both_changed' }] },
    } as ActionExecutorDeps);
    const context = { surface: 'ui' as const, authority: 'present_user' as const,
      bypassApprovals: true, workspaceWrites: 'allow' as const };
    await expect(executor.execute('session.workspace.return.prepare', { sessionId: 'session-1', machineId: 'host' }, context))
      .resolves.toEqual({ ok: true, result: review });
    await expect(executor.execute('session.workspace.return.apply', {
      sessionId: 'session-1', machineId: 'host', returnId: 'return-1', paths: ['src'],
    }, context)).resolves.toEqual({ ok: true, result: { appliedPaths: ['src/unrelated.ts'], conflicts: [{ path: 'src/file.ts', code: 'both_changed' }] } });
    await expect(executor.execute('session.workspace.return.apply', {
      sessionId: 'session-1', machineId: 'host', returnId: 'return-1', paths: ['src/file.ts'],
      replaceConflictPaths: ['src/file.ts'],
    }, context)).resolves.toEqual({ ok: true, result: { appliedPaths: ['src/file.ts'], conflicts: [] } });
    hostChangedAfterReview = true;
    await expect(executor.execute('session.workspace.return.apply', {
      sessionId: 'session-1', machineId: 'host', returnId: 'return-1', paths: ['src'],
    }, context)).resolves.toMatchObject({ ok: false, errorCode: 'conflict_changed' });
  });
});
