import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QualifiedConnectedAccountCredentialSnapshotV4Schema, QualifiedConnectedAccountListResponseV4Schema,
  QualifiedConnectedAccountGroupV4Schema, QualifiedConnectedAccountGroupActiveAccountV4Schema,
  QualifiedConnectedAccountGroupRuntimeStatePatchV4Schema } from '@happier-dev/protocol';

import { ApiClient } from '@/api/api';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createDaemonConnectedAccountPurposeBindingRuntime } from '../purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';
import { createQualifiedConnectedAccountEstablishedRuntimeOwner } from '../qualifiedConnectedAccountEstablishedRuntimeOwner';
import { createAccountSettingsConnectedAccountSecrets, createQualifiedConnectedAccountDaemonPersistence } from '../qualifiedConnectedAccountDaemonPersistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { listQualifiedConnectedAccountsV4, listQualifiedConnectedAccountGroupsV4, readQualifiedConnectedAccountGroupV4 } from '@/api/client/qualifiedConnectedAccountApi';
import { createConnectedAccountRequestAuthSubjectRegistry } from '../requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { resolveConnectedServiceAuthForSpawn } from '../resolveConnectedServiceAuthForSpawn';
import { resolveConnectedServiceMaterializedRootDir } from '../materialize/resolveConnectedServiceMaterializedRootDir';
import { createAdoptedExecutionRunRootCleanup } from './createAdoptedExecutionRunRootCleanup';
import { createExecutionRunConnectedServicesBridge } from './executionRunMaterialization';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import { createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator } from '../runtimeAuth/createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator';

