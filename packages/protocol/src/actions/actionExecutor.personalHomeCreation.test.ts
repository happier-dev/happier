import { describe, expect, it } from 'vitest';

import type { ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { listActionSpecsForCatalogSurface } from './actionCatalog.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { PERSONAL_HOME_CREATE_ACTION_ID_V1 } from './specs/machineConnectionActionIdsV1.js';

describe('creating a personal Home', () => {
  it.each([
    { input: { method: 'this_computer' }, result: { status: 'setup_started' } },
    { input: { method: 'ssh', host: 'home-box', username: 'owner', port: 2222 },
      result: { status: 'created', address: 'https://home.example.test' } },
  ] as const)('requires approval for $input.method before invoking the answering client', async ({ input, result }) => {
    const actionId = PERSONAL_HOME_CREATE_ACTION_ID_V1;
    expect(listActionSpecsForCatalogSurface({ surface: 'agent' }).map(action => action.id)).toContain(actionId);
    const retained: ApprovalRequest[] = [];
    // The artifact store and answering app are the executor's external boundaries.
    const deliveries: unknown[] = [];
    const deps = {
      approvalsCreate: async ({ request }: { request: ApprovalRequest }) => {
        retained.push(request);
        return { artifactId: 'personal-home-approval' };
      },
      approvalsUpdate: async ({ request }: { request: ApprovalRequest }) => {
        retained.push(request);
        return { ok: true as const };
      },
      approvalsGet: async () => retained.at(-1) ?? null,
      isApprovalExecutionOriginCurrent: async () => true,
      personalHomeCreate: async (body: unknown) => { deliveries.push(body); return result; },
    } as ActionExecutorDeps;
    const executor = createActionExecutor(deps);
    const context = { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
      serverId: 'profile', serverIdentityId: 'stable-profile', runtimeAccountId: 'account', actionRequestId: 'personal-home-attempt' } as const;
    await expect(executor.execute(actionId, { ...input, password: 'not-an-action-input' }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    await expect(executor.execute(actionId, input, context)).resolves.toMatchObject({
      ok: true, result: { kind: 'approval_request_created', artifactId: 'personal-home-approval' },
    });
    expect(retained.at(-1)).toMatchObject({ status: 'open', actionArgs: input });
    expect(deliveries).toEqual([]);

    await expect(executor.execute('approval.request.decide', {
      artifactId: 'personal-home-approval', decision: 'approve',
    }, { ...context, surface: 'ui', authority: 'present_user' })).resolves.toMatchObject({
      ok: true, result: { status: 'executed', execution: { ok: true, result } },
    });
    expect(deliveries).toEqual([input]);
  });
});
