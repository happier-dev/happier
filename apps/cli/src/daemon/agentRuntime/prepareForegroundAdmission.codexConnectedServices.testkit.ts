import axios, { AxiosHeaders, type AxiosResponse } from 'axios';
import { join } from 'node:path';
import { vi } from 'vitest';
import {
  sealQualifiedConnectedAccountContentEnvelope,
  openQualifiedConnectedAccountContentEnvelope,
  parseQualifiedConnectedAccountCredentialPlaintextV1,
  QualifiedConnectedAccountListResponseV4Schema,
  ConnectedServiceBindingsV2IngressSchema,
} from '@happier-dev/protocol';

import { ApiClient } from '@/api/api';
import { parseQualifiedConnectedAccountV4StructuredQueryValue } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4QueryCodec';
import { QualifiedConnectedAccountRefSchema } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { listQualifiedConnectedAccountsV4, readQualifiedConnectedAccountCredentialV4 } from '@/api/client/qualifiedConnectedAccountApi';
import { configuration } from '@/configuration';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { resolveConnectedServiceAuthForSpawn } from '@/daemon/connectedServices/resolveConnectedServiceAuthForSpawn';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import type { PrepareForegroundAgentRuntimeAdmissionDependencies } from './prepareForegroundAdmission';
import { createForegroundPurposeOwnerFixture } from './prepareForegroundAdmission.connectedServices.testkit';

/** Real Codex codecs, revision parsing and launch materialization over Account HTTP. */
export async function createCodexForegroundConnectedAccountFixture(accountIds: readonly string[] = ['work']) {
  return await createForegroundConnectedAccountFixture(accountIds, 'codex');
}

export async function createClaudeForegroundConnectedAccountFixture(accountIds: readonly string[] = ['work']) {
  return await createForegroundConnectedAccountFixture(accountIds, 'claude');
}

async function createForegroundConnectedAccountFixture(accountIds: readonly string[], agentId: 'codex' | 'claude') {
  const accountId = accountIds[0]!;
  const pluginId = `happier.agent.${agentId}`;
  const service = { pluginId, localId: agentId === 'claude' ? 'claude-subscription' : 'openai-codex' };
  const revision = 'csr_0123456789ABCDEFGHJKMNPQRS';
  const content = sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain',
    payload: { v: 1, values: { accessToken: 'work-access', refreshToken: 'work-refresh', idToken: 'work-id', providerAccountId: 'work-account' } },
    randomBytes: length => new Uint8Array(length),
  });
  const accounts = QualifiedConnectedAccountListResponseV4Schema.parse({
    service, accounts: accountIds.map(id => ({
      ref: { service, accountId: id }, status: 'connected', authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned', credentialRevision: revision,
      configurationReady: true, configurationRevision: 'configuration-1', scopes: [],
    })),
  });
  const requestPaths: string[] = [];
  vi.spyOn(axios, 'get').mockImplementation(async (url): Promise<AxiosResponse<unknown>> => {
    const parsedUrl = new URL(String(url));
    const path = parsedUrl.pathname;
    requestPaths.push(path);
    const data = path === '/v4/connect/qualified/accounts' ? accounts
      : path === '/v1/account/encryption' ? { mode: 'plain', updatedAt: 0 }
        : path === `/v2/connect/${service.localId}/profiles`
          ? { serviceId: service.localId, profiles: accountIds.map(id => ({ profileId: id, status: 'connected', kind: 'oauth' })) }
          : path === '/v4/connect/qualified/credential'
            ? {
                ref: parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountRefSchema, parsedUrl.searchParams.get('ref')),
                authenticationModeId: 'oauth', configurationRevision: null,
                content, metadata: { providerIdentity: { accountId: 'work-account' }, displayName: 'work', scopes: [] },
                revisionSemantics: 'revisioned', credentialRevision: revision,
              }
            : (() => { throw new Error(`Unexpected Account HTTP request: ${path}`); })();
    return { status: 200, statusText: 'OK', data, headers: {}, config: { headers: new AxiosHeaders() } };
  });
  const credentials = { token: 'account-token', encryption: null } as const;
  const api = await ApiClient.create(credentials);
  const readAccounts = async () => await listQualifiedConnectedAccountsV4({ token: credentials.token, service });
  const readCredential = async (selectedAccountId = accountId) => {
    const credential = await readQualifiedConnectedAccountCredentialV4({ token: credentials.token, ref: { service, accountId: selectedAccountId } });
    if (!credential) throw new Error('Exact Account credential unavailable');
    if (credential.authenticationModeId !== 'oauth') throw new Error('Exact Account OAuth credential unavailable');
    return { ...credential, authenticationModeId: credential.authenticationModeId };
  };
  let registry: ResolvedExecutablePluginRuntimeRegistry | null = null;
  const account = createForegroundPurposeOwnerFixture({
    consumer: { pluginId, localId: agentId }, service, accountId,
    ...(agentId === 'claude' ? { purpose: 'model_upstream' } : {}),
    resolveTarget: async (target) => {
      if (target.kind !== 'account') return null;
      const found = (await readAccounts()).accounts.find(candidate => candidate.ref.accountId === target.account.accountId);
      return found ? { displayName: found.ref.accountId, account: found.ref } : null;
    },
    resolveCredentialRevision: async (selectedAccount) => {
      const credential = await readCredential(selectedAccount.accountId);
      return credential.revisionSemantics === 'revisioned' ? credential.credentialRevision : null;
    },
    materializeAccount: async ({ account, credentialRevisionBasis, request, signal }) => {
      const credential = await readCredential(account.accountId);
      if (credential.revisionSemantics !== 'revisioned' || !credential.credentialRevision) throw new Error('Ongoing purpose authority requires a credential revision');
      const credentialRevision = credential.credentialRevision;
      credentialRevisionBasis?.captureCredentialRevision(credentialRevision);
      const invoker = registry?.connectedAccountRuntimeInvoker;
      if (!invoker) throw new Error('Applied Agent materializer unavailable');
      const plaintext = openQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain', envelope: credential.content });
      const values = parseQualifiedConnectedAccountCredentialPlaintextV1({ ref: credential.ref,
        authenticationModeId: credential.authenticationModeId, plaintext, metadata: credential.metadata }).values;
      return await invoker.invokeEstablished({
        target: { account, expectedCredentialRevision: credentialRevision, expectedRuntimeConfigurationRevision: 'configuration-1' },
        operation: { kind: 'materialize', request },
        context: {
          account,
          configuration: { target: { kind: 'account', account, modeId: 'oauth' }, revision: 'configuration-1', values: {}, getSecret: async () => null },
          credentials: { get: async (key) => values[key] ?? null },
        },
        isConfigurationCurrent: async () => (await readAccounts()).accounts.some(candidate => candidate.ref.accountId === account.accountId && candidate.configurationRevision === 'configuration-1'),
        isCredentialRevisionCurrent: async () => (await readCredential(account.accountId)).credentialRevision === credentialRevision,
        signal,
      });
    },
  });
  const requestAuthRegistry = createConnectedAccountRequestAuthSubjectRegistry();
  const materializations: NonNullable<Awaited<ReturnType<typeof resolveConnectedServiceAuthForSpawn>>>[] = [];
  return {
    ...account, service, revision, requestPaths, requestAuthRegistry, api, credentials,
    connectedServices: ConnectedServiceBindingsV2IngressSchema.parse({ v: 2, bindingsByServiceId: {
      [`${pluginId}/${service.localId}`]: { source: 'connected', selection: 'profile', profileId: accountId },
    } }),
    runtimeOptions: {
      pluginIds: [pluginId], connectedAccounts: account.owner,
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
