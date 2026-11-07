import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ApprovalRequestV2Schema, type ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { ManagedIdentityProviderCreateInputV1Schema } from '@happier-dev/protocol/identity/providers';
import type { AgentRuntimeDaemonServiceRequestV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createDaemonSessionAccountActionExecutor } from './createDaemonSessionAccountActionExecutor';

afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

const { clientSecret: _privateValue, ...providerInput } = ManagedIdentityProviderCreateInputV1Schema.parse({
  owner: { kind: 'home' }, displayName: 'Company sign-in', clientSecret: 'synthetic-complete-fixture',
  config: { v: 1, kind: 'oidc', issuer: 'https://identity.example.test', clientId: 'client', scopes: 'openid profile email',
    httpTimeoutSeconds: 30, claims: { login: 'sub', email: 'email', groups: 'groups' },
    allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] }, fetchUserInfo: false,
    storeRefreshToken: false, ui: { buttonColor: null, iconHint: 'oidc' } },
});

it.each([
  { actionId: 'identity.providers.create', input: providerInput, path: 'clientSecret' },
  { actionId: 'identity.providers.secret.replace', input: { owner: { kind: 'home' }, id: 'company', expectedRevision: 1 }, path: 'clientSecret' },
  { actionId: 'home.settings.set', input: { expectedRevision: 1, values: {}, secrets: { WORKOS_API_KEY: {} } }, path: 'secrets.WORKOS_API_KEY.replace' },
] as const)('collects omitted $path through daemon admission for $actionId and rejects malformed public input', async ({ actionId, input, path }) => {
  // Home HTTP and Artifact persistence are boundaries; daemon custody, caller
  // admission, authority and approval construction are production owners.
  vi.spyOn(axios, 'get').mockResolvedValue({ status: 200,
    data: { session: createSessionRecordFixture({ id: 'session', share: null }) } });
  const requests: ApprovalRequestV2[] = [];
  const executor = createActionExecutor({ approvalsCreate: async ({ request }) => {
    requests.push(ApprovalRequestV2Schema.parse(request)); return { artifactId: 'approval' };
  } });
  const execute = createDaemonSessionAccountActionExecutor({ serverId: 'home', machineId: 'machine',
    serverHttpBaseUrl: 'https://secret-admission.example.test',
    token: `fixture.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`,
    createExecutor: () => executor });
  const operation: Extract<AgentRuntimeDaemonServiceRequestV1['operation'], { kind: 'action.execute' }> = {
    kind: 'action.execute', requestId: 'request', actionId, input,
    witness: { turnId: 'turn', inputId: 'input', userMessageSeq: 1, userMessageSeqs: [1], workDepth: 0,
      agentStartCaller: { kind: 'session', sessionId: 'session', starterDepth: 0, turnDepth: 0 } },
  };
  const authority = { sessionId: 'session', isCurrent: async () => true };
  for (const surface of ['agent', 'mcp'] as const) {
    expect(await execute({ ...operation, surface, input: { ...input, unknownOperand: true } }, authority))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(requests).toHaveLength(0);
    expect(await execute({ ...operation, surface }, authority)).toMatchObject({ ok: true,
      result: { kind: 'approval_request_created', artifactId: 'approval' } });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ actionId, actionArgs: input,
      preview: { confidentialInputs: { kind: 'action_inputs', paths: [path] } } });
    requests.length = 0;
  }
});
