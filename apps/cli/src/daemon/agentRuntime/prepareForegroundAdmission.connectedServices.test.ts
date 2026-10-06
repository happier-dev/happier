import { afterEach, describe, expect, it, vi } from 'vitest';
import axios, { AxiosHeaders, type AxiosResponse } from 'axios';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  buildConnectedServiceCredentialRecord,
  buildQualifiedPluginContributionKey,
  QualifiedConnectedAccountListResponseV4Schema,
  QualifiedConnectedAccountPurposeBindingsV1Schema,
  PluginSourceCustodyV1Schema,
  type QualifiedConnectedAccountPurposeBindingsV1,
} from '@happier-dev/protocol';
import { ApiClient } from '@/api/api';
import { AgentRuntimeRunnerBootstrapV1Schema } from '@/agent/runtime/session/process/agentRuntimeRunnerProtocol';
import { listQualifiedConnectedAccountsV4 } from '@/api/client/qualifiedConnectedAccountApi';
import { configuration, reloadConfiguration } from '@/configuration';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { resolveQualifiedPurposeBindingSnapshotForAgentSpawn } from '@/daemon/connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { resolveConnectedServiceAuthForSpawn } from '@/daemon/connectedServices/resolveConnectedServiceAuthForSpawn';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { ForegroundAgentRuntimeAdmissionRequestV1Schema } from './foregroundAdmissionContract';
import { prepareForegroundAgentRuntimeAdmission } from './prepareForegroundAdmission';

