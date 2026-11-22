import { describe, expect, it } from 'vitest';
import { TEAM_SETUP_RUN_ACTION_ID_V1, TEAM_SETUP_RUN_CHILD_ACTION_IDS_V1 as CHILD } from '../teams/actionIdsV1.js';
import { TeamSetupBatchInputV1Schema, teamSetupRepositoryRequestIdV1 } from '../teams/setupBatchV1.js';
import { createActionExecutor } from './actionExecutor.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { bindPresentUserActionConfirmationV1 } from './executor/approvalReview.js';

describe('requester Team Setup batch', () => {
  const target = { serverId: 'home', homeId: 'home', machineId: 'machine' };
  const repositories = ['one', 'two'].map(id => ({ id,
    input: { serverId: target.serverId, machineId: target.machineId,
      source: { kind: 'folder' as const, path: `/${id}` }, materialization: { kind: 'attach' as const } },
  }));
  const input = TeamSetupBatchInputV1Schema.parse({ ...target, repositories, machine: {
    homeId: target.homeId, machineId: target.machineId,
    targets: [{ homeId: target.homeId, machineId: target.machineId,
      sources: [{ kind: 'direct', setup: {} }], desiredRevision: 1, recipePlans: [] }],
  } });
  const actionId = TEAM_SETUP_RUN_ACTION_ID_V1;
  const requestId = 'reviewed-request';
  const context = { serverId: target.serverId, surface: 'ui', authority: 'present_user', runtimeAccountId: 'requester',
    expectedAccountId: 'requester', actionRequestId: requestId, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }) } as const;

  it.each(['succeeded', 'failed'] as const)('waits once for the %s Machine prerequisite before opening checkouts', async state => {
    const effects: string[] = [];
    const observedRequestIds: (string | null | undefined)[] = [];
    const operationId = 'machine-setup';
    const executor = createActionExecutor({
      machineSetupApply: async () => { effects.push('apply'); return { operationId }; },
      actionOperationAction: async ({ actionId, input }) => {
        effects.push('wait');
        expect(actionId).toBe(CHILD.operation);
        expect(input).toMatchObject({ operationId, waitForTerminal: true });
        return { kind: 'found', operation: { version: 1, operationId, revision: 1, actionId: CHILD.machine, state,
          scope: { accountId: 'requester', machineId: target.machineId }, title: 'Machine setup',
          createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'unsupported',
          ...(state === 'failed' ? { error: { errorCode: 'machine_offline', error: 'machine_offline' } } : {}),
        } };
      },
      projectsOpen: async (project, child) => {
        if (project.source.kind !== 'folder') throw new Error('Expected the reviewed folder selection');
        const path = project.source.path;
        effects.push(path);
        observedRequestIds.push(child.actionRequestId);
        return { kind: 'opened', setup: 'notRequired', directory: path,
          workspace: { serverId: target.serverId, machineId: target.machineId, workspaceId: path.slice(1), rootPath: path } };
      },
    });
    const result = await executor.execute(actionId, input, bindPresentUserActionConfirmationV1(actionId, input, context));
    const diagnostic = JSON.stringify({ result, effects });
    if (state === 'failed') {
      expect(result, diagnostic).toMatchObject({ ok: true, result: { completed: false,
        machineSettlement: { errorCode: 'machine_offline' }, repositories: [] } });
      expect(effects).toEqual(['apply', 'wait']);
    } else {
      expect(result, diagnostic).toMatchObject({ ok: true, result: { completed: true, machineSettlement: null,
        repositories: [{ id: 'one' }, { id: 'two' }] } });
      expect(effects).toEqual(['apply', 'wait', '/one', '/two']);
      expect(observedRequestIds).toEqual(repositories.map((_, index) => teamSetupRepositoryRequestIdV1(requestId, index)));
    }
  });
});
