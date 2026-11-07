import { describe, expect, it } from 'vitest';
import { createActionExecutor } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { readActionSecretInputAdmission } from './actionInputHintsRuntime.js';
import type { ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { MANAGED_IDENTITY_PROVIDER_ACTION_IDS_V1 } from '../identity/providers.js';
import { TEAM_IDENTITY_ACTION_IDS_V1, HOME_IDENTITY_ACTION_IDS_V1 } from '../teams/identity/actionIds.js';
import { TEAM_DIRECTORY_ACTION_IDS_V1 } from '../teams/directory/actionIds.js';

const context = { surface: 'agent', authority: 'account_automation', serverId: 'home',
  serverIdentityId: 'stable-home', defaultSessionId: 'session', defaultSessionMachineId: 'machine',
  runtimeAccountId: 'account', actionRequestId: 'request', actionCaller: { kind: 'host' } } as const;

describe('declared built-in confidential Action inputs', () => {
  it.each([
    { actionId: 'secrets.create', input: { name: 'Deployment token', kind: 'token' }, path: 'value' },
    { actionId: 'identity.providers.secret.replace', input: { owner: { kind: 'home' }, id: 'company', expectedRevision: 1 }, path: 'clientSecret' },
    { actionId: 'home.settings.set', input: { expectedRevision: 1, values: {}, secrets: { WORKOS_API_KEY: {} } }, path: 'secrets.WORKOS_API_KEY.replace' },
  ] as const)('asks privately for $actionId without admitting malformed public operands', async ({ actionId, input, path }) => {
    const requests: ApprovalRequest[] = [];
    const executor = createActionExecutor({
      // Artifact persistence is the boundary; schema, authority and approval preparation stay real.
      approvalsCreate: async ({ request }) => { requests.push(request); return { artifactId: 'approval' }; },
    });
    expect(await executor.execute(actionId, { ...input, unknownOperand: true }, context))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(requests).toHaveLength(0);
    expect(await executor.execute(actionId, input, context)).toMatchObject({ ok: true,
      result: { kind: 'approval_request_created', artifactId: 'approval' } });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ actionId, actionArgs: input,
      preview: { confidentialInputs: { kind: 'action_inputs', paths: [path] } } });
    expect(await executor.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' }, context))
      .toMatchObject({ ok: false });
  });

  it('keeps external linking and metadata-only edits free of manufactured secret questions', () => {
    const source = { kind: 'external', contribution: { pluginId: 'acme.vault', localId: 'vault' },
      account: 'work', reference: 'op://vault/item/token' };
    expect(readActionSecretInputAdmission(getActionSpec('secrets.create'), { name: 'Linked', source }).missingPaths).toEqual([]);
    expect(readActionSecretInputAdmission(getActionSpec('secrets.update'), { secretId: 'id', name: 'Renamed', expectedUpdatedAt: 1 }).missingPaths).toEqual([]);
    expect(readActionSecretInputAdmission(getActionSpec('home.settings.set'), { expectedRevision: 1, values: {}, secrets: { WORKOS_API_KEY: { clear: true } } }).missingPaths).toEqual([]);
    expect(readActionSecretInputAdmission(getActionSpec('identity.providers.create'), {}).missingPaths).toEqual(['clientSecret']);
  });

  it('does not turn malformed Home secret mutations into confidential questions', async () => {
    const requests: ApprovalRequest[] = [];
    const executor = createActionExecutor({ approvalsCreate: async ({ request }) => {
      requests.push(request); return { artifactId: 'approval' };
    } });
    for (const mutation of [{ replace: 42 }, { clear: false }, { unknown: true }, { clear: true, replace: 'invalid-both' }]) {
      expect(await executor.execute('home.settings.set', { expectedRevision: 1, values: {}, secrets: { WORKOS_API_KEY: mutation } }, context))
        .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    }
    expect(requests).toEqual([]);
  });

  it('exposes identity, WorkOS and directory requests to agent/MCP under the existing consequential approval floor', () => {
    for (const id of [...MANAGED_IDENTITY_PROVIDER_ACTION_IDS_V1, ...TEAM_IDENTITY_ACTION_IDS_V1,
      ...HOME_IDENTITY_ACTION_IDS_V1, ...TEAM_DIRECTORY_ACTION_IDS_V1, 'home.settings.set'] as const) {
      const spec = getActionSpec(id);
      expect(spec.surfaces, id).toMatchObject({ agent: true, mcp: true });
      if (spec.sideEffectClass === 'read') continue;
      for (const surface of ['agent', 'mcp'] as const) expect(resolveActionApprovalRouting({ actionId: id, spec,
        context: { ...context, surface } }).required, id).toBe(true);
    }
    expect(getActionSpec('identity.providers.create').requiredAuthority).toBe('present_user');
    expect(getActionSpec('teams.directory.sources.create').requiredAuthority).toBe('present_user');
  });
});
