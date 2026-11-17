import { buildReviewUnits } from '@happier-dev/protocol/scm/comparisonOccurrences';
import { RpcError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { markRpcRequestDisposition } from '@happier-dev/sync-client';
import axios from 'axios';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor, createScmCapabilities, sealEncryptedDataKeyEnvelopeV1, sealSessionOwnerMetadataEnvelopeV1, V2SessionByIdResponseSchema } from '@happier-dev/protocol';
import type { JsonValue } from '@happier-dev/protocol';
import type { StoredCredentials } from '@/persistence';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { withTempDir } from '@/testkit/fs/tempDir';
import { encodeBase64 } from '@/api/encryption';
import { encryptStoredSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';

import { createCliActionDeps } from './createCliActionDeps';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { runWithScmAccountScope } from '@/scm/accountScope';
import { scmRpcOperationContextStorage } from '@/scm/rpc/operationContext';
import { ScmDiffSummaryGenerateOutputSchema } from '@happier-dev/protocol';
import { configuration, reloadConfiguration } from '@/configuration';
import { updateSettings } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { createLocalScmRepositoryFixture } from '@/testkit/scm/scmBackendContractFixtures';
import { publishServerHttpRuntimeOrigin } from '@/api/client/serverHttpBaseUrl';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { ScmHostingRepositoryGetRequestV1Schema } from '@happier-dev/protocol/scm/repositoryClone';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { captureScmComparison, readCapturedScmComparison } from '@/scm/comparisons/captureScmComparison';
import { createTestGitScmBackendRegistry } from '@/scm/rpc/__tests__/testRpcHarness';
import { applyScmReviewedMarkIntent, ScmDiffSummaryResultClearResponseSchema, ScmReviewedMarkResponseSchema } from '@happier-dev/protocol';

afterEach(() => vi.restoreAllMocks());

describe('Session-backed SCM owner workspace', () => {
  const sessionId = 'c111111111111111111111111';
  const machineKey = new Uint8Array(32).fill(17);
  const encryptedCredentials = { token: 'scm-owner-token', encryption: {
    type: 'dataKey', publicKey: nacl.box.keyPair.fromSecretKey(machineKey).publicKey, machineKey,
  } } satisfies StoredCredentials;

  it.each(['differentId', 'differentUrl', 'unboundUrl', 'contextId', 'currentUrl', 'currentApi', 'currentRuntime'] as const)('binds this producer retained result to the exact selected Home (%s)', async scenario => {
    const release = publishServerHttpRuntimeOrigin('http://127.0.0.1:48187', 'iroh');
    try {
    await withTempDir('scm-owner-home-admission-', async workspace => {
      const saved = await scmDiffSummaryResultStore.create({ cwd: workspace, sessionId,
        output: ScmDiffSummaryGenerateOutputSchema.parse({ success: true, sourceKey: 'comparison',
          metadata: { source: { kind: 'workingTree' }, sourceKey: 'comparison' },
          comparison: { id: 'comparison', source: { kind: 'workingTree' }, repository: { rootPath: workspace },
            endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } },
          requestedOutputs: ['summary'], outputs: { summary: { state: 'complete', value: { summaryMarkdown: 'Private Home A result' } } },
          analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
        }) });
      vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200,
        data: String(url).endsWith('/v1/account/encryption/currentness')
          ? { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }
          : { session: createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain',
            metadata: JSON.stringify({ path: workspace }), share: null }) },
      }));
      const token = 'authenticated-other-home';
      const boundaryParams = { token, credentials: { token, encryption: null },
        sessionId, mode: 'plain' as const, ctx: null,
        ...(['unboundUrl', 'contextId', 'currentUrl', 'currentApi', 'currentRuntime'].includes(scenario) ? {} : { serverId: scenario === 'differentId'
          ? `${configuration.activeServerId}-other` : configuration.activeServerId }),
        serverHttpBaseUrl: scenario === 'currentUrl' || scenario === 'contextId' ? `${configuration.serverUrl}/`
          : scenario === 'currentApi' ? `${configuration.apiServerUrl}/`
            : scenario === 'currentRuntime' ? 'http://127.0.0.1:48187/' : 'https://other-home.test',
        scmFilesystemAccessPolicy: { kind: 'restrictedRoots', roots: [workspace] },
        resolveServerFeaturesSnapshot: () => ({ status: 'unsupported' as const, reason: 'endpoint_missing' as const }),
      };
      // URL-only cases model runtime configuration below the exact-Home typed host boundary.
      const executor = createActionExecutor(createCliActionDeps(boundaryParams as unknown as Parameters<typeof createCliActionDeps>[0]));
      const result = await executor.execute('scm.diffSummary.result.read', { cwd: workspace, resultId: saved.resultId },
        { surface: 'cli', defaultSessionId: sessionId,
          ...(scenario === 'contextId' ? { serverId: `${configuration.activeServerId}-other` } : {}) });
      const currentHome = scenario === 'currentUrl' || scenario === 'currentApi' || scenario === 'currentRuntime';
      expect(result).toMatchObject(currentHome ? { ok: true, result: { success: true,
        result: { output: { outputs: { summary: { value: { summaryMarkdown: 'Private Home A result' } } } } } } }
        : { ok: false, errorCode: 'server_scope_mismatch' });
      if (!currentHome) expect(JSON.stringify(result)).not.toContain('Private Home A result');
    });
    } finally { release(); }
  });

  const cases = ['plain', 'e2ee', 'e2eeSession', 'layout0', 'absent', 'modeMismatch', 'wrongKey'] as const;
  it.each(cases)('reads the authenticated owner workspace (%s) before real SCM dispatch', async (scenario) => {
    await withTempDir('scm-owner-workspace-', async (workspace) => {
      const encrypted = scenario === 'e2ee' || scenario === 'e2eeSession' || scenario === 'wrongKey';
      const accountMode = encrypted || scenario === 'modeMismatch' ? 'e2ee' : 'plain';
      const credentials: StoredCredentials = encrypted ? encryptedCredentials : { token: 'scm-owner-token', encryption: null };
      const ownerMetadata = { v: 1 as const, workspace: { path: workspace } };
      const sessionKey = new Uint8Array(32).fill(21);
      const rawSession = createSessionRecordFixture({ id: sessionId, encryptionMode: scenario === 'e2eeSession' ? 'e2ee' : 'plain', share: null,
        dataEncryptionKey: scenario === 'e2eeSession' ? encodeBase64(sealEncryptedDataKeyEnvelopeV1({
          dataKey: sessionKey, recipientPublicKey: encryptedCredentials.encryption.publicKey,
          randomBytes: (length) => new Uint8Array(length).fill(22),
        })) : null,
        ...(scenario === 'layout0' ? { metadata: JSON.stringify({ path: workspace }) } : {
          metadataLayoutVersion: 1, metadata: scenario === 'e2eeSession' ? encryptStoredSessionPayload({
            mode: 'e2ee', ctx: { encryptionKey: sessionKey, encryptionVariant: 'dataKey' }, payload: { v: 1 },
          }) : JSON.stringify({ v: 1 }),
          ownerMetadata: scenario === 'absent' ? undefined : encrypted
            ? sealSessionOwnerMetadataEnvelopeV1({ ownerMetadata,
              material: { type: 'dataKey', machineKey: scenario === 'wrongKey' ? new Uint8Array(32).fill(19) : machineKey },
              randomBytes: (length) => new Uint8Array(length).fill(20),
            }) : { t: 'plain' as const, v: ownerMetadata },
        }),
      });
      const sessionResponse = V2SessionByIdResponseSchema.parse({ session: rawSession });
      const saved = await scmDiffSummaryResultStore.create({ cwd: workspace, sessionId,
        output: ScmDiffSummaryGenerateOutputSchema.parse({ success: true, sourceKey: 'owner-comparison',
          metadata: { source: { kind: 'workingTree' }, sourceKey: 'owner-comparison' },
          comparison: { id: 'owner-comparison', source: { kind: 'workingTree' }, repository: { rootPath: workspace },
            endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } },
          requestedOutputs: ['summary'], outputs: { summary: { state: 'complete', value: { summaryMarkdown: 'Authenticated owner workspace' } } },
          analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
        }) });
      // HTTP is the boundary. Account mode, envelope opening, workspace admission,
      // Action dispatch and the saved-result filesystem reader all remain real.
      vi.spyOn(axios, 'get').mockImplementation(async (url) => {
        const href = String(url);
        const data = href.endsWith('/v1/account/encryption/currentness')
          ? { mode: accountMode, version: 1, signingKeyFingerprint: accountMode === 'e2ee' ? 'a'.repeat(64) : null,
              contentKeyFingerprint: accountMode === 'e2ee' ? 'b'.repeat(64) : null, updatedAt: 1 }
          : href.includes(`/sessions/${sessionId}`) ? sessionResponse : null;
        if (!data) throw new Error(`Unexpected test HTTP request ${href}`);
        return { data, status: 200 };
      });
      const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
        sessionId, mode: 'plain', ctx: null, rawSession: { path: workspace },
        scmFilesystemAccessPolicy: { kind: 'restrictedRoots', roots: [workspace] },
        resolveServerFeaturesSnapshot: () => ({ status: 'unsupported', reason: 'endpoint_missing' }),
      }));
      const result = await executor.execute('scm.diffSummary.result.read', {
        // Session Actions must use their owner workspace even when a different cwd is supplied.
        cwd: '/unrelated/input-worktree', resultId: saved.resultId,
      }, { surface: 'cli', defaultSessionId: sessionId });
      expect(result).toMatchObject(scenario === 'plain' || scenario === 'e2ee' || scenario === 'e2eeSession' || scenario === 'layout0'
        ? { ok: true, result: { success: true,
          result: { output: { outputs: { summary: { value: { summaryMarkdown: 'Authenticated owner workspace' } } } } } } }
        : { ok: false, errorCode: 'scm_action_worktree_unavailable' });
    });
  });
});

