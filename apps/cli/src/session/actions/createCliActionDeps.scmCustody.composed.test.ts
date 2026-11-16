import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema, ScmDiffSummaryGenerateOutputSchema, createActionExecutor } from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionRequestEnvelopeSchema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { executeExternalAction } from '@/daemon/externalActions/executeExternalAction';
import * as control from '@/daemon/controlClient';
import * as publication from '@/daemon/multiDaemon';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { updateSettings } from '@/persistence';
import { configuration, reloadConfiguration } from '@/configuration';
import { createCliActionDeps } from './createCliActionDeps';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';

afterEach(() => vi.restoreAllMocks());

describe('original terminal saved-result custody', () => {
  it('retains list/read/edit/delete after Session deletion through the own-daemon public entry', async () => {
    await withTempDir('scm-terminal-custody-', async home => {
      const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID']);
      let app: ReturnType<typeof createDaemonControlApp> | undefined;
      const currentness = await createRequesterCurrentnessSocketHarness();
      try {
        env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_ACTIVE_SERVER_ID: 'custody-home' }); reloadConfiguration();
        await updateSettings(settings => ({ ...settings, machineIdByServerId: { 'custody-home': 'machine' } }));
        const serverUrl = configuration.serverUrl;
        const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 1,
          provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
        const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
        const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {}, approvalWaivedSurfaces: {
          'scm.diffSummary.result.edit': ['cli'], 'scm.diffSummary.result.delete': ['cli'],
        } });
        const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(42));
        const receiver = createActionExecutor({ ...createCliActionDeps({ token, credentials, sessionId: '', mode: 'plain', ctx: null,
          serverId: 'custody-home', serverHttpBaseUrl: serverUrl,
          scmFilesystemAccessPolicy: { kind: 'restrictedRoots', roots: [home] } }),
          readActionsSettings: () => settings,
        });
        const target = { kind: 'machine' as const, machineId: 'machine' };
        const publicationFacts = { pid: process.pid, httpPort: 4321, controlToken: 'fixture-control', accountId: 'owner', machineId: 'machine' };
        vi.spyOn(publication, 'resolveLiveDaemonControlTargetForServer').mockResolvedValue(publicationFacts);
        vi.spyOn(publication, 'resolveLiveDaemonExternalActionEndpoint').mockResolvedValue(publicationFacts);
        app = createDaemonControlApp({ getChildren: () => [], machineId: 'machine', controlToken: 'fixture-control',
          stopSession: async () => { throw new Error('No process stop expected'); },
          spawnSession: async () => { throw new Error('No process spawn expected'); },
          requestShutdown: () => { throw new Error('No shutdown expected'); }, onHappySessionWebhook: () => {},
          externalActionApi: { currentServerId: 'custody-home', currentAccountId: 'owner', executor: receiver,
            verifyPat: async () => { throw new Error('Local control has no PAT'); }, resolveTarget: async () => target },
        });
        const controlApp = app;
        // OS publication and HTTP are boundaries. Both the incumbent local
        // root and Home-signed delivery run real admission, executor and store.
        vi.spyOn(control, 'requestDaemonSignedRootActionExecution').mockImplementation(async request => {
          const response = await controlApp.inject({ method: 'POST', url: '/actions/root/execute',
            headers: { 'x-happier-daemon-token': 'fixture-control' }, payload: request });
          return response.json();
        });
        const machine = { id: 'machine', kind: 'persistent', active: true, revokedAt: null, replacedByMachineId: null,
          installationId: 'installation', installationPublicKey: Buffer.from(installation.publicKey).toString('base64'),
          access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
        vi.spyOn(axios, 'get').mockImplementation(async url => {
          const path = new URL(String(url)).pathname;
          if (path === '/v1/machines') return { status: 200, data: [machine] };
          if (path === '/v1/machines/machine') return { status: 200, data: { machine } };
          if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
          if (path === '/v1/account/profile') return { status: 200, data: { id: 'owner' } };
          if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
          if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: { actionsSettingsV1: settings } }, version: 1 } };
          return { status: 404, data: {} };
        });
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
          const path = new URL(String(url)).pathname;
          if (path.endsWith('/execution-authorization/verify')) return { status: 200, data: { ok: true } };
          if (path.endsWith('/execution-authorization')) {
            const raw = body as { envelope: unknown };
            const envelope = ExternalActionRequestEnvelopeSchema.parse(raw.envelope);
            const actionId = path.split('/').at(-2)!;
            return { status: 200, data: ExternalActionExecutionAuthorizationV1Schema.parse({
              v: 1, token: 'fixture-proof', binding: { serverIdentityId: 'srv_custody', accountId: 'owner', custodianAccountId: 'owner',
                authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain', machineId: 'machine',
                installationId: 'installation', actionId, requestId: envelope.requestId, target: envelope.target,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) },
            }) };
          }
          const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
          const result = await executeExternalAction({ actionId: path.split('/').at(-1), envelope: request.envelope,
            executionAuthorization: request.executionAuthorization,
            principal: { accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, authority: 'present_user' },
            currentMachineId: 'machine', currentAccountId: 'owner', currentServerId: 'custody-home',
            currentServerHttpBaseUrl: serverUrl, currentInstallationId: 'installation',
            externalActionMachineRequestPrivateKey: installation.secretKey,
            verifyExecutionAuthorization: async () => true, resolveTarget: async () => target, executor: receiver, surface: 'cli',
            prepareRequesterAccountContext: input => prepareRequesterAccountActionContext({ ...input,
              purpose: { kind: 'external_action' }, machineId: 'machine', installationId: 'installation',
              installationPrivateKey: installation.secretKey, serverId: 'custody-home', serverIdentityId: 'srv_custody',
              serverHttpBaseUrl: serverUrl, ownCredentials: credentials, isCurrent: async () => true, createExecutor: () => receiver }),
          });
          if (result.kind !== 'response') throw new Error('Signed delivery was not admitted');
          return { status: 200, data: result.response };
        });
        const saved = await scmDiffSummaryResultStore.create({ cwd: home, sessionId: 'deleted-session',
          output: ScmDiffSummaryGenerateOutputSchema.parse({ success: true, sourceKey: 'retained',
            metadata: { source: { kind: 'workingTree' }, sourceKey: 'retained' },
            comparison: { id: 'retained', source: { kind: 'workingTree' }, repository: { rootPath: home },
              endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } }, requestedOutputs: ['walkthrough'],
            outputs: { walkthrough: { state: 'complete', value: { title: 'Retained', intro: '', stops: [], otherChangeRefs: [] } } },
            analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
          }) });
        const caller = createCliActionExecutorFromCredentials({ credentials, serverId: 'custody-home', serverApiUrl: serverUrl,
          serverIdentityId: 'srv_custody', externalActionClient: true,
          actionsSettingsProvider: { getActionsSettings: () => settings } });
        const context = { surface: 'cli' as const, externalActionTarget: target };
        expect(await caller.execute('scm.diffSummary.result.list', { query: { cwd: home, sessionId: 'deleted-session' } }, context))
          .toMatchObject({ ok: true, result: { success: true, count: 1, results: [{ resultId: saved.resultId }] } });
        const scope = { cwd: home, resultId: saved.resultId };
        expect(await caller.execute('scm.diffSummary.result.read', scope, context))
          .toMatchObject({ ok: true, result: { success: true, result: { resultId: saved.resultId, revision: 0 } } });
        expect(await caller.execute('scm.diffSummary.result.edit', { ...scope, expectedRevision: 0,
          edit: { kind: 'renameWalkthrough', title: 'Kept after deletion' } }, context))
          .toMatchObject({ ok: true, result: { success: true, result: { revision: 1 } } });
        expect(await caller.execute('scm.diffSummary.result.delete', { ...scope, expectedRevision: 1 }, context))
          .toMatchObject({ ok: true, result: { success: true, resultId: saved.resultId } });
        expect(await scmDiffSummaryResultStore.read(scope)).toMatchObject({ success: false, errorCode: 'result_not_found' });
      } finally { await app?.close(); await currentness.close(); env.restore(); reloadConfiguration(); }
    });
  });
});