describe('foreground Connected Account admission through the applied plugin runtime', () => {
  afterEach(() => vi.restoreAllMocks());

  it('admits a nonempty qualified binding matching the real Codex published purpose projection', async () => {
    await withTempDir('happier-foreground-qualified-services-', async (root) => {
      const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'CODEX_HOME']);
      const home = join(root, 'home');
      const nativeHome = join(root, 'persistent-codex-home');
      let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | null = null;
      let cleanupAdmission: (() => void | Promise<void>) | null = null;
      const materializationCleanup: { current: (() => void | Promise<void>) | null } = { current: null };
      try {
        await mkdir(nativeHome, { recursive: true });
        env.patch({ HAPPIER_HOME_DIR: home, CODEX_HOME: nativeHome });
        reloadConfiguration();
        const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' } as const;
        const revision = 'csr_0123456789ABCDEFGHJKMNPQRS';
        const record = buildConnectedServiceCredentialRecord({
          now: Date.now(), serviceId: 'openai-codex', profileId: 'work',
          kind: 'oauth', expiresAt: null,
          oauth: {
            accessToken: 'work-access', refreshToken: 'work-refresh', idToken: 'work-id',
            scope: null, tokenType: 'Bearer', providerAccountId: 'work-account', providerEmail: null,
          },
        });
        const accounts = QualifiedConnectedAccountListResponseV4Schema.parse({
          service,
          accounts: [{
            ref: { service, accountId: 'work' }, status: 'connected',
            authenticationModeId: 'oauth', revisionSemantics: 'revisioned',
            credentialRevision: revision, configurationReady: true,
            configurationRevision: 'configuration-1', scopes: [],
          }],
        });
        // Only the Account HTTP transport is replaced. Credential parsing,
        // purpose authorization, Codex codecs and private-file custody stay real.
        vi.spyOn(axios, 'get').mockImplementation(async (url): Promise<AxiosResponse<unknown>> => {
          const path = new URL(String(url)).pathname;
          const data = path === '/v4/connect/qualified/accounts' ? accounts
            : path === '/v1/account/encryption' ? { mode: 'plain', updatedAt: 0 }
              : path === '/v3/connect/openai-codex/profiles/work/credential'
                ? { content: { t: 'plain', v: record }, revisionSemantics: 'revisioned', credentialRevision: revision }
                : (() => { throw new Error(`Unexpected Account HTTP request: ${path}`); })();
          return { status: 200, statusText: 'OK', data, headers: {}, config: { headers: new AxiosHeaders() } };
        });
        const credentials = { token: 'account-token', encryption: null } as const;
        const api = await ApiClient.create(credentials);
        const readAccounts = async () => {
          const result = await listQualifiedConnectedAccountsV4({ token: credentials.token, service });
          return result;
        };
        const readCredential = async () => {
          const credential = await api.getConnectedServiceCredentialPlain({ serviceId: 'openai-codex', profileId: 'work' });
          if (!credential || credential.revisionSemantics !== 'revisioned') throw new Error('Revisioned fixture credential unavailable');
          return credential;
        };
        // This in-memory boundary models the durable Account settings store;
        // the actual purpose owner derives and retires all launch authority.
        let stored: QualifiedConnectedAccountPurposeBindingsV1 = { v: 1, bindings: [] };
        const listeners = new Set<() => void>();
        const owner = createConnectedAccountPurposeBindingOwner({
          store: {
            read: async () => stored,
            update: async (mutate) => {
              stored = mutate(stored);
              for (const listener of listeners) listener();
              return stored;
            },
            subscribe: (listener) => {
              listeners.add(listener);
              return { dispose: () => { listeners.delete(listener); } };
            },
          },
          selectTarget: async () => { throw new Error('Foreground launch must not prompt for another Account'); },
          resolveTarget: async (target) => {
            if (target.kind !== 'account') return null;
            const listed = await readAccounts();
            const found = listed.accounts.find(account => account.ref.accountId === target.account.accountId);
            return found ? { displayName: found.ref.accountId, account: found.ref } : null;
          },
          resolveCredentialRevision: async () => (await readCredential()).credentialRevision,
          materializeAccount: async ({ account, credentialRevisionBasis, request, signal }) => {
            const credential = await readCredential();
            credentialRevisionBasis?.captureCredentialRevision(credential.credentialRevision);
            const invoker = runtime?.registry.connectedAccountRuntimeInvoker;
            if (!invoker) throw new Error('Real Codex Connected Account runtime unavailable');
            const oauth = credential.content.v.kind === 'oauth' ? credential.content.v.oauth : null;
            if (!oauth) throw new Error('Exact selected OAuth credential unavailable');
            const values = new Map<string, string | null>([
              ['accessToken', oauth.accessToken], ['refreshToken', oauth.refreshToken],
              ['idToken', oauth.idToken], ['providerAccountId', oauth.providerAccountId],
            ]);
            return await invoker.invokeEstablished({
              target: { account, expectedCredentialRevision: credential.credentialRevision, expectedRuntimeConfigurationRevision: 'configuration-1' },
              operation: { kind: 'materialize', request },
              context: {
                account,
                configuration: {
                  target: { kind: 'account', account, modeId: 'oauth' },
                  revision: 'configuration-1', values: {}, getSecret: async () => null,
                },
                credentials: { get: async (key) => values.get(key) ?? null },
              },
              isConfigurationCurrent: async () => (await readAccounts()).accounts.some(candidate => candidate.ref.accountId === account.accountId && candidate.configurationRevision === 'configuration-1'),
              isCredentialRevisionCurrent: async () => (await readCredential()).credentialRevision === credential.credentialRevision,
              signal,
            });
          },
          projectTargetAccounts: async () => { throw new Error('Foreground launch does not list purpose Accounts'); },
          assertTargetAccountMaterializable: async () => { throw new Error('Foreground launch does not materialize a listed Account'); },
        });
        runtime = await createAdmittedPluginRuntimeFixture({
          happyHomeDir: home, controller: pluginReloadController,
          runtimeOptions: {
            pluginIds: ['happier.agent.codex'], connectedAccounts: owner,
            networkDependencies: { resolveNetworkAddresses: async () => ['1.1.1.1'] },
          },
        });
        const admittedSourceCustody = PluginSourceCustodyV1Schema.parse(
          runtime.registry.readPluginSourceCustody?.('happier.agent.codex'),
        );
        expect(admittedSourceCustody.kind).toBe('development');
        const admittedOccurrenceId = runtime.registry.readPluginOccurrenceId?.('happier.agent.codex');
        expect(admittedOccurrenceId).toEqual(expect.any(String));
        expect(admittedOccurrenceId).not.toBe('');
        const wireRequest = ForegroundAgentRuntimeAdmissionRequestV1Schema.parse({
          v: 1, attemptId: 'attempt-qualified', sessionId: 'session-qualified', foregroundPid: process.pid,
          directory: root, agentId: 'codex', backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
          connectedServices: { v: 1, bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } } },
        });
        const snapshot = resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
          agentId: 'codex', bindings: wireRequest.connectedServices!, contributions: runtime.registry.contributes,
        });
        expect(Object.keys(wireRequest.connectedServices!.bindingsByServiceId)).toEqual([buildQualifiedPluginContributionKey(service)]);
        const parsedPurposeBindings = QualifiedConnectedAccountPurposeBindingsV1Schema.parse({
          v: 1, bindings: snapshot?.bindings,
        });
        expect(snapshot?.bindings).toEqual(parsedPurposeBindings.bindings);
        expect(snapshot?.bindings).toEqual([{
          purpose: { consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'primary' },
          target: { kind: 'account', account: { service, accountId: 'work' } },
        }]);
        const admitted = await prepareForegroundAgentRuntimeAdmission({ ...wireRequest, machineId: 'machine-1' }, {
          activateSessionPurposeBindings: owner.activateSessionPurposeBindings,
          resolveConnectedServiceAuthForSpawn: async (input) => {
            const materialized = await resolveConnectedServiceAuthForSpawn({
              ...input, credentials, api, activeServerDir: configuration.activeServerDir, baseDir: join(root, 'materialized'),
              activateQualifiedPurposeBindings: (projection) => owner.activatePurposeBindings({
                subject: { kind: 'operation', operationId: 'foreground-materialize', consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, isCurrent: () => runtime?.controller.isRuntimeRegistryCurrent(runtime.registry) === true },
                purposes: projection.purposes, bindings: projection.bindings,
              }),
            });
            materializationCleanup.current = materialized ? async () => {
              await materialized.cleanupOnExit?.();
              await materialized.materializationPurposeLease?.dispose();
            } : null;
            return materialized;
          },
          resolveDaemonSpawnHooks: async (agentId) => {
            const entry = await runtime!.registry.acquireAgentCatalogEntry?.(agentId);
            return await entry?.getDaemonSpawnHooks?.() ?? null;
          },
          connectedAccountRequestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(),
          resolveConnectedAccountRequestAuthHttpPort: () => 43122,
        });
        expect(admitted, admitted.ok ? undefined : admitted.error.code).toMatchObject({ ok: true });
        if (!admitted.ok) throw new Error(admitted.error.code);
        const cleanup = admitted.prepared.cleanup;
        if (!cleanup) throw new Error('Expected admitted foreground runtime to own bootstrap cleanup');
        cleanupAdmission = cleanup;
        const bootstrapPath = admitted.prepared.authorization.bootstrapFilePath;
        const bootstrap = AgentRuntimeRunnerBootstrapV1Schema.parse(JSON.parse(await readFile(bootstrapPath, 'utf8')));
        const custody = runtime.registry.readPluginSourceCustody?.('happier.agent.codex');
        expect(custody).toBeTruthy();
        expect(bootstrap.descriptor.sourceCustody).toEqual(custody);
        await cleanup();
        cleanupAdmission = null;
        await expect(stat(bootstrapPath)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        try {
          try {
            await cleanupAdmission?.();
          } finally {
            try {
              await materializationCleanup.current?.();
            } finally {
              await runtime?.dispose();
            }
          }
        } finally {
          env.restore();
          reloadConfiguration();
        }
      }
    });
  });
});