describe('exact-machine SCM Action targeting', () => {
  it.each(['account', 'terminal'] as const)('retains custodian list/read/delete through signed public Actions after Session deletion (%s)', async kind => {
    const { executeExternalAction } = await import('@/daemon/externalActions/executeExternalAction');
    const { ExternalActionExecutionAuthorizationV1Schema } = await import('@happier-dev/protocol/actions/externalActionApi');
    const { computeExternalActionRequestEnvelopeDigestV1 } = await import('@happier-dev/protocol/actions/externalActionExecutionAuthorization');
    await withTempDir('scm-public-retained-custodian-', async home => {
      const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID']);
      try {
        env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_ACTIVE_SERVER_ID: 'public-retained-home' });
        reloadConfiguration();
        await updateSettings(settings => ({ ...settings, machineIdByServerId: { 'public-retained-home': 'machine' } }));
        const saved = await scmDiffSummaryResultStore.create({ cwd: home, sessionId: 'deleted-session',
          output: ScmDiffSummaryGenerateOutputSchema.parse({ success: true, sourceKey: 'retained-comparison',
            metadata: { source: { kind: 'workingTree' }, sourceKey: 'retained-comparison' },
            comparison: { id: 'retained-comparison', source: { kind: 'workingTree' }, repository: { rootPath: home },
              endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } },
            requestedOutputs: ['summary'], outputs: { summary: { state: 'complete', value: { summaryMarkdown: 'Saved after Session deletion' } } },
            analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
          }) });
        // Only Home HTTP is substituted: deleted Session reads and signed root currentness.
        vi.spyOn(axios, 'get').mockResolvedValue({ status: 404, data: {} });
        const verify = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
        const token = 'public-custodian';
        const deps = createCliActionDeps({ token, credentials: { token, encryption: null },
          sessionId: '', mode: 'plain', ctx: null,
          scmFilesystemAccessPolicy: { kind: 'restrictedRoots', roots: [home] } });
        // Account policy is explicit fixture data; run the real shared policy owner.
        const settings = { v: 1 as const, actions: {}, approvalWaivedSurfaces: {
          'scm.diffSummary.result.delete': ['cli' as const, 'ui' as const],
        } };
        const executor = createActionExecutor({ ...deps,
          readActionsSettings: () => settings });
        const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
        const target = { kind: 'machine' as const, machineId: 'machine' };
        const invoke = async (actionId: 'scm.diffSummary.result.list' | 'scm.diffSummary.result.read' | 'scm.diffSummary.result.delete',
          input: JsonValue, accountId = 'custodian', current = true, privateHttp = true) => {
          const authentication = { kind, tokenEpoch: 1 };
          const envelope = { v: 1 as const, requestId: `public-${actionId}`, target, input };
          const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-proof', binding: {
            serverIdentityId: 'srv_retained', accountId, custodianAccountId: 'custodian', authentication,
            machineId: 'machine', installationId: 'installation', actionId, requestId: envelope.requestId, target,
            accountEncryptionMode: 'plain', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
          } });
          const result = await executeExternalAction({ actionId, envelope, executionAuthorization: authorization,
            principal: { accountId, authentication, authority: kind === 'account' ? 'present_user' : 'account_automation' }, currentMachineId: 'machine',
            currentAccountId: accountId, currentServerId: configuration.activeServerId,
            ...(privateHttp ? { currentServerHttpBaseUrl: configuration.serverUrl } : {}), currentInstallationId: 'installation',
            surface: kind === 'account' ? 'ui' : 'cli',
            externalActionMachineRequestPrivateKey: installation.secretKey,
            verifyExecutionAuthorization: async () => current, resolveTarget: async () => target, executor });
          expect(result.kind).toBe('response');
          if (result.kind !== 'response') throw new Error('Public Action admission failed');
          if (result.response.v !== 1) throw new Error('Expected plaintext Action response');
          return result.response.execution;
        };
        const request = { cwd: home, resultId: saved.resultId };
        const sharedRead = await invoke('scm.diffSummary.result.read', request, 'shared-user');
        expect(sharedRead, sharedRead.ok ? undefined : sharedRead.errorCode)
          .toMatchObject({ ok: true, result: { success: false, errorCode: 'result_unavailable' } });
        expect(await invoke('scm.diffSummary.result.read', request, 'custodian', false))
          .toMatchObject({ ok: false, errorCode: 'not_authenticated' });
        expect(await invoke('scm.diffSummary.result.read', request, 'custodian', true, false))
          .toMatchObject({ ok: true, result: { success: false, errorCode: 'result_unavailable' } });
        expect(await invoke('scm.diffSummary.result.list', { query: { cwd: home, sessionId: 'deleted-session' } }))
          .toMatchObject({ ok: true, result: { success: true, count: 1, results: [{ resultId: saved.resultId }] } });
        expect(await invoke('scm.diffSummary.result.read', request))
          .toMatchObject({ ok: true, result: { success: true, result: { resultId: saved.resultId } } });
        const deleted = await invoke('scm.diffSummary.result.delete', { ...request, expectedRevision: 0 });
        expect(deleted, deleted.ok ? undefined : deleted.errorCode)
          .toMatchObject({ ok: true, result: { success: true, resultId: saved.resultId } });
        expect(verify).toHaveBeenCalled();
        expect(await scmDiffSummaryResultStore.read(request)).toMatchObject({ success: false, errorCode: 'result_not_found' });
      } finally { env.restore(); reloadConfiguration(); }
    });
  });

  it.each(['owner', 'shared-user'] as const)('keeps requester results reachable after Session deletion through verified Machine Manage access (%s)', async requesterAccountId => runWithScmAccountScope(requesterAccountId, async () => {
    await withTempDir('scm-retained-custodian-', async home => {
      return scmRpcOperationContextStorage.run({ context: { signal: new AbortController().signal }, workingDirectory: home,
        accessPolicy: { kind: 'restrictedRoots', roots: [home] } }, async () => {
      const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID']);
      try {
        env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_ACTIVE_SERVER_ID: 'retained-home' });
        reloadConfiguration();
        await updateSettings(settings => ({ ...settings, machineIdByServerId: { [configuration.activeServerId]: 'machine' } }));
        const sessionId = 'deleted-session';
        const saved = await scmDiffSummaryResultStore.create({ cwd: home, sessionId,
          output: ScmDiffSummaryGenerateOutputSchema.parse({ success: true, sourceKey: 'retained-comparison',
            metadata: { source: { kind: 'session', sessionId }, sourceKey: 'retained-comparison' },
            comparison: { id: 'retained-comparison', source: { kind: 'session', sessionId }, repository: { rootPath: home },
              endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } },
            requestedOutputs: ['summary'], outputs: { summary: { state: 'complete', value: { summaryMarkdown: 'Retained after deletion' } } },
            analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
          }) });
        // Home HTTP is the boundary: the Session has been deleted. Machine admission
        // below represents the already verified authenticated transport witness.
        vi.spyOn(axios, 'get').mockResolvedValue({ status: 404, data: {} });
        const token = 'machine-custodian';
        const deps = createCliActionDeps({ token, credentials: { token, encryption: null },
          sessionId: '', mode: 'plain', ctx: null,
          scmFilesystemAccessPolicy: { kind: 'restrictedRoots', roots: [home] } });
        const executor = createActionExecutor(deps);
        // Exercise the real receiving Action owner after the transport has admitted
        // its typed Machine witness; root public-Action authentication is separate.
        const invoke = (actionId: Parameters<NonNullable<typeof deps.scmActionExecute>>[0]['actionId'],
          input: unknown, context: RpcActionExecutorContext) => deps.scmActionExecute!({ actionId, input, context,
          executeCanonicalAction: (nestedId, nestedInput) => executor.execute(nestedId, nestedInput, context),
          executeHostingProviderAction: (nestedId, nestedInput) => executor.execute(nestedId, nestedInput, context),
        });
        const sibling = await scmDiffSummaryResultStore.create({ cwd: home, sessionId, output: saved.output });
        let machineVerifications = 0;
        const owner: RpcActionExecutorContext = { surface: 'rpc', authority: 'account_automation',
          runtimeAccountId: requesterAccountId,
          serverId: configuration.activeServerId, externalActionTarget: { kind: 'machine', machineId: 'machine' },
          machineAdmission: { actorAccountId: requesterAccountId, custodianAccountId: 'owner', machineId: 'machine',
            installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
          verifyMachineAdmissionCurrent: async () => { machineVerifications++; return true; } };
        const request = { cwd: home, resultId: saved.resultId };
        const admittedRead = await invoke('scm.diffSummary.result.read', request, owner);
        expect(admittedRead, JSON.stringify(admittedRead)).toMatchObject({ success: true, result: { resultId: saved.resultId } });
        for (const denied of [
          { ...owner, machineAdmission: undefined },
          { ...owner, verifyMachineAdmissionCurrent: undefined },
          { ...owner, verifyMachineAdmissionCurrent: async () => false },
          { ...owner, machineAdmission: { ...owner.machineAdmission!, actorAccountId: 'another-account' } },
          { ...owner, machineAdmission: { ...owner.machineAdmission!, role: 'use' as const } },
          { ...owner, machineAdmission: { ...owner.machineAdmission!, machineId: 'other-machine' } },
          { ...owner, rpcSessionAuthorization: { kind: 'session.write' as const, sessionId: 'other-session' } },
          { ...owner, actionCaller: { kind: 'session' as const, sessionId: 'other-session', starterDepth: 0, turnDepth: 0 } },
        ]) {
          const response = await invoke('scm.diffSummary.result.read', request, denied);
          expect(response).toMatchObject({ success: false, errorCode: 'result_unavailable' });
        }
        const beforeList = machineVerifications;
        expect(await invoke('scm.diffSummary.result.list', {}, owner)).toMatchObject({ success: true, count: 2, results: expect.arrayContaining([
            expect.objectContaining({ resultId: saved.resultId }), expect.objectContaining({ resultId: sibling.resultId }),
          ]) });
        expect(machineVerifications - beforeList).toBe(1);
        expect(await invoke('scm.diffSummary.result.read', request, owner)).toMatchObject({ success: true, result: { resultId: saved.resultId, revision: 0 } });
        const otherAccount = requesterAccountId === 'owner' ? 'shared-user' : 'owner';
        expect(await invoke('scm.diffSummary.result.read', request, { ...owner,
          runtimeAccountId: otherAccount, machineAdmission: { ...owner.machineAdmission!, actorAccountId: otherAccount },
        })).toMatchObject({ success: false });
        expect(await invoke('scm.diffSummary.result.delete', { ...request, expectedRevision: 0 },
          { ...owner, bypassApprovals: true })).toMatchObject({ success: true });
        expect(await scmDiffSummaryResultStore.read(request)).toMatchObject({ success: false, errorCode: 'result_not_found' });
      } finally { env.restore(); reloadConfiguration(); }
      });
    });
  }));

  it('retries only personal mark cleanup after custodian Clear deletes a result whose generator Session is absent', async () => {
    await withTempDir('scm-retained-clear-retry-', async home => {
      const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID']);
      const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-retained-clear-repo-' });
      let admitted: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
      try {
        env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_ACTIVE_SERVER_ID: 'retained-clear-home' });
        reloadConfiguration();
        await updateSettings(settings => ({ ...settings, machineIdByServerId: { 'retained-clear-home': 'machine' } }));
        const sessionId = 'deleted-generator';
        const cwd = fixture.rootPath;
        await writeFile(join(cwd, fixture.trackedPath), 'Retained captured change\n');
        const captured = await captureScmComparison({ cwd, sessionId, source: { kind: 'workingTree' },
          registry: createTestGitScmBackendRegistry() });
        const comparison = captured.comparison;
        const refs = comparison.inventory.files.flatMap(file => file.occurrences.map(change => change.id));
        expect(refs.length).toBeGreaterThan(0);
        const saved = await scmDiffSummaryResultStore.create({ cwd, sessionId,
          output: ScmDiffSummaryGenerateOutputSchema.parse({ success: true, sourceKey: comparison.id,
            metadata: captured.metadata, comparison, requestedOutputs: ['summary'],
            outputs: { summary: { state: 'complete', value: { summaryMarkdown: 'Retained after generator deletion' } } },
            analysis: { suppliedChangeRefs: refs, analysedChangeRefs: refs, remainingChangeRefs: [] },
          }) });
        const originalRecord = applyScmReviewedMarkIntent(comparison, null, refs, true);
        let content = Buffer.from(JSON.stringify({ t: 'plain', v: originalRecord })).toString('base64');
        let version = 0;
        let kvReads = 0;
        let kvWrites = 0;
        let failCleanup = true;
        // Only Home HTTP is substituted. Session admission, immutable capture,
        // Machine deletion, Account codec and RecordPort.clear all remain real.
        vi.spyOn(axios, 'get').mockImplementation(async url => {
          const path = new URL(url).pathname;
          if (path.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
            mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
          } };
          if (path.startsWith('/v1/kv/')) {
            kvReads++;
            return { status: 200, data: { key: decodeURIComponent(path.slice('/v1/kv/'.length)), value: content, version } };
          }
          if (path.includes(`/sessions/${sessionId}`)) return { status: 404, data: {} };
          throw new Error(`Unexpected test HTTP request ${path}`);
        });
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
          if (new URL(url).pathname !== '/v1/kv') throw new Error('Unexpected test HTTP mutation');
          kvWrites++;
          if (failCleanup) return { status: 503, data: { error: 'Account KV unavailable' } };
          const mutation = (body as { mutations: { key: string; value: string; version: number }[] }).mutations[0]!;
          expect(mutation.version).toBe(version);
          content = mutation.value;
          return { status: 200, data: { success: true, results: [{ key: mutation.key, version: ++version }] } };
        });
        const token = 'retained-clear-custodian';
        const executor = createActionExecutor(createCliActionDeps({ token, credentials: { token, encryption: null },
          sessionId: '', mode: 'plain', ctx: null,
          scmFilesystemAccessPolicy: { kind: 'restrictedRoots', roots: [cwd] } }));
        const owner: RpcActionExecutorContext = { surface: 'rpc', authority: 'account_automation', bypassApprovals: true,
          serverId: configuration.activeServerId, externalActionTarget: { kind: 'machine', machineId: 'machine' },
          machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
            installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
          verifyMachineAdmissionCurrent: async () => true };
        const reference = { cwd, sessionId, resultId: saved.resultId, comparisonId: comparison.id, expectedRevision: 0 };
        const reset = { v: 2 as const, cwd, sessionId, comparisonId: comparison.id, source: comparison.source, reset: true as const };
        admitted = await createAdmittedPluginRuntimeFixture({ happyHomeDir: home, controller: pluginReloadController,
          runtimeOptions: { pluginIds: ['happier.scm.backend.git'] } });
        // Custody of retained evidence must not authorize creating new Session evidence.
        expect(await executor.execute('scm.diffSummary.capture', { cwd, sessionId, source: comparison.source }, owner))
          .toMatchObject({ ok: true, result: { success: false, errorCode: 'DIFF_UNAVAILABLE' } });
        await admitted.dispose();
        admitted = undefined;
        const deniedCallers = [
          { ...owner, machineAdmission: { ...owner.machineAdmission!, actorAccountId: 'shared-user' } },
          { ...owner, machineAdmission: { ...owner.machineAdmission!, role: 'use' as const } },
          { ...owner, rpcSessionAuthorization: { kind: 'session.write' as const, sessionId: 'different-session' } },
          { ...owner, actionCaller: { kind: 'session' as const, sessionId: 'different-session', starterDepth: 0, turnDepth: 0 } },
        ];
        for (const denied of deniedCallers) {
          const clear = await executor.execute('scm.diffSummary.result.clear', { results: [reference] }, denied);
          expect(clear).toMatchObject({ ok: true, result: { success: true, deleted: [], failures: [{
            resultId: saved.resultId, errorCode: 'result_unavailable',
          }] } });
          expect(await executor.execute('scm.diffSummary.reviewed.unmark', reset, denied))
            .toMatchObject({ ok: true, result: { success: false, errorCode: 'result_unavailable' } });
          expect(await scmDiffSummaryResultStore.read(reference)).toMatchObject({ success: true });
        }
        expect({ kvReads, kvWrites }).toEqual({ kvReads: 0, kvWrites: 0 });
        const execution = await executor.execute('scm.diffSummary.result.clear', { results: [reference] }, owner);
        expect(execution.ok).toBe(true);
        if (!execution.ok) throw new Error(execution.error);
        const cleared = ScmDiffSummaryResultClearResponseSchema.parse(execution.result);
        expect(cleared).toMatchObject({ success: true, deleted: [{ resultId: saved.resultId, comparisonId: comparison.id }],
          failures: [{ errorCode: 'reviewed_marks_cleanup_failed', resultDeleted: true,
            retry: { actionId: 'scm.diffSummary.reviewed.unmark', input: reset } }] });
        expect(kvWrites).toBe(1);
        expect(await scmDiffSummaryResultStore.read(reference)).toMatchObject({ success: false, errorCode: 'result_not_found' });
        expect((await readCapturedScmComparison(reset)).comparison).toEqual(comparison);
        // The native UI retries by reading this exact retained capture first;
        // that read needs neither the deleted Session nor a serving SCM backend.
        expect(await executor.execute('scm.diffSummary.capture', { cwd, sessionId, comparisonId: comparison.id,
          source: comparison.source }, owner)).toMatchObject({ ok: true, result: { success: true, comparison } });
        expect(JSON.parse(Buffer.from(content, 'base64').toString()).v).toEqual(originalRecord);
        if (!cleared.success) throw new Error('Clear did not produce a deletion outcome');
        const failure = cleared.failures.find(item => item.errorCode === 'reviewed_marks_cleanup_failed');
        if (!failure || failure.errorCode !== 'reviewed_marks_cleanup_failed') throw new Error('Missing mark-only retry');
        failCleanup = false;
        const retried = await executor.execute(failure.retry.actionId, failure.retry.input, owner);
        expect(retried, retried.ok ? JSON.stringify(retried.result) : retried.errorCode)
          .toMatchObject({ ok: true, result: { success: true } });
        if (!retried.ok) throw new Error(retried.error);
        const response = ScmReviewedMarkResponseSchema.parse(retried.result);
        expect(response).toMatchObject({ success: true, record: { reviewedChangeKeys: [] } });
        expect(JSON.parse(Buffer.from(content, 'base64').toString()).v).toEqual(response.success ? response.record : null);
        expect(kvWrites).toBe(2);
        expect(await scmDiffSummaryResultStore.read(reference)).toMatchObject({ success: false, errorCode: 'result_not_found' });
      } finally {
        await admitted?.dispose();
        env.restore(); reloadConfiguration();
        await rm(fixture.rootPath, { recursive: true, force: true });
      }
    });
  });

  it('reads blame at the installed native SCM owner without recursively invoking its own RPC', async () => {
    await withTempDir('scm-blame-native-home-', async home => {
      const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID']);
      const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-native-blame-' });
      let admitted: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
      try {
        env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_ACTIVE_SERVER_ID: 'blame-native-home' });
        reloadConfiguration();
        await updateSettings(settings => ({ ...settings, machineIdByServerId: { 'blame-native-home': 'machine' } }));
        admitted = await createAdmittedPluginRuntimeFixture({ happyHomeDir: home, controller: pluginReloadController,
          runtimeOptions: { pluginIds: ['happier.scm.backend.git'] } });
        await writeFile(join(fixture.rootPath, fixture.trackedPath), 'native uncommitted line\n');
        // Network is the boundary. A received Action must not call that same
        // Machine RPC again; the installed Git contribution reads real bytes.
        const network = vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async () => {
          throw new Error('Recursive native SCM RPC');
        });
        const token = 'blame-native-requester';
        const executor = createActionExecutor(createCliActionDeps({ token, credentials: { token, encryption: null },
          serverId: configuration.activeServerId, serverHttpBaseUrl: configuration.serverUrl,
          sessionId: '', mode: 'plain', ctx: null,
          scmFilesystemAccessPolicy: { kind: 'restrictedRoots', roots: [fixture.rootPath] } }));
        const context = { surface: 'rpc' as const, authority: 'account_automation' as const,
          serverId: configuration.activeServerId, externalActionTarget: { kind: 'machine' as const, machineId: 'machine' } };
        const request = { cwd: fixture.rootPath, path: fixture.trackedPath };
        expect(await executor.execute('scm.blame.get', request, context)).toMatchObject({ ok: true, result: {
          success: true, commits: [], ranges: [{ startLine: 1, lineCount: 1, commitIndex: null }],
        } });
        expect(await executor.execute('scm.blame.get', { ...request, expectedHash: '0'.repeat(64) }, context))
          .toMatchObject({ ok: true, result: { success: false, errorCode: 'stale_file' } });
        expect(await executor.execute('scm.blame.get', request, { ...context, serverId: 'srv_foreign_home' }))
          .toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
        expect(network).not.toHaveBeenCalled();
      } finally {
        await admitted?.dispose(); env.restore(); reloadConfiguration();
        await rm(fixture.rootPath, { recursive: true, force: true });
      }
    });
  });

  it.each(['accessible', 'denied', 'foreignProof'] as const)('checks authenticated Session access for local machine comparison capture (%s)', async access => {
    await withTempDir('scm-machine-session-home-', async home => {
      const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID']);
      const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-machine-session-' });
      const sessionId = 'c111111111111111111111111';
      let admitted: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
      try {
        env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_ACTIVE_SERVER_ID: 'session-review-home' });
        reloadConfiguration();
        await updateSettings(settings => ({ ...settings, machineIdByServerId: { 'session-review-home': 'machine' } }));
        admitted = await createAdmittedPluginRuntimeFixture({ happyHomeDir: home, controller: pluginReloadController,
          runtimeOptions: { pluginIds: ['happier.scm.backend.git'] } });
        await writeFile(join(fixture.rootPath, fixture.trackedPath), 'Session-bound pending change\n');
        // The HTTP boundary supplies current access; Action qualification, Git capture
        // and retained comparison storage run unchanged beneath it.
        vi.spyOn(axios, 'get').mockImplementation(async url => {
          if (!String(url).includes(`/sessions/${sessionId}`)) throw new Error('Unexpected Session access request');
          if (access === 'denied') throw Object.assign(new Error('Forbidden'), { response: { status: 403 } });
          return { status: 200, data: { session: createSessionRecordFixture({ id: sessionId,
            encryptionMode: 'plain', machineId: 'machine', metadata: JSON.stringify({ path: fixture.rootPath }), share: null }) } };
        });
        const token = 'session-review-requester';
        const executor = createActionExecutor(createCliActionDeps({ token, credentials: { token, encryption: null },
          sessionId: '', mode: 'plain', ctx: null,
          scmFilesystemAccessPolicy: { kind: 'restrictedRoots', roots: [fixture.rootPath] } }));
        const result = await executor.execute('scm.diffSummary.capture', { cwd: fixture.rootPath, sessionId,
          source: { kind: 'workingTree' } }, { surface: 'cli', externalActionTarget: { kind: 'machine', machineId: 'machine' },
          ...(access === 'foreignProof' ? { rpcSessionAuthorization: { kind: 'session.write' as const, sessionId: 'different-session' } } : {}) });
        expect(result).toMatchObject({ ok: true, result: access === 'accessible'
          ? { success: true, comparison: { repository: { rootPath: fixture.rootPath }, inventory: { state: 'complete',
              files: [expect.objectContaining({ path: fixture.trackedPath, evidence: expect.objectContaining({ state: 'available',
                unifiedDiff: expect.stringContaining('Session-bound pending change') }) })] } } }
          : { success: false, errorCode: 'DIFF_UNAVAILABLE' } });
      } finally {
        await admitted?.dispose();
        env.restore(); reloadConfiguration();
        await rm(fixture.rootPath, { recursive: true, force: true });
      }
    });
  });

  it('admits a portable Home for real local saved-review list and read while refusing lost or ambiguous bindings', async () => {
    await withTempDir('scm-portable-home-', async home => {
      const scope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID']);
      const profileId = 'local-machine-profile';
      const serverId = 'srv_portable_review_home';
      try {
        scope.patch({ HAPPIER_HOME_DIR: home, HAPPIER_ACTIVE_SERVER_ID: profileId });
        reloadConfiguration();
        const serverUrl = configuration.serverUrl;
        const profile = { id: profileId, name: 'Review Home', serverUrl, webappUrl: serverUrl,
          createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact' as const,
          homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: serverId, canonicalServerUrl: serverUrl,
            revision: 1, endpoints: [{ kind: 'https', url: serverUrl }] }) };
        await updateSettings(settings => ({ ...settings, machineIdByServerId: { [profileId]: 'machine' }, activeServerId: profileId,
          servers: { [profileId]: profile } }));
        const saved = await scmDiffSummaryResultStore.create({ cwd: home,
          output: ScmDiffSummaryGenerateOutputSchema.parse({ success: true, sourceKey: 'portable-comparison',
            metadata: { source: { kind: 'workingTree' }, sourceKey: 'portable-comparison' },
            comparison: { id: 'portable-comparison', source: { kind: 'workingTree' }, repository: { rootPath: home },
              endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } },
            requestedOutputs: ['summary'], outputs: { summary: { state: 'complete', value: { summaryMarkdown: 'Portable Home review' } } },
            analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
          }) });
        const token = 'admitted-review-requester';
        const executor = createActionExecutor(createCliActionDeps({ token, credentials: { token, encryption: null },
          serverId: profileId, serverHttpBaseUrl: serverUrl, sessionId: '', mode: 'plain', ctx: null,
          scmFilesystemAccessPolicy: { kind: 'restrictedRoots', roots: [home] } }));
        const context = { surface: 'rpc' as const, authority: 'account_automation' as const, serverId,
          machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
            installationId: 'installation', role: 'manage' as const, encryptionMode: 'plain' as const },
          verifyMachineAdmissionCurrent: async () => true,
          externalActionTarget: { kind: 'machine' as const, machineId: 'machine' } };
        expect(await executor.execute('scm.diffSummary.result.list', {}, context)).toMatchObject({ ok: true,
          result: { success: true, results: [expect.objectContaining({ resultId: saved.resultId })] } });
        expect(await executor.execute('scm.diffSummary.result.read', { cwd: home, resultId: saved.resultId }, context))
          .toMatchObject({ ok: true, result: { success: true, result: { resultId: saved.resultId } } });
        expect(await executor.execute('scm.diffSummary.result.read', { cwd: home, resultId: saved.resultId }, {
          ...context, defaultSessionId: 'caller-session',
          actionCaller: { kind: 'session', sessionId: 'caller-session', starterDepth: 0, turnDepth: 0 },
          externalActionTarget: { kind: 'machine', machineId: 'machine', project: { machineId: 'machine', directory: home } },
        })).toMatchObject({ ok: true, result: { success: false, errorCode: 'result_unavailable' } });
        expect(await executor.execute('scm.diffSummary.result.read', { cwd: home, resultId: saved.resultId },
          { ...context, serverId: 'srv_wrong_home' })).toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
        for (const scenario of ['ambiguous', 'retired'] as const) {
          await updateSettings((settings): typeof settings => ({ ...settings, servers: scenario === 'retired' ? {}
            : { [profileId]: profile, duplicate: { ...profile, id: 'duplicate' } } }));
          expect(await executor.execute('scm.diffSummary.result.list', {}, context))
            .toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
          expect(await executor.execute('scm.diffSummary.result.read', { cwd: home, resultId: saved.resultId }, context))
            .toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
        }
      } finally { scope.restore(); reloadConfiguration(); }
    });
  });

  it('admits machine saved inventory without a fabricated directory and refuses a Session-wide inventory', async () => {
    const calls: unknown[] = [];
    const inventory = { success: true, results: [], count: 0, bytes: 0,
      sevenDayCost: { status: 'unavailable', pricedRunCount: 0, unpricedRunCount: 0, sinceMs: 0, untilMs: 1 } };
    const executor = createActionExecutor(createCliActionDeps({
      token: 'already-admitted-daemon-token', sessionId: '', mode: 'plain', ctx: null,
      machineActionDirectTargetTransport: { machineId: 'machine', invoke: async (method, request) => { calls.push({ method, request }); return inventory; } },
    }));
    expect(await executor.execute('scm.diffSummary.result.list', {}, { surface: 'rpc', authority: 'account_automation',
      externalActionTarget: { kind: 'machine', machineId: 'machine' },
    })).toEqual({ ok: true, result: inventory });
    expect(calls).toEqual([{ method: 'scm.diffSummary.result.list', request: {} }]);
    expect(await executor.execute('scm.diffSummary.result.list', {}, { surface: 'rpc', authority: 'account_automation',
      defaultSessionId: 'session', externalActionTarget: { kind: 'session', sessionId: 'session' },
    })).toMatchObject({ ok: false, errorCode: 'machine_not_selected' });
    expect(calls).toHaveLength(1);
  });
  it('reads public repository metadata through a closed machine request without Git fields', async () => {
    const input = { selector: { provider: { id: 'example/forge', kind: 'custom', displayName: 'Forge', baseUrl: 'https://forge.test' },
      repository: { nameWithOwner: 'group/repo' }, protocol: 'https' } };
    const executor = createActionExecutor(createCliActionDeps({
      token: 'already-admitted-daemon-token', sessionId: '', mode: 'plain', ctx: null,
      machineActionDirectTargetTransport: { machineId: 'machine', invoke: async (method, request) => {
        // The authenticated Machine transport reaches the same strict consumer as the daemon.
        expect(method).toBe('scm.hostingRepository.get');
        expect(ScmHostingRepositoryGetRequestV1Schema.parse(request)).toEqual(input);
        return { success: true, kind: 'private' };
      } },
    }));
    expect(await executor.execute('scm.hostingRepository.get', input, { surface: 'rpc', authority: 'account_automation',
      externalActionTarget: { kind: 'machine', machineId: 'machine' },
    })).toEqual({ ok: true, result: { success: true, kind: 'private' } });
  });
  it('uses the admitted machine transport and exact directory without requiring a Session', async () => {
    const calls: Array<Readonly<{ method: string; request: unknown; signal?: AbortSignal }>> = [];
    const signal = new AbortController().signal;
    const executor = createActionExecutor(createCliActionDeps({
      token: 'already-admitted-daemon-token',
      sessionId: '', mode: 'plain', ctx: null,
      machineActionDirectTargetTransport: {
        machineId: 'selected-machine',
        // The injected boundary is the authenticated exact-daemon transport.
        invoke: async (method, request, options) => {
          calls.push({ method, request, signal: options?.signal });
          return { success: false, errorCode: 'NOT_REPOSITORY', error: 'Not a repository' };
        },
      },
    }));

    await expect(executor.execute('scm.pullRequest.list', { cwd: '/chosen/worktree' }, {
      surface: 'rpc', authority: 'account_automation',
      externalActionTarget: { kind: 'machine', machineId: 'selected-machine' }, signal,
    })).resolves.toEqual({ ok: true, result: { success: false, errorCode: 'NOT_REPOSITORY', error: 'Not a repository' } });
    expect(calls).toEqual([{ method: 'scm.pullRequest.list', request: { cwd: '/chosen/worktree', outcomeVersion: 1 }, signal }]);
  });

  it('does not reuse an admitted transport for a different machine or infer a directory', async () => {
    let invoked = false;
    const executor = createActionExecutor(createCliActionDeps({
      token: 'already-admitted-daemon-token', sessionId: '', mode: 'plain', ctx: null,
      machineActionDirectTargetTransport: {
        machineId: 'admitted-machine',
        invoke: async () => { invoked = true; return { success: true }; },
      },
    }));
    await expect(executor.execute('scm.pullRequest.list', { cwd: '/chosen/worktree' }, {
      surface: 'rpc', authority: 'account_automation',
      externalActionTarget: { kind: 'machine', machineId: 'different-machine' },
    })).resolves.toMatchObject({ ok: false, errorCode: 'not_authenticated' });
    await expect(executor.execute('scm.pullRequest.list', {}, {
      surface: 'rpc', authority: 'account_automation',
      externalActionTarget: { kind: 'machine', machineId: 'admitted-machine' },
    })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_input' });
    expect(invoked).toBe(false);
  });

  it('capability-negotiates advanced mutation options at the exact selected target before dispatch', async () => {
    const cases = [
      { id: 'scm.commit.undoLast', input: { cwd: '/repo', expectedHeadOid: 'a'.repeat(40) }, bits: { writeCommitUndoLast: true }, capability: 'writeCommitUndoLast' },
      { id: 'scm.remote.push', input: { cwd: '/repo', dirtyPolicy: 'autostash' }, bits: { writeRemotePolicies: true }, capability: 'writeRemotePolicies' },
      { id: 'scm.remote.push', input: { cwd: '/repo', remote: 'origin', branch: 'main', pushMode: 'force_with_lease', expectedRemoteOid: 'a'.repeat(40) }, bits: { writeRemoteForceWithLease: true }, capability: 'writeRemoteForceWithLease' },
      { id: 'scm.commit.create', input: { cwd: '/repo', message: 'Amend', mode: 'amend' }, bits: { writeCommitAmend: true }, capability: 'writeCommitAmend' },
      { id: 'scm.commit.create', input: { cwd: '/repo', message: 'Sign off', signOff: true }, bits: { writeCommitSignOff: true }, capability: 'writeCommitSignOff' },
    ] as const;
    for (const item of cases) {
      for (const capabilities of [undefined, createScmCapabilities(), createScmCapabilities(item.bits)]) {
        const methods: string[] = [];
        const executor = createActionExecutor(createCliActionDeps({ token: 'admitted-token', sessionId: '', mode: 'plain', ctx: null,
          machineActionDirectTargetTransport: { machineId: 'target', invoke: async (method) => {
            methods.push(method);
            return method === 'scm.backend.describe' ? { success: true, ...(capabilities ? { capabilities } : {}) } : { success: true };
          } },
        }));
        const result = await executor.execute(item.id, item.input, {
          surface: 'rpc', authority: 'account_automation', externalActionTarget: { kind: 'machine', machineId: 'target' },
          actionsSettings: { v: 1, actions: {}, approvalWaivedSurfaces: { [item.id]: ['rpc'] } },
        });
        const supported = capabilities?.[item.capability] === true;
        expect(result).toMatchObject({ ok: true, result: supported ? { success: true } : { success: false, errorCode: 'FEATURE_UNSUPPORTED', outcome: { kind: 'failed' } } });
        expect(methods).toEqual(supported ? ['scm.backend.describe', item.id] : ['scm.backend.describe']);
      }
    }
  });
});

