import { describe, expect, it, onTestFinished, vi } from 'vitest';
import fastify from 'fastify';
import type { ApiClient } from '@/api/api';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { QualifiedConnectedAccountCredentialSnapshotV4Schema, QualifiedConnectedAccountCredentialHealthPatchV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { museAccountDescriptor, MUSE_ACCOUNT_SERVICE } from '../../../../../packages/plugins/muse/src/connectedAccounts/declarations';
import { museConnectedAccountRuntime } from '../../../../../packages/plugins/muse/src/connectedAccounts/museAccountRuntime';
import { createConnectedAccountHostRuntimeInvoker } from '@/plugins/runtime/connectedAccounts/runtimeInvoker';
import { createPluginInvocationServiceBinding } from '@/plugins/runtime/invocation/services/factory';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { mutateQualifiedConnectedAccountCredentialHealthV4 } from '@/api/client/qualifiedConnectedAccountApi';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { logger } from '@/utils/logger';
import { createQualifiedConnectedAccountEstablishedRuntimeOwner } from './qualifiedConnectedAccountEstablishedRuntimeOwner';
import { ConnectedServiceRefreshCoordinator } from './refresh/ConnectedServiceRefreshCoordinator';

// Real Muse status/material acquisition and spawn preflight; only Home/registry/service boundaries are supplied.
describe('Muse derived export publication', () => {
  it.each([
    { status: 409, code: 'connect_credential_mutation_superseded', reason: 'credential_revision_mismatch' },
    { status: 503, code: 'database_transaction_timeout', reason: undefined },
  ] as const)('keeps credential acquisition and spawn ready after Home$status with the typed failure visible', async failure => {
    const warn = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const account = { service: MUSE_ACCOUNT_SERVICE, accountId: 'dummy-muse-account' };
    const revision = 'csr_abcdefghijklmnopqrstuv';
    let snapshot = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
      ref: account, authenticationModeId: 'native-import', revisionSemantics: 'revisioned',
      credentialRevision: revision, configurationRevision: null,
      metadata: { kind: 'oauth', scopes: [] }, health: { v: 1, status: 'connected', reconnectRequired: false },
      content: sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain',
        payload: { v: 1, values: { credentialMode: 'native', nativeMechanism: '\"oauth\"',
          accountToken: 'dummy-access-token', expiresAtMs: '9999999999999' } },
        randomBytes: length => new Uint8Array(length) }),
    });
    const home = fastify();
    let exportAttempts = 0;
    home.patch('/v4/connect/qualified/credential/health', async (request, reply) => {
      const patch = QualifiedConnectedAccountCredentialHealthPatchV4Schema.parse(request.body);
      expect(patch.ref).toEqual(account);
      expect(patch.expectedCredentialRevision).toBe(revision);
      if (patch.exportProjection) {
        exportAttempts++;
        return reply.code(failure.status).send(failure.status === 409
          ? { error: failure.code, reason: failure.reason, credentialRevision: revision, configurationRevision: null }
          : { error: failure.code });
      }
      snapshot = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ...snapshot, health: patch.health });
      return { success: true, credentialRevision: revision, configurationRevision: null };
    });
    await home.ready();
    const restoreHttp = installAxiosFastifyAdapter({ app: home, origin: resolveServerHttpBaseUrl() });
    onTestFinished(async () => { restoreHttp(); await home.close(); });
    const lease = { ref: account.service, descriptor: { id: account.service.localId, ...museAccountDescriptor },
      occurrenceId: createPluginRuntimeOccurrenceId(account.service.pluginId), runtime: museConnectedAccountRuntime,
      // Muse's runtime is a Plugin runtime, so it runs in the Plugin realm.
      sourceCustody: { kind: 'managed' as const, immutableGenerationId: 'muse-fixture', installSource: 'archive' as const },
      isCurrent: () => true };
    const invoker = createConnectedAccountHostRuntimeInvoker({ resolveRuntime: async () => lease,
      resolvePlugin: () => ({ version: '1.0.0', hostAccessRequests: [] }),
      resolveHostPolicy: () => ({ hostAccess: [], serviceBinding: createPluginInvocationServiceBinding('fixture', 'fixture') }),
      // Muse's local status consumes no platform services.
      createServices: () => ({}) as PluginInvocationContext['services'], registerRawForRedaction() {},
    });
    const credentials = { token: 'dummy-home-token', encryption: null };
    const readCredential = async () => snapshot;
    const owner = createQualifiedConnectedAccountEstablishedRuntimeOwner({
      credentials, getAccountEncryptionMode: async () => 'plain', readCredential,
      readConfiguration: async () => null,
      reloadController: { acquireRuntimeRegistry: async () => ({ registry: {
        connectedAccountContributions: { describe: () => ({ ...lease }) },
        resolveConnectedAccountRuntime: async () => lease, connectedAccountRuntimeInvoker: invoker,
      }, release: async () => {} }), isRuntimeRegistryCurrent: () => true },
      configuration: { read: async () => null, secrets: { admit: async () => {}, has: async () => false, read: async () => null } },
    });
    const coordinator = new ConnectedServiceRefreshCoordinator({
      // The qualified path uses Home HTTP below; legacy API must not be reached.
      api: {} as ApiClient, credentials, machineIdProvider: () => 'dummy-machine',
      activeServerDir: '/unused/active', baseDir: '/unused/materialized',
      now: Date.now, refreshWindowMs: 60_000, refreshLeaseMs: 30_000,
      qualifiedConnectedAccountRuntime: { resolvePeerClass: () => 'advertised_v4', establishedRuntimeOwner: owner,
        readCredential, mutateCredentialHealth: mutateQualifiedConnectedAccountCredentialHealthV4,
        acquireRefreshLease: async () => { throw new Error('No OAuth refresh expected'); },
        mutateCredential: async () => { throw new Error('No credential mutation expected'); } },
    });
    const result = await coordinator.refreshQualifiedConnectedAccountCredentialForSpawnPreflight({ profile: {
      ref: account, status: 'connected', authenticationModeId: 'native-import', kind: 'oauth',
      revisionSemantics: 'revisioned', credentialRevision: revision, configurationRevision: null,
      configurationReady: true, expiresAt: null, displayName: 'Muse', scopes: [],
    } });
    expect(result).toMatchObject({ status: 'ready' });
    const acquired = await owner.readMaterialSnapshot({ account });
    expect(acquired.credential.values.accountToken).toBe('dummy-access-token');
    await expect(owner.refreshExportProjection({ account })).resolves.toBeUndefined();
    expect(snapshot.exportProjection).toBeUndefined();
    expect(exportAttempts).toBe(3); // One per natural operation; failed publication schedules no retry.
    expect(warn.mock.calls).toEqual(Array(3).fill([
      '[CONNECTED ACCOUNT] Export projection publication failed',
      { directExportFailure: { status: failure.status, code: failure.code, ...(failure.reason ? { reason: failure.reason } : {}) } },
    ]));
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/dummy-access-token|dummy-home-token|dummy-muse-account/);
  });
});
