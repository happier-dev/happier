import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, expect, it, vi } from 'vitest';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { acquireRequesterAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentnessObservation';
import { projectRequesterAccountActionAuthorization } from './requesterAccountActionProjection';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';

afterEach(() => vi.restoreAllMocks());
const roots = [
  'deployments.deploy', 'registries.updates.check', 'machines.terminal.open', 'machines.terminal.restart',
  'projects.service.relocate', 'discussion.second_opinion.start', 'session.sections.archive',
  'execution.run.start', 'execution.run.ensure', 'execution.run.send', 'execution.run.ensure_or_start',
  'projects.prepare', 'projects.script.run', 'projects.compute.exec', 'localServices.launcher.start',
  'projects.worker.status', 'projects.inspect', 'projects.execution.output.read', 'projects.execution.output.copy',
] as const;
const cases = [
  ...roots.map(actionId => ({ actionId, sessionOrigin: true })),
  ...(['workflow.run.start', 'workflow.trigger.add', 'workflow.trigger.update', 'account.apiTokens.create',
    'account.apiTokens.update'] as const).map(actionId => ({ actionId, sessionOrigin: false })),
];
it.each(cases.flatMap(root => (['plain', 'e2ee'] as const).map(mode => ({ ...root, mode }))))(
  'keeps fresh $mode owner $actionId current independently of a peer and refuses changed identity', async ({ actionId, mode, sessionOrigin }) => {
  const channel = await createRequesterCurrentnessSocketHarness();
  const fact = { mode, version: 0, settingsVersion: 0, signingKeyFingerprint: null,
    contentKeyFingerprint: null, updatedAt: 1 };
  vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: fact });
  const scope = { accountId: 'fresh-owner', token: 'fresh-owner-session', serverBaseUrl: 'https://fresh-owner.test' };
  let observation: ReturnType<typeof acquireRequesterAccountEncryptionCurrentness> | undefined;
  let serverFact = fact;
  let revoked = false;
  vi.mocked(axios.get).mockImplementation(async (_url, config) => {
    if (revoked && config?.headers?.Authorization === `Bearer ${scope.token}`) return { status: 403, data: {} };
    return { status: 200, data: serverFact };
  });
  try {
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-proved-deploy', binding: {
      accountId: scope.accountId, custodianAccountId: scope.accountId, authentication: { kind: 'account', tokenEpoch: 0 },
      serverIdentityId: 'stable-home', machineId: 'machine', installationId: 'installation', accountEncryptionMode: mode,
      actionId, requestId: 'fresh-deploy', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: 'machine' },
      ...(sessionOrigin ? { sessionActionSource: { machineId: 'machine', installationId: 'installation' },
      sessionActionOrigin: { v: 1, caller: { kind: 'session', sessionId: 'fresh-session', starterDepth: 0, turnDepth: 0 },
        sourceTurnId: 'turn', callerPermissionMode: null, requestId: 'fresh-deploy' } } : {}),
    } });
    const account = await projectRequesterAccountActionAuthorization({ authorization: root, serverIdentityId: 'stable-home', bootstrap: {
      credentials: { token: scope.token, encryption: mode === 'plain' ? null : { type: 'legacy', secret: new Uint8Array(32).fill(8) } },
      serverHttpBaseUrl: scope.serverBaseUrl, attribution: { serverId: 'home', accountId: scope.accountId, machineId: 'machine', installationId: 'installation' },
      getBoundSessionId: () => 'fresh-session', isCurrent: async () => true,
    } });
    if (!account) throw new Error('fresh_owner_projection_required');
    const http = await projectExternalActionRequesterHttpAuthorization({ authorization: account, serverId: 'home', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: scope.serverBaseUrl, target: root.binding.target, installationId: 'installation', privateKey: nacl.sign.keyPair().secretKey,
      rootAdmitted: true });
    if (!http?.requesterHttpProjection) throw new Error('fresh_owner_http_projection_required');
    const request = { effectActionId: actionId, method: 'GET' as const, path: '/v1/account/encryption' };
    expect(await http.requesterHttpProjection.createRequestHeaders(request)).not.toBeNull();
    observation = acquireRequesterAccountEncryptionCurrentness({ ...scope, token: 'peer-session' });
    await observation.read();
    expect(await http.requesterHttpProjection.createRequestHeaders(request), 'a peer must not fence an independently authenticated owner').not.toBeNull();
    serverFact = { ...fact, version: 1, settingsVersion: 1 };
    expect(await http.requesterHttpProjection.createRequestHeaders(request)).not.toBeNull();
    serverFact = { ...fact, version: 2, updatedAt: 2 };
    expect(await http.requesterHttpProjection.createRequestHeaders(request)).toBeNull();
    serverFact = fact;
    revoked = true;
    expect(await http.requesterHttpProjection.createRequestHeaders(request)).toBeNull();
  } finally { await observation?.dispose(); await channel.close(); }
});