describe('requester execution-run materialization', () => {
  afterEach(() => vi.restoreAllMocks());

  it('materializes the captured parent requester subscription instead of the Machine custodian subscription', async () => {
    const accountContexts = new Map(['alice', 'bob'].map(accountId => {
      const credentials = { token: `${accountId}-token`, encryption: null };
      const persistence = createQualifiedConnectedAccountDaemonPersistence({ credentials,
        getAccountEncryptionMode: async () => 'plain', readAccountSettings: () => ({}),
        secrets: createAccountSettingsConnectedAccountSecrets({ expectedScopeKey: resolveAccountSettingsScopeKey(credentials) }) });
      const established = createQualifiedConnectedAccountEstablishedRuntimeOwner({ credentials,
        reloadController: pluginReloadController, getAccountEncryptionMode: async () => 'plain',
        configuration: persistence.configuration });
      const purposes = createDaemonConnectedAccountPurposeBindingRuntime({ establishedRuntimeOwner: established,
        reloadController: pluginReloadController, resolveQualifiedConnectedAccountV4Support: () => 'advertised',
        allowNativeAccountCredentials: false,
        store: { read: async () => ({ v: 1, bindings: [] }), update: async mutate => mutate({ v: 1, bindings: [] }),
          subscribe: () => ({ dispose() {} }) },
        qualifiedApi: {
          listAccounts: (service, signal) => listQualifiedConnectedAccountsV4({ token: credentials.token, service, signal }),
          listGroups: (service, signal) => listQualifiedConnectedAccountGroupsV4({ token: credentials.token, service, signal }),
          readGroup: (group, signal) => readQualifiedConnectedAccountGroupV4({ token: credentials.token, group, signal }),
        } });
      return [accountId, { credentials, purposes }] as const;
    }));
    const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.codex'], connectedAccounts: accountContexts.get('alice')!.purposes.owner } });
    try {
      const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
      const revision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
      const groups = new Map(['alice', 'bob'].map(accountId => [accountId, QualifiedConnectedAccountGroupV4Schema.parse({
        v: 1, ref: { service, groupId: 'main' }, incarnation: `${accountId}-main`, displayName: 'Main',
        policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, autoSwitch: true },
        activeConnectedAccountId: 'work', generation: 7, runtimeStateRevision: 1, state: {}, createdAt: 1, updatedAt: 1,
        members: ['work', 'backup'].map((connectedAccountId, index) => ({ v: 1, connectedAccountId,
          priority: index + 1, enabled: true, state: {}, createdAt: 1, updatedAt: 1 })),
      })] as const));
      const authenticatedCredentialAccounts: string[] = [];
      // Only the Account HTTP transport is substituted; catalog, credential projection,
      // purpose activation, run ownership and native-file materialization remain real.
      vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
        const requestUrl = new URL(String(url));
        const path = requestUrl.pathname;
        const accountId = config?.headers?.Authorization === 'Bearer bob-token' ? 'bob' : 'alice';
        if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain' } };
        if (path === '/v4/connect/qualified/configuration') return { status: 404, data: null };
        if (path === '/v4/connect/qualified/accounts') return { status: 200, data: QualifiedConnectedAccountListResponseV4Schema.parse({
          service, accounts: ['work', 'backup'].map(accountId => ({ ref: { service, accountId }, status: 'connected', authenticationModeId: 'oauth',
            revisionSemantics: 'revisioned', credentialRevision: revision, configurationReady: true, configurationRevision: null, scopes: [] })),
        }) };
        if (path === '/v4/connect/qualified/group') return { status: 200, data: { group: groups.get(accountId) } };
        if (path === '/v4/connect/qualified/credential') {
          authenticatedCredentialAccounts.push(accountId);
          return { status: 200, data: QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
            ref: { service, accountId: requestUrl.searchParams.get('accountId') ?? 'work' }, authenticationModeId: 'oauth', revisionSemantics: 'revisioned',
            credentialRevision: revision, configurationRevision: null, metadata: { scopes: [] },
            content: { t: 'plain', v: { v: 1, values: { accessToken: `${accountId}-subscription`,
              refreshToken: `${accountId}-refresh`, idToken: `${accountId}-id`, providerAccountId: `${accountId}-billing` } } },
          }) };
        }
        throw new Error(`Unexpected Account transport path: ${path}`);
      });
      vi.spyOn(axios, 'patch').mockImplementation(async (_url, body, config) => {
        const patch = QualifiedConnectedAccountGroupRuntimeStatePatchV4Schema.parse(body);
        const accountId = config?.headers?.Authorization === 'Bearer bob-token' ? 'bob' : 'alice';
        const group = groups.get(accountId)!;
        const updated = QualifiedConnectedAccountGroupV4Schema.parse({ ...group, runtimeStateRevision: group.runtimeStateRevision + 1,
          members: group.members.map(member => ({ ...member,
            state: patch.runtimeState.memberStates?.find(next => next.connectedAccountId === member.connectedAccountId)?.state ?? member.state })) });
        groups.set(accountId, updated);
        return { status: 200, data: { group: updated } };
      });
      vi.spyOn(axios, 'post').mockImplementation(async (_url, body, config) => {
        const mutation = QualifiedConnectedAccountGroupActiveAccountV4Schema.parse(body);
        const accountId = config?.headers?.Authorization === 'Bearer bob-token' ? 'bob' : 'alice';
        const group = groups.get(accountId)!;
        const updated = QualifiedConnectedAccountGroupV4Schema.parse({ ...group,
          activeConnectedAccountId: mutation.connectedAccountId, generation: group.generation + 1 });
        groups.set(accountId, updated);
        return { status: 200, data: { group: updated } };
      });
      const registry = new ConnectedServiceRuntimeRegistry();
      const runnerIdentity = { pid: process.pid, happySessionId: 'bob-session' };
      let runnerCurrent = true;
      const resolveBaseDir = (parentSessionId?: string | null) => join(runtime.happyHomeDir, 'materialized',
        parentSessionId === 'bob-session' ? 'bob' : 'alice');
      const aliceRoot = resolveConnectedServiceMaterializedRootDir({ baseDir: resolveBaseDir('alice-session'), materializationKey: 'bob-run', agentId: 'codex' });
      await mkdir(aliceRoot, { recursive: true });
      await writeFile(join(aliceRoot, 'custodian-sentinel'), 'alice-private');
      const bridge = createExecutionRunConnectedServicesBridge({
        captureRunnerIdentity: ({ runnerPid }) => runnerPid === runnerIdentity.pid
          ? { identity: runnerIdentity, parentSessionId: runnerIdentity.happySessionId, isCurrent: () => runnerCurrent } : null,
        acquireAgentPurposeContributions: async ({ agentId }) => {
          const identity = runtime.registry.contributes.agentDefinitionsById.get(agentId)?.identity;
          const sourceCustody = identity ? runtime.registry.readPluginSourceCustody?.(identity.pluginId) : null;
          return { contributions: runtime.registry.contributes, isCurrent: () => runtime.controller.isRuntimeRegistryCurrent(runtime.registry),
            resolveAgentContributionIdentity: async () => identity && sourceCustody ? { ...identity, sourceCustody } : null,
            release: async () => undefined };
        },
        resolveAuthForSpawn: async ({ parentSessionId, ...input }) => {
          const accountContext = accountContexts.get(parentSessionId === 'bob-session' ? 'bob' : 'alice')!;
          const credentials = accountContext.credentials;
          const baseDir = resolveBaseDir(parentSessionId);
          return await resolveConnectedServiceAuthForSpawn({ ...input, credentials, api: await ApiClient.create(credentials),
            activeServerDir: baseDir, baseDir, connectedAccountsOwner: accountContext.purposes.owner,
            allowNativeAccountState: false, isAccountRuntimeCurrent: async () => true });
        },
        recoverRejectedStart: async ({ parentSessionId, selection, modelId, isCurrent }) => {
          const coordinator = createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator({
            token: parentSessionId === 'bob-session' ? 'bob-token' : 'alice-token', quotaFreshnessMs: 60_000,
            nowMs: () => 1_000, applyGeneration: async () => ({ ok: true }),
          });
          return await coordinator.switchAfterClassifiedFailure({ serviceId: service, groupId: selection.groupId,
            reason: 'plan', limitCategory: 'plan_invalid', quotaScope: 'model', providerLimitId: modelId,
            observedProfileId: selection.activeProfileId, rejectedStart: true,
            expectedFailureSource: { profileId: selection.activeProfileId, groupGeneration: selection.generation,
              credentialRevision: selection.credentialRevision!, isCurrent } });
        },
        registerRunTargets: registration => { registry.registerRunTarget({ ...registration, pid: registration.runnerPid }); },
        unregisterRunTargets: runKey => { registry.unregisterRunKey(runKey); },
        resolveRunMaterializedRoot: ({ runKey, agentId, parentSessionId }) => resolveConnectedServiceMaterializedRootDir({
          baseDir: resolveBaseDir(parentSessionId), materializationKey: runKey, agentId }),
        createAdoptedRootCleanup: ({ runKey, agentId, materializedRoot, parentSessionId }) => createAdoptedExecutionRunRootCleanup({
          materializationBaseDir: resolveBaseDir(parentSessionId), materializationKey: runKey, agentId, materializedRoot,
          removeRoot: async root => { await rm(root, { recursive: true, force: true }); },
        }),
        purposeBindingOwner: { activatePurposeBindings: (input, context) => accountContexts.get(
          context?.parentSessionId === 'bob-session' ? 'bob' : 'alice')!.purposes.activatePurposeBindings(input) },
        requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(),
        resolveRequestAuthHttpPort: () => 42427,
        createRedactionLease: () => ({ add() {}, close() {} }), clearTerminalCleanupReceipt: async () => undefined,
      });
      const result = await bridge.materialize({ runId: 'bob-run', runnerPid: process.pid, agentId: 'codex', cwd: runtime.happyHomeDir,
        connectedServices: { v: 2, bindingsByServiceId: { 'happier.agent.codex/openai-codex': {
          source: 'connected', selection: 'profile', profileId: 'work',
        } } } });
      if (!result.ok) throw new Error(result.errorMessage);
      expect(result).toMatchObject({ ok: true });
      expect(authenticatedCredentialAccounts).toContain('bob');
      expect(authenticatedCredentialAccounts).not.toContain('alice');
      const nativeHome = result.env.CODEX_HOME;
      if (!nativeHome) throw new Error('The Run did not materialize its native auth home');
      expect(await readFile(join(nativeHome, 'auth.json'), 'utf8')).toContain('bob-subscription');
      expect(result.registration.materializedRoot).toBe(resolveConnectedServiceMaterializedRootDir({
        baseDir: resolveBaseDir('bob-session'), materializationKey: 'bob-run', agentId: 'codex',
      }));
      expect(registry.getRunTargetByRunKey('bob-run')?.sessionId).toBe('bob-session');
      await bridge.release({ runId: 'bob-run', runnerPid: process.pid, activationId: result.activationId });
      await expect(access(nativeHome)).rejects.toThrow();
      await expect(readFile(join(aliceRoot, 'custodian-sentinel'), 'utf8')).resolves.toBe('alice-private');
      const grouped = await bridge.materialize({ runId: 'bob-group-run', runnerPid: process.pid, agentId: 'codex',
        cwd: runtime.happyHomeDir, modelId: 'requested-model', connectedServices: { v: 2, bindingsByServiceId: {
          'happier.agent.codex/openai-codex': { source: 'connected', selection: 'group', groupId: 'main', profileId: 'work' },
        } } });
      if (!grouped.ok) throw new Error(grouped.errorMessage);
      expect(grouped).toMatchObject({ ok: true });
      await expect(bridge.recoverRejectedStart({ runId: 'bob-group-run', runnerPid: process.pid,
        activationId: grouped.activationId, modelId: 'requested-model', classification: {
          kind: 'plan', serviceId: 'happier.agent.codex/openai-codex', profileId: 'work', groupId: 'main', groupGeneration: 7,
          expectedCredentialRevision: revision, limitCategory: 'plan_invalid', quotaScope: 'model',
          providerLimitId: 'requested-model', resetsAtMs: null, planType: null, rateLimits: null, source: 'structured_provider_error',
        } })).resolves.toEqual({ ok: true, retry: true });
      expect(groups.get('bob')?.activeConnectedAccountId).toBe('backup');
      expect(groups.get('alice')?.activeConnectedAccountId).toBe('work');
      await bridge.release({ runId: 'bob-group-run', runnerPid: process.pid, activationId: grouped.activationId });
      // A replacement daemon takes custody of an already-materialized native root.
      await mkdir(nativeHome, { recursive: true });
      await writeFile(join(nativeHome, 'auth.json'), 'retained-bob-secret');
      await expect(bridge.adoptLiveMaterialization({ runId: 'bob-run', runnerPid: process.pid,
        sessionId: 'bob-session', persistedLaunch: result.registration })).resolves.toBe(true);
      runnerCurrent = false;
      await bridge.releaseForRunnerExit({ runnerPid: process.pid, runnerIdentity });
      await expect(access(nativeHome)).rejects.toThrow();
      await expect(readFile(join(aliceRoot, 'custodian-sentinel'), 'utf8')).resolves.toBe('alice-private');
      // Cold terminal cleanup uses the exact retained parent Session without
      // admitting work or borrowing the custodian root after requester loss.
      await mkdir(nativeHome, { recursive: true });
      await writeFile(join(nativeHome, 'auth.json'), 'retired-bob-secret');
      const receipt = { v: 1, runKey: 'bob-run', agentId: 'codex', activationId: result.activationId };
      await expect(bridge.cleanupTerminalMaterialization({ runId: 'bob-run', runnerPid: process.pid,
        sessionId: null, receipt })).resolves.toBe(false);
      await expect(readFile(join(nativeHome, 'auth.json'), 'utf8')).resolves.toBe('retired-bob-secret');
      await expect(bridge.cleanupTerminalMaterialization({ runId: 'bob-run', runnerPid: process.pid,
        sessionId: 'bob-session', receipt })).resolves.toBe(true);
      await expect(access(nativeHome)).rejects.toThrow();
      await expect(readFile(join(aliceRoot, 'custodian-sentinel'), 'utf8')).resolves.toBe('alice-private');
    } finally { await runtime.dispose(); }
  });
});