describe('SCM discard Machine failures', () => {
  it.each(['refused', 'lost-acknowledgement', 'unknown-code'] as const)('preserves the receiver outcome (%s)', async scenario => {
    await withTempDir('scm-discard-failure-', async cwd => {
      const machineId = 'discard-machine';
      // Machine RPC is a network boundary. Preserve the observed daemon refusal
      // envelope and substitute transport-owned lost acknowledgement errors.
      vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async () => {
        if (scenario === 'lost-acknowledgement') throw markRpcRequestDisposition(
          new RpcError('Socket disconnected', RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE), 'outcomeUnknown');
        if (scenario === 'unknown-code') throw new RpcError('Acknowledgement lost', RPC_ERROR_CODES.OUTCOME_UNKNOWN);
        return { errorCode: 'agent_isolation_unavailable', error: 'Requester execution protection is unavailable' };
      });
      const executor = createActionExecutor(createCliActionDeps({ token: 'discard-token',
        credentials: { token: 'discard-token', encryption: null }, sessionId: '', mode: 'plain', ctx: null }));
      const diff = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n';
      const result = await executor.execute('scm.change.discard', { cwd, entries: [{ path: 'a.ts', kind: 'comparison',
        against: { source: { kind: 'workingTree' } }, changeKeys: buildReviewUnits('a.ts', 'combined', diff).map(unit => unit.key) }] },
        { surface: 'rpc', authority: 'account_automation', externalActionTarget: { kind: 'machine', machineId } });
      expect(result).toMatchObject(scenario === 'refused'
        ? { ok: false, errorCode: 'agent_isolation_unavailable' }
        : { ok: true, result: { success: false, errorCode: 'COMMAND_OUTCOME_UNKNOWN' } });
    });
  });
});
