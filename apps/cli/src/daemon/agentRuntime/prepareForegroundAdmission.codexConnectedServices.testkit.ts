import axios, { AxiosHeaders, type AxiosResponse } from 'axios';
import { join } from 'node:path';
import { vi } from 'vitest';
import {
  buildConnectedServiceCredentialRecord,
  QualifiedConnectedAccountListResponseV4Schema,
} from '@happier-dev/protocol';

import { ApiClient } from '@/api/api';
import { listQualifiedConnectedAccountsV4 } from '@/api/client/qualifiedConnectedAccountApi';
import { configuration } from '@/configuration';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { resolveConnectedServiceAuthForSpawn } from '@/daemon/connectedServices/resolveConnectedServiceAuthForSpawn';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import type { PrepareForegroundAgentRuntimeAdmissionDependencies } from './prepareForegroundAdmission';
import { createForegroundPurposeOwnerFixture } from './prepareForegroundAdmission.connectedServices.testkit';

/** Real Codex codecs, revision parsing and launch materialization over Account HTTP. */
export async function createCodexForegroundConnectedAccountFixture() {
  const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' } as const;
  const revision = 'csr_0123456789ABCDEFGHJKMNPQRS';
  const record = buildConnectedServiceCredentialRecord({
    now: Date.now(), serviceId: 'openai-codex', profileId: 'work', kind: 'oauth', expiresAt: null,
    oauth: {
      accessToken: 'work-access', refreshToken: 'work-refresh', idToken: 'work-id',
      scope: null, tokenType: 'Bearer', providerAccountId: 'work-account', providerEmail: null,
    },
  });
  const accounts = QualifiedConnectedAccountListResponseV4Schema.parse({
    service, accounts: [{
      ref: { service, accountId: 'work' }, status: 'connected', authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned', credentialRevision: revision,
      configurationReady: true, configurationRevision: 'configuration-1', scopes: [],
    }],
  });
  const requestPaths: string[] = [];
  vi.spyOn(axios, 'get').mockImplementation(async (url): Promise<AxiosResponse<unknown>> => {
    const path = new URL(String(url)).pathname;
    requestPaths.push(path);
    const data = path === '/v4/connect/qualified/accounts' ? accounts
      : path === '/v1/account/encryption' ? { mode: 'plain', updatedAt: 0 }
        : path === '/v2/connect/openai-codex/profiles'
          ? { serviceId: 'openai-codex', profiles: [{ profileId: 'work', status: 'connected', kind: 'oauth' }] }
          : path === '/v3/connect/openai-codex/profiles/work/credential'
            ? {
                content: { t: 'plain', v: record },
                revisionSemantics: 'revisioned', credentialRevision: revision,
              }
            : (() => { throw new Error(`Unexpected Account HTTP request: ${path}`); })();
    return { status: 200, statusText: 'OK', data, headers: {}, config: { headers: new AxiosHeaders() } };
  });
  const credentials = { token: 'account-token', encryption: null } as const;
  const api = await ApiClient.create(credentials);
  const readAccounts = async () => await listQualifiedConnectedAccountsV4({ token: credentials.token, service });
  const readCredential = async () => {
    const credential = await api.getConnectedServiceCredentialPlain({ serviceId: 'openai-codex', profileId: 'work' });
    if (!credential) throw new Error('Exact Account credential unavailable');
    return credential;
  };
  let registry: ResolvedExecutablePluginRuntimeRegistry | null = null;
  const account = createForegroundPurposeOwnerFixture({
    consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, service, accountId: 'work',
    resolveTarget: async (target) => {
      if (target.kind !== 'account') return null;
      const found = (await readAccounts()).accounts.find(candidate => candidate.ref.accountId === target.account.accountId);
      return found ? { displayName: found.ref.accountId, account: found.ref } : null;
    },
    resolveCredentialRevision: async () => {
      const credential = await readCredential();
      return credential.revisionSemantics === 'revisioned' ? credential.credentialRevision : null;
    },
    materializeAccount: async ({ account, credentialRevisionBasis, request, signal }) => {
      const credential = await readCredential();
      if (credential.revisionSemantics !== 'revisioned') throw new Error('Ongoing purpose authority requires a credential revision');
      credentialRevisionBasis?.captureCredentialRevision(credential.credentialRevision);
      const invoker = registry?.connectedAccountRuntimeInvoker;
      if (!invoker) throw new Error('Applied Codex materializer unavailable');
      const oauth = credential.content.v.kind === 'oauth' ? credential.content.v.oauth : null;
      if (!oauth) throw new Error('Selected Account has no OAuth credential');
      const values = new Map<string, string | null>([
        ['accessToken', oauth.accessToken], ['refreshToken', oauth.refreshToken],
        ['idToken', oauth.idToken], ['providerAccountId', oauth.providerAccountId],
      ]);
      return await invoker.invokeEstablished({
        target: { account, expectedCredentialRevision: credential.credentialRevision, expectedRuntimeConfigurationRevision: 'configuration-1' },
        operation: { kind: 'materialize', request },
        context: {
          account,
          configuration: { target: { kind: 'account', account, modeId: 'oauth' }, revision: 'configuration-1', values: {}, getSecret: async () => null },
          credentials: { get: async (key) => values.get(key) ?? null },
        },
        isConfigurationCurrent: async () => (await readAccounts()).accounts.some(candidate => candidate.ref.accountId === account.accountId && candidate.configurationRevision === 'configuration-1'),
        isCredentialRevisionCurrent: async () => (await readCredential()).credentialRevision === credential.credentialRevision,
        signal,
      });
    },
  });
  const requestAuthRegistry = createConnectedAccountRequestAuthSubjectRegistry();
  const materializations: NonNullable<Awaited<ReturnType<typeof resolveConnectedServiceAuthForSpawn>>>[] = [];
  return {
    ...account, service, revision, requestPaths, requestAuthRegistry,
    connectedServices: { v: 1 as const, bindingsByServiceId: { 'openai-codex': { source: 'connected' as const, selection: 'profile' as const, profileId: 'work' } } },
    runtimeOptions: {
      pluginIds: ['happier.agent.codex'], connectedAccounts: account.owner,
      networkDependencies: { resolveNetworkAddresses: async () => ['1.1.1.1'] },
    },
    materializations,
    async dependenciesFor(applied: ResolvedExecutablePluginRuntimeRegistry, directory: string): Promise<PrepareForegroundAgentRuntimeAdmissionDependencies> {
      registry = applied;
      return {
        activateSessionPurposeBindings: account.owner.activateSessionPurposeBindings,
        resolveConnectedServiceAuthForSpawn: async (input) => {
          const materialized = await resolveConnectedServiceAuthForSpawn({
            ...input, credentials, api, activeServerDir: configuration.activeServerDir, baseDir: join(directory, 'materialized'),
            activateQualifiedPurposeBindings: (snapshot) => account.owner.activatePurposeBindings({
              subject: { kind: 'operation', operationId: 'foreground-materialize', consumer: account.purpose.consumer, isCurrent: () => pluginReloadController.isRuntimeRegistryCurrent(applied) },
              purposes: snapshot.purposes, bindings: snapshot.bindings,
            }),
          });
          if (materialized) materializations.push(materialized);
          return materialized;
        },
        resolveDaemonSpawnHooks: async (agentId) => {
          const entry = await applied.acquireAgentCatalogEntry?.(agentId);
          return await entry?.getDaemonSpawnHooks?.() ?? null;
        },
        connectedAccountRequestAuthRegistry: requestAuthRegistry,
        resolveConnectedAccountRequestAuthHttpPort: () => 43123,
      };
    },
    async cleanup() {
      const results = await Promise.allSettled(materializations.map(async (materialized) => {
        try { await materialized.cleanupOnExit?.(); }
        finally { await materialized.materializationPurposeLease?.dispose(); }
      }));
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    },
  };
}
