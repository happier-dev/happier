import { ActionSurfaceSchema } from '@happier-dev/protocol/actions/metadata';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import Fastify from 'fastify';
import nacl from 'tweetnacl';
import { expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ApiTokenGrantV1Schema } from '@happier-dev/protocol/auth/apiTokenGrant';
import { signExternalActionApprovalInputV1, verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { accountSettingsParse } from '@happier-dev/protocol';
import { configuration } from '@/configuration';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createCliApprovalsArtifactStore } from './approvals/artifactStore';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';
import { registerAccountHomeHttp, registerPlainArtifactRoutes } from './widgetApproval.testkit';

it.each(['same key', 'changed key'] as const)('replays a PAT Session-target approval with %s and preserves its signed principal', async scenario => {
  await withConfiguredDaemonTestHome({ prefix: 'happier-pat-approval-signature-' }, async () => {
    const app = Fastify();
    const home = 'http://pat-signature.test';
    const accountId = 'signature-owner';
    const homeId = 'srv_signature-home';
    const serverId = configuration.activeServerId;
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8));
    const currentKeys = scenario === 'same key' ? keys : nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
    const target = { kind: 'session', sessionId: 'source-session' } as const;
    const actionInput = { v: 1, teamId: 'team-1', membershipId: 'membership-1' };
    const effectRequest = bindHomeDomainActionHttpRequestV1('teams.members.remove', actionInput);
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 1,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`,
      encryption: null, credentialProvenance: 'stored_session' as const };
    const features = registerAccountHomeHttp(app, { accountId, serverId: homeId });
    expect(features.capabilities.serverIdentity.serverIdentityId).toBe(homeId);
    registerPlainArtifactRoutes(app, accountId);
    let machineReads = 0;
    app.get('/v1/machines/source-machine', async () => {
      machineReads++;
      return { machine: { id: 'source-machine', kind: 'persistent', active: true, managedMachineRef: null, installationId: 'source-installation',
        installationPublicKey: Buffer.from(currentKeys.publicKey).toString('base64'), revokedAt: null, replacedByMachineId: null } };
    });
    let effects = 0;
    let effectHeaders: Readonly<Record<string, string | string[] | undefined>> | undefined;
    let effectSignatureValid = false;
    app.route({ method: effectRequest.method, url: effectRequest.path, handler: async request => {
      expect(request.body).toEqual(effectRequest.body);
      effectHeaders = request.headers;
      const signature = request.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER];
      effectSignatureValid = typeof signature === 'string' && verifyExternalActionMachineRequestV1({ authorizationToken: 'signed-invocation',
        effectActionId: 'teams.members.remove', target, installationId: 'source-installation', requestId: 'signed-proposal',
        method: request.method, path: request.url, body: request.body, signature, publicKey: keys.publicKey });
      effects++;
      return { status: 'removed', membershipId: 'membership-1' };
    } });
    const restore = installAxiosFastifyAdapter({ app, origin: home });
    try {
      await runWithServerHttpBaseUrl(home, async () => {
        const store = createCliApprovalsArtifactStore({ credentials, serverId, serverHttpBaseUrl: home,
          getAccountEncryptionMode: async () => 'plain' });
        const grant = ApiTokenGrantV1Schema.parse({ v: 1, actions: { families: [], ids: ['teams.members.remove'] },
          targets: { sessions: ['source-session'], machines: [] }, approve: false, origins: [], models: null,
          permissionModes: null, create: null });
        const authorization = { v: 1 as const, token: 'signed-invocation', binding: { serverIdentityId: homeId,
          accountId, principalId: accountId, accountEncryptionMode: 'plain' as const,
          credentialId: '00000000-0000-4000-8000-000000000001',
          machineId: 'source-machine', custodianAccountId: accountId, installationId: 'source-installation',
          actionId: 'teams.members.remove' as const, requestId: 'signed-proposal', requestEnvelopeDigest: 'a'.repeat(43), target, grant } };
        // HTTP is the substituted boundary. Both proposal creation and the CLI
        // decision retain the real Artifact, provenance and signature owners.
        const producer = createActionExecutor({ ...createAccountServerActionDeps({ token: credentials.token, serverId,
          serverHttpBaseUrl: home, isCredentialCurrent: async () => true }),
          approvalsCreate: store.approvalsCreate, readActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1, actions: { ['teams.members.remove']: { approvalRequiredSurfaces: Object.keys(ActionSurfaceSchema.shape) } } }) });
        const created = await producer.execute('teams.members.remove', actionInput, {
          surface: 'api', authority: 'account_automation', serverId, serverIdentityId: homeId,
          defaultSessionMachineId: 'source-machine',
          runtimeAccountId: accountId, actionCaller: { kind: 'host' }, actionRequestId: 'signed-proposal',
          externalActionCredential: { accountId, principalId: accountId, credentialId: authorization.binding.credentialId, grant },
          externalActionTarget: target, externalActionExecutionAuthorization: authorization,
          signExternalActionApprovalInput: ({ actionId, input, target, authorization }) => signExternalActionApprovalInputV1({
            authorizationToken: authorization.token, actionId, input, target, privateKey: keys.secretKey }),
        });
        expect(created, JSON.stringify(created)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        if (!created.ok || !created.result || typeof created.result !== 'object' || !('artifactId' in created.result)
          || typeof created.result.artifactId !== 'string') throw new Error('approval_artifact_required');
        const proposal = await store.approvalsGet({ artifactId: created.result.artifactId, serverId });
        expect(proposal).toMatchObject({ v: 2, executionOriginV1: { accountId, serverIdentityId: homeId,
          machineId: 'source-machine', target, actionId: 'teams.members.remove', caller: { kind: 'host' },
          externalActionExecutionAuthorization: { token: authorization.token } } });
        expect(proposal?.v === 2 && proposal.executionOriginV1.externalActionInputSignature).toBeTruthy();
        const executor = createCliActionExecutorFromCredentials({ credentials, serverId, serverIdentityId: homeId,
          serverApiUrl: home, readCredentials: async () => credentials,
          externalActionMachineRequestPrivateKey: currentKeys.secretKey, externalActionMachineInstallationId: 'source-installation',
          resolveServerFeaturesSnapshot: async () => ({ status: 'ready', provenance: 'authenticated', features }),
          actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({}) }) });
        const decided = await executor.execute('approval.request.decide', { artifactId: created.result.artifactId, decision: 'approve' },
          { surface: 'cli', authority: 'present_user' });
        expect(machineReads).toBe(1);
        const retained = await store.approvalsGet({ artifactId: created.result.artifactId, serverId });
        if (scenario === 'same key') {
          expect(effectHeaders?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe('signed-invocation');
          expect(effectSignatureValid).toBe(true);
          expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, result: { status: 'executed' } });
          expect(effects).toBe(1);
          expect(retained).toMatchObject({ status: 'executed', execution: { ok: true,
            result: { status: 'removed', membershipId: 'membership-1' } } });
          return;
        }
        expect(decided, JSON.stringify(decided)).toMatchObject({ ok: false, errorCode: 'approval_stale', effectAttempted: false,
          details: { reason: 'credential_changed' } });
        expect(effects).toBe(0);
        expect(retained).toMatchObject({ status: 'approved' });
        expect(retained).not.toHaveProperty('execution');
      });
    } finally { restore(); await app.close(); }
  });
});
