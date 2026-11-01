import { describe, expect, it, onTestFinished, vi } from 'vitest';
import axios from 'axios';
import fastify from 'fastify';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { verifyRequesterSessionCredentialBinding } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { sealConnectedAccountCatalogContentV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { PluginConnectedAccountDescriptorContributionV2Schema } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import { ConnectedServiceCredentialRecordV1Schema } from '@happier-dev/protocol/connect/connected-service-schemas';
import { QualifiedConnectedAccountCredentialSnapshotV4Schema, QualifiedConnectedAccountConfigurationSnapshotV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { openQualifiedConnectedAccountContentEnvelope, sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { parseQualifiedConnectedAccountCredentialPlaintextV1 } from '@happier-dev/protocol/connect/legacyConnectedServiceCompatibility';

import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { createLoggerAndEventsAvailablePluginInvocationServiceBinding } from '@/plugins/runtime/invocation/services/factory';
import { createConnectedAccountHostRuntimeInvoker } from '@/plugins/runtime/connectedAccounts/runtimeInvoker';
import {
  createConnectedAccountConfigurationOwner,
  type ConnectedAccountConfigurationRecord,
} from '@happier-dev/cli-common/connectedAccounts';
import type {
  ConnectedAccountHostRuntimeInvoker,
  ConnectedAccountRuntimeEstablishedInvocation,
} from '@/plugins/runtime/connectedAccounts/runtimeInvoker';

import {
  createQualifiedConnectedAccountEstablishedRuntimeOwner,
  readQualifiedConnectedAccountCredentialMaterial,
  readQualifiedConnectedAccountCredentialIdentity,
} from './qualifiedConnectedAccountEstablishedRuntimeOwner';
import { createQualifiedConnectedAccountDaemonPersistence } from './qualifiedConnectedAccountDaemonPersistence';
import { createDaemonConnectedAccountPurposeBindingRuntime } from './purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';
import { createConnectedAccountContributionRegistry } from '@/plugins/runtime/connectedAccounts/contributionRegistry';
import { HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1 } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { createDaemonQualifiedRequestAuthCallbacks } from './requestAuth/createDaemonQualifiedRequestAuthCallbacks';
import { scopeConnectedAccountPurposeBindingLease } from './purposeBindings/ConnectedAccountPurposeBindingOwner';
import { requireConnectedAccountCryptoMaterial, resolveConnectedAccountCryptoMaterial } from './accountScopedCryptoMaterial';
import type { StoredCredentials } from '@/persistence';
import { logger } from '@/utils/logger';
import { observeConnectedServiceMaterializationPhase } from './materialize/materializationPhase';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';

const service = Object.freeze({
  pluginId: 'happier.agent.codex',
  localId: 'openai-codex',
});
const account = Object.freeze({ service, accountId: 'account-1' });
const requestAuthCredentialRevision = 'csr_0123456789ABCDEFGHJKMNPQRS';
type QualifiedConnectedAccountCredentialSnapshotV4 = ReturnType<
  typeof QualifiedConnectedAccountCredentialSnapshotV4Schema.parse
>;
type QualifiedConnectedAccountConfigurationSnapshotV4 = ReturnType<typeof QualifiedConnectedAccountConfigurationSnapshotV4Schema.parse>;
const descriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse({
  id: service.localId,
  title: 'Acme',
  authentication: {
    defaultModeId: 'oauth',
    modes: [{
      id: 'oauth',
      kind: 'oauthAuthorizationCode',
      callbackUrl: 'https://provider.example/oauth/callback',
      pkce: 'required',
      outcomeReconciliation: 'none',
      configuration: {
        scope: 'account',
        changeBehavior: 'refresh',
        fields: [{
          id: 'endpoint',
          title: 'Endpoint',
          schema: { type: 'string', minLength: 1 },
          required: true,
        }, {
          id: 'clientSecret',
          title: 'Client secret',
          schema: { type: 'string', minLength: 1 },
          secret: true,
          required: true,
        }],
      },
    }],
  },
});

const originDescriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse({
  id: service.localId,
  title: 'Acme',
  authentication: {
    defaultModeId: 'oauth',
    modes: [{
      id: 'oauth',
      kind: 'oauthAuthorizationCode',
      callbackUrl: 'https://provider.example/oauth/callback',
      pkce: 'required',
      outcomeReconciliation: 'none',
      configuration: {
        scope: 'account',
        changeBehavior: 'refresh',
        fields: [{
          id: 'endpoint',
          title: 'Endpoint',
          schema: { type: 'string', minLength: 1 },
          semantic: 'connectedAccountOrigin',
          required: true,
        }, {
          id: 'label',
          title: 'Label',
          schema: { type: 'string' },
        }, {
          id: 'clientSecret',
          title: 'Client secret',
          schema: { type: 'string', minLength: 1 },
          secret: true,
          required: true,
        }],
      },
    }],
  },
});

function plainEnvelope(kind: 'credential' | 'configuration', payload: unknown) {
  return sealQualifiedConnectedAccountContentEnvelope({
    kind,
    accountMode: 'plain',
    payload,
    randomBytes: (length) => new Uint8Array(length),
  });
}

describe('createQualifiedConnectedAccountEstablishedRuntimeOwner', () => {
  it.each([['host', false], ['plugin', false], ['host', true], ['plugin', true]] as const)('verifies requester currentness at materialization boundaries rather than for every field (%s, configured=%s)', async (kind, configured) => {
    const diagnostics = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const ref = kind === 'host' ? HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1 : { pluginId: 'external.accounts', localId: 'token' };
    const target = { service: ref, accountId: 'account-1' };
    const definition = PluginConnectedAccountDescriptorContributionV2Schema.parse({
      id: ref.localId, title: 'Token', authentication: { defaultModeId: 'token', modes: [{
        id: 'token', kind: 'manual', outcomeReconciliation: 'none',
        fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }],
        ...(configured ? { configuration: {
          scope: 'account', changeBehavior: 'reconnect', fields: [
            { id: 'endpoint', title: 'Endpoint', schema: { type: 'string' }, required: true },
          ],
        } } : {}),
      }] },
    });
    let nativeEntered = false;
    let accountCurrent = true;
    let revokeAfterFields = false;
    let invokeNestedStatus = false;
    let invokeNestedSnapshot = false;
    let nestedSnapshotReturned = false;
    let revokeDuringSnapshot = false;
    let statusEntered = false;
    let revokeAfterStatusFields = false;
    let rotateAfterStatusFields: 'credential' | 'configuration' | undefined;
    let cancelStatus: AbortController | undefined;
    const nativeRuntime = {
      authentication: { modes: {} },
      refresh: async () => ({ status: 'connected' as const }),
      revoke: async () => ({ status: 'remoteUnsupported' as const }),
      status: async (context: Pick<Parameters<ConnectedAccountRuntime['status']>[0], 'credentials'>) => {
        statusEntered = true;
        const fields = await Promise.all(Array.from({ length: 5 }, (_, index) => context.credentials.get(`token${index}`)));
        if (fields.some(value => value !== 'native-token')) throw new Error('Credential unavailable');
        if (revokeAfterStatusFields) accountCurrent = false;
        if (rotateAfterStatusFields === 'credential') credentialRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
        if (rotateAfterStatusFields === 'configuration') configurationRevision = 'configuration-after-status';
        cancelStatus?.abort();
        return { status: 'connected' as const };
      },
      quota: async (context: Pick<Parameters<NonNullable<ConnectedAccountRuntime['quota']>>[0], 'credentials'>) => {
        if (await context.credentials.get('token0') !== 'native-token') throw new Error('Quota credential unavailable');
        return { observedAtMs: 1_000_000, limits: [{ id: 'window', used: 1, remaining: 9 }] };
      },
      async materialize(_request: unknown, context: Pick<Parameters<ConnectedAccountRuntime['materialize']>[1], 'credentials'>) {
        nativeEntered = true;
        const fields = await Promise.all(Array.from({ length: 5 }, (_, index) => context.credentials.get(`token${index}`)));
        if (revokeAfterFields) accountCurrent = false;
        if (invokeNestedStatus) {
          accountCurrent = false;
          await owner.invoke({ account: target, operation: { kind: 'status' } });
        }
        if (invokeNestedSnapshot) {
          accountCurrent = false;
          await owner.readMaterialSnapshot({ account: target });
          nestedSnapshotReturned = true;
        }
        return { kind: 'environment' as const, env: { TOKEN: fields.join(':') } };
      },
    };
    const runtimeLease = {
      ref, descriptor: definition, occurrenceId: createPluginRuntimeOccurrenceId(ref.pluginId), runtime: nativeRuntime, isCurrent: () => true,
      ...(kind === 'host'
        ? { owner: 'host' as const, sourceCustody: { kind: 'host' as const } }
        : { sourceCustody: { kind: 'managed' as const, immutableGenerationId: 'external-artifact', installSource: 'npm' as const } }),
    };
    const invoker = createConnectedAccountHostRuntimeInvoker({
      resolveRuntime: async () => runtimeLease,
      resolvePlugin: () => ({ version: '1.0.0', hostAccessRequests: [] }),
      resolveHostPolicy: () => ({ hostAccess: [], serviceBinding:
        createLoggerAndEventsAvailablePluginInvocationServiceBinding('authority-generation', 'producer', []) }),
      // This native leaf uses no platform services; all credential/currentness owners stay real.
      createServices: () => ({}) as PluginInvocationContext['services'],
      registerRawForRedaction() {},
    });
    const contributions = createConnectedAccountContributionRegistry({
      descriptors: kind === 'host' ? [] : [{ provenance: 'external', source: { kind: 'package' }, pluginId: ref.pluginId, definition }],
      activateOnDemand: async () => {},
      readRegistrations: () => [{ pluginId: ref.pluginId, localId: ref.localId,
        occurrenceId: runtimeLease.occurrenceId, runtime: nativeRuntime }],
      readPluginOccurrenceId: () => runtimeLease.occurrenceId,
      readPluginSourceCustody: () => ({ kind: 'managed', immutableGenerationId: 'external-artifact', installSource: 'npm' }),
      isPluginOccurrenceCurrent: () => true,
    });
    if (kind === 'host') {
      contributions.registerHostConnectedAccountRuntime({ ref, descriptor: definition, runtime: nativeRuntime });
      const contribution = contributions.describe(ref);
      if (!contribution) throw new Error('Missing fixture contribution');
      runtimeLease.occurrenceId = contribution.occurrenceId;
    }
    onTestFinished(() => contributions.dispose());
    const registry = { resolveConnectedAccountRuntime: async () => runtimeLease, connectedAccountRuntimeInvoker: invoker,
      connectedAccountContributions: contributions };
    const snapshot = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
      ref: target, authenticationModeId: 'token', revisionSemantics: 'revisioned',
      credentialRevision: requestAuthCredentialRevision, configurationRevision: configured ? 'fixture-configuration' : null,
      content: plainEnvelope('credential', { v: 1, values: Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`token${index}`, 'native-token'])) }), metadata: { scopes: [] },
    });
    let holdReads = false;
    let credentialRevision = requestAuthCredentialRevision;
    let configurationRevision: string | null = snapshot.configurationRevision;
    let credentialReads = 0;
    let credentialReadMs = 0;
    let accountCurrentnessChecks = 0;
    const home = fastify();
    const origin = 'http://established-requester.test';
    home.get('/v1/account/profile', async () => ({ id: 'account-1' }));
    home.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1, updatedAt: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null }));
    home.get('/v2/sessions/session', async () => {
      accountCurrentnessChecks += 1;
      return { session: createSessionRecordFixture({ id: 'session', encryptionMode: 'plain',
        ownerAccountId: 'account-1', metadata: '{}', dataEncryptionKey: null,
        share: accountCurrent ? null : { accessLevel: 'view', canApprovePermissions: false } }) };
    });
    await home.ready();
    const restoreHttp = installAxiosFastifyAdapter({ app: home, origin });
    onTestFinished(async () => { restoreHttp(); await home.close(); });
    let admit: () => void = () => {};
    const admitted = new Promise<void>(resolve => { admit = resolve; });
    const pendingReads: Array<() => void> = [];
    let heldReadStarted: () => void = () => {};
    let heldRead = new Promise<void>(resolve => { heldReadStarted = resolve; });
    const owner = createQualifiedConnectedAccountEstablishedRuntimeOwner({
      // Plugin loading and Account HTTP authorities are system boundaries;
      // invocation, snapshot/currentness guards and configuration logic stay real.
      reloadController: {
        acquireRuntimeRegistry: async () => ({ registry, source: 'active', release: async () => {} }),
        isRuntimeRegistryCurrent: () => true,
      } as unknown as Pick<PluginReloadController, 'acquireRuntimeRegistry' | 'isRuntimeRegistryCurrent'>,
      credentials: { token: 'account-token', encryption: null }, getAccountEncryptionMode: async () => 'plain',
      isAccountRuntimeCurrent: () => verifyRequesterSessionCredentialBinding({
        credentials: { token: 'account-token', encryption: null }, sessionId: 'session',
        attribution: { serverId: 'home', accountId: 'account-1', machineId: 'machine', installationId: 'installation' },
        serverHttpBaseUrl: origin,
        // Machine admission is the external authority; all requester Account/Session verification stays real.
        verifyMachineAdmissionCurrent: async () => true,
      }),
      readCredential: async () => {
        const startedAt = performance.now();
        credentialReads += 1;
        if (holdReads) await new Promise<void>(resolve => { pendingReads.push(resolve); heldReadStarted(); });
        // Model latency only at the credential transport, leaving all internal guards real.
        await new Promise<void>(resolve => { setTimeout(resolve, 10); });
        credentialReadMs += performance.now() - startedAt;
        if (revokeDuringSnapshot) accountCurrent = false;
        return QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ...snapshot, credentialRevision, configurationRevision });
      },
      readConfiguration: async () => ({
        target: { kind: 'account', ref: target }, authenticationModeId: 'token', revisionSemantics: 'revisioned',
        credentialRevision, configurationRevision: 'fixture-configuration',
        configurationContent: plainEnvelope('configuration', { values: { endpoint: 'https://provider.example' }, secretRefs: {} }),
      }),
      configuration: { read: async () => null, secrets: {
        admit: async () => {}, has: async () => false, read: async () => null,
      } },
    });
    const startedAt = performance.now();
    const operation = observeConnectedServiceMaterializationPhase(
      { agentId: 'fixture-agent', materializationKey: `diagnostic-${kind}` },
      'native_home_credentials', () => owner.invokeWithReceipt({
        account: target, operation: { kind: 'materialize', request: { kind: 'environment', keys: ['TOKEN'] } },
        beforeInvoke: () => { holdReads = true; admit(); },
      }));
    try {
      // Drain admission without releasing the credential transport. Configuration
      // has no declared record here; its linkage belongs to this same credential row.
      await admitted;
      await heldRead;
      expect(nativeEntered).toBe(false);
      expect(pendingReads).toHaveLength(1);
      // One admitted cycle, independent of the number of fields or revision fences.
      expect(accountCurrentnessChecks).toBe(1);
    } finally {
      holdReads = false;
      for (const release of pendingReads) release();
      await expect(operation).resolves.toMatchObject({ result: { kind: 'environment', env: { TOKEN: Array(5).fill('native-token').join(':') } } });
      console.info('connected-account authority fixture', { kind, configured, accountCurrentnessChecks, credentialReads, credentialReadMs, elapsedMs: performance.now() - startedAt });
    }
    // A fresh completion verification refuses authority revoked during the callback.
    expect(accountCurrentnessChecks).toBe(2);
    // Initial snapshot, context admission, callback entry and one detached-result
    // settlement; plugin construction retains its additional policy fence.
    expect(credentialReads).toBe(kind === 'host' ? 4 : 5);
    // OAuth resource validation uses this public read before each request. It
    // is one preparation, just like materialization: nested field reads must
    // not each repeat the same Home/Machine/Session admission.
    const beforeSnapshot = accountCurrentnessChecks;
    const directSnapshot = await owner.readMaterialSnapshot({ account: target });
    expect(directSnapshot.credentialRevision).toBe(requestAuthCredentialRevision);
    expect(accountCurrentnessChecks - beforeSnapshot).toBe(2);
    const beforeSnapshotCheck = accountCurrentnessChecks;
    await expect(directSnapshot.isCurrent()).resolves.toBe(true);
    expect(accountCurrentnessChecks - beforeSnapshotCheck).toBe(2);
    revokeDuringSnapshot = true;
    await expect(owner.readMaterialSnapshot({ account: target })).rejects.toThrow('connected_account_runtime_not_current');
    accountCurrent = true;
    await expect(directSnapshot.isCurrent()).resolves.toBe(false);
    revokeDuringSnapshot = false;
    accountCurrent = true;
    const beforeStatus = accountCurrentnessChecks;
    await expect(owner.invoke({ account: target, operation: { kind: 'status' } }))
      .resolves.toMatchObject({ status: 'connected' });
    // Status consumes one immutable snapshot, with fresh entry and publication admission.
    expect(accountCurrentnessChecks - beforeStatus).toBe(2);
    const beforeNextStatus = accountCurrentnessChecks;
    await expect(owner.invoke({ account: target, operation: { kind: 'status' } }))
      .resolves.toMatchObject({ status: 'connected' });
    expect(accountCurrentnessChecks - beforeNextStatus).toBe(2);
    const beforeConcurrentRead = credentialReads;
    let preparedConsumers = 0;
    let releaseConsumers!: () => void;
    const consumersReady = new Promise<void>(resolve => { releaseConsumers = resolve; });
    const beforeInvoke = async () => { preparedConsumers += 1; await consumersReady; };
    const concurrent = owner.invokeScheduledWithReceipts({ account: target,
      status: { beforeInvoke }, quota: { beforeInvoke } });
    try {
      await vi.waitFor(() => expect(preparedConsumers).toBe(2));
      // Two due operations share only this invocation's initial pair.
      // Their callback/result currentness fences below still acquire fresh authority.
      expect(credentialReads - beforeConcurrentRead).toBe(1);
    } finally {
      releaseConsumers();
      await expect(concurrent).resolves.toMatchObject({ status: { status: 'fulfilled', value: { result: { status: 'connected' } } },
        quota: { status: 'fulfilled', value: { result: { limits: [{ id: 'window' }] } } } });
    }
    expect(credentialReads - beforeConcurrentRead).toBeGreaterThan(1);
    const beforeLaterPhase = credentialReads;
    await expect(owner.invokeScheduledWithReceipts({ account: target, status: {
      beforeInvoke: () => { expect(credentialReads - beforeLaterPhase).toBe(1); },
    } })).resolves.toMatchObject({ status: { status: 'fulfilled' } });
    for (const failed of ['status', 'quota'] as const) {
      const failure = new Error('Independent scheduled operation failure');
      const receipts = await owner.invokeScheduledWithReceipts({ account: target,
        status: failed === 'status' ? { beforeInvoke: () => { throw failure; } } : {},
        quota: failed === 'quota' ? { beforeInvoke: () => { throw failure; } } : {},
      });
      expect(receipts[failed]).toMatchObject({ status: 'rejected', reason: failure });
      expect(receipts[failed === 'status' ? 'quota' : 'status']).toMatchObject({ status: 'fulfilled' });
    }
    pendingReads.length = 0;
    holdReads = true;
    const cancelledConsumer = new AbortController();
    const cancellation = owner.invokeScheduledWithReceipts({ account: target,
      status: { signal: cancelledConsumer.signal }, quota: {} });
    try {
      await vi.waitFor(() => expect(pendingReads).toHaveLength(1));
      cancelledConsumer.abort(new Error('Quota consumer cancelled'));
    } finally {
      holdReads = false;
      for (const release of pendingReads) release();
      await expect(cancellation).resolves.toMatchObject({ status: { status: 'rejected' }, quota: { status: 'fulfilled' } });
    }
    for (const rotation of ['credential', 'configuration'] as const) {
      rotateAfterStatusFields = rotation;
      await expect(owner.invoke({ account: target, operation: { kind: 'status' } }))
        .rejects.toMatchObject({ code: 'connected_account_producer_result_stale' });
      credentialRevision = requestAuthCredentialRevision;
      configurationRevision = snapshot.configurationRevision;
    }
    rotateAfterStatusFields = undefined;
    revokeAfterStatusFields = true;
    await expect(owner.invoke({ account: target, operation: { kind: 'status' } }))
      .rejects.toThrow('connected_account_runtime_not_current');
    revokeAfterStatusFields = false;
    statusEntered = false;
    await expect(owner.invoke({ account: target, operation: { kind: 'status' } }))
      .rejects.toThrow('connected_account_runtime_not_current');
    expect(statusEntered).toBe(false);
    accountCurrent = true;
    cancelStatus = new AbortController();
    await expect(owner.invoke({ account: target, operation: { kind: 'status' }, signal: cancelStatus.signal }))
      .rejects.toBeDefined();
    cancelStatus = undefined;
    statusEntered = false;
    // File logging is an untyped system boundary; narrow its record payload before inspecting it.
    const phaseRows = diagnostics.mock.calls.flatMap(([message, fields]) =>
      message === '[CONNECTED ACCOUNT] Materialization phase' && fields && typeof fields === 'object'
        ? [fields as Record<string, unknown>] : [])
      .filter(row => row.materializationKey === `diagnostic-${kind}`);
    const outer = phaseRows.find(row => row.phase === 'native_home_credentials' && row.status === 'started');
    for (const phase of ['established_snapshots', 'established_registry', 'established_configuration',
      'established_runtime', 'runtime_configuration_currentness', 'runtime_credential_currentness',
      'runtime_callback_before', 'runtime_callback', 'runtime_callback_after', 'established_credential_read']) {
      const start = phaseRows.find(row => row.phase === phase && row.status === 'started');
      expect(start, phase).toBeDefined();
      expect(start?.parentPhaseId, phase).toEqual(expect.any(String));
      expect(phaseRows).toContainEqual(expect.objectContaining({ phaseId: start?.phaseId, status: 'completed' }));
    }
    expect(phaseRows).toContainEqual(expect.objectContaining({
      phase: 'established_snapshots', parentPhaseId: outer?.phaseId,
    }));
    expect(JSON.stringify(phaseRows)).not.toMatch(/native-token|account-token|csr_/);
    diagnostics.mockRestore();
    nativeEntered = false;
    pendingReads.length = 0;
    heldRead = new Promise<void>(resolve => { heldReadStarted = resolve; });
    let admitRotated: () => void = () => {};
    const rotatedAdmission = new Promise<void>(resolve => { admitRotated = resolve; });
    const rotated = owner.invokeWithReceipt({
      account: target, operation: { kind: 'materialize', request: { kind: 'environment', keys: ['TOKEN'] } },
      beforeInvoke: () => { holdReads = true; admitRotated(); },
    });
    try {
      await rotatedAdmission;
      await heldRead;
      expect(pendingReads).toHaveLength(1);
      credentialRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    } finally {
      holdReads = false;
      for (const release of pendingReads) release();
      await expect(rotated).rejects.toMatchObject({ code: 'connected_account_producer_result_stale' });
    }
    expect(nativeEntered).toBe(false);
    credentialRevision = requestAuthCredentialRevision;
    await expect(owner.invokeWithReceipt({
      account: target,
      operation: { kind: 'materialize', request: { kind: 'environment', keys: ['TOKEN'] } },
      // The bearer revision can remain unchanged while its configuration linkage changes.
      beforeInvoke: () => { configurationRevision = 'configuration-after-admission'; },
    })).rejects.toMatchObject({ code: 'connected_account_producer_result_stale' });
    expect(nativeEntered).toBe(false);
    configurationRevision = snapshot.configurationRevision;
    revokeAfterFields = true;
    const checksBeforeRevocation = accountCurrentnessChecks;
    await expect(owner.invokeWithReceipt({
      account: target, operation: { kind: 'materialize', request: { kind: 'environment', keys: ['TOKEN'] } },
    })).rejects.toThrow('connected_account_runtime_not_current');
    expect(nativeEntered).toBe(true);
    expect(accountCurrentnessChecks - checksBeforeRevocation).toBe(2);
    const checksBeforeNextCycle = accountCurrentnessChecks;
    await expect(owner.invokeWithReceipt({
      account: target, operation: { kind: 'materialize', request: { kind: 'environment', keys: ['TOKEN'] } },
    })).rejects.toThrow('connected_account_runtime_not_current');
    expect(accountCurrentnessChecks - checksBeforeNextCycle).toBe(1);
    accountCurrent = true;
    revokeAfterFields = false;
    invokeNestedStatus = true;
    await expect(owner.invokeWithReceipt({
      account: target, operation: { kind: 'materialize', request: { kind: 'environment', keys: ['TOKEN'] } },
    })).rejects.toThrow('connected_account_runtime_not_current');
    // Another public operation cannot borrow the materialization's admission.
    expect(statusEntered).toBe(false);
    accountCurrent = true;
    invokeNestedStatus = false;
    invokeNestedSnapshot = true;
    await expect(owner.invokeWithReceipt({
      account: target, operation: { kind: 'materialize', request: { kind: 'environment', keys: ['TOKEN'] } },
    })).rejects.toThrow('connected_account_runtime_not_current');
    expect(nestedSnapshotReturned).toBe(false);
  });
  it.each(['plain', 'e2ee'] as const)('records the union of MCP scope challenges through configuration CAS without changing credentials or secrets (%s)', async accountMode => {
    const accountCredentials: StoredCredentials = { token: 'account-token', encryption: accountMode === 'e2ee'
      ? { type: 'dataKey', publicKey: new Uint8Array(32), machineKey: new Uint8Array(32).fill(7) } : null };
    const envelope = (kind: 'credential' | 'configuration', payload: unknown) => accountMode === 'plain' ? plainEnvelope(kind, payload)
      : sealQualifiedConnectedAccountContentEnvelope({ kind, accountMode,
        material: requireConnectedAccountCryptoMaterial(accountCredentials, resolveConnectedAccountCryptoMaterial(accountCredentials)),
        payload, randomBytes: length => new Uint8Array(length) });
    const mcpAccount = { service: HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1, accountId: 'server-1' };
    const mcpDescriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse({
      id: 'mcp-sign-in', title: 'MCP server sign-in',
      authentication: { defaultModeId: 'oauth', modes: [{ id: 'oauth', kind: 'oauthAuthorizationCode',
        callbackUrl: 'https://app.happier.dev/oauth/mcp/callback', pkce: 'required', outcomeReconciliation: 'none',
        configuration: { scope: 'account', changeBehavior: 'refresh', fields: [
          { id: 'resource', title: 'Resource', schema: { type: 'string' }, required: true },
          { id: 'stepUpScopes', title: 'Scopes', schema: { type: 'array', items: { type: 'string' } } },
          { id: 'clientSecret', title: 'Client secret', schema: { type: 'string' }, secret: true },
        ] } }] },
    });
    const contributions = createConnectedAccountContributionRegistry({ descriptors: [],
      activateOnDemand: async () => {}, readRegistrations: () => [],
      readPluginOccurrenceId: () => null, readPluginSourceCustody: () => null, isPluginOccurrenceCurrent: () => false });
    contributions.registerHostConnectedAccountRuntime({ ref: mcpAccount.service, descriptor: mcpDescriptor,
      // No provider work is involved in scope reporting; these callbacks are never invoked.
      runtime: { authentication: { modes: {} }, refresh: async () => ({ status: 'connected' }),
        revoke: async () => ({ status: 'remoteUnsupported' }), status: async () => ({ status: 'connected' }),
        materialize: async () => ({ kind: 'environment', env: {} }) } });
    let credentialRevision = requestAuthCredentialRevision;
    let configurationRecord: ConnectedAccountConfigurationRecord = {
      revision: 'config-1', values: { resource: 'https://mcp.example.test/api', stepUpScopes: ['read'] },
      secretRefs: {}, secretValues: { clientSecret: 'retained-client-secret' },
    };
    const writes: Array<Readonly<{ expectedRevision: string | null; values: Readonly<Record<string, unknown>> }>> = [];
    let conflict = false;
    const configurationOwner = createConnectedAccountConfigurationOwner({
      read: async () => configurationRecord,
      replace: async input => {
        writes.push({ expectedRevision: input.expectedRevision, values: input.replacement.values });
        if (conflict || input.expectedRevision !== configurationRecord.revision) {
          return { status: 'conflict', code: 'connected_account_configuration_changed' };
        }
        configurationRecord = { ...input.replacement, revision: `config-${writes.length + 1}` };
        return { status: 'committed', record: configurationRecord };
      },
      destroyAttempt: async () => {}, secrets: { admit: async () => {}, has: async () => false, read: async () => null },
      isRuntimeCurrent: async () => true,
    });
    const registry = { connectedAccountContributions: contributions };
    // The reload boundary supplies the real contribution registry; no domain callback is substituted.
    const reloadController = { acquireRuntimeRegistry: async () => ({ registry, source: 'active', release: async () => {} }),
      isRuntimeRegistryCurrent: () => true, subscribe: () => () => {} } as unknown as Pick<PluginReloadController, 'acquireRuntimeRegistry' | 'isRuntimeRegistryCurrent' | 'subscribe'>;
    const owner = createQualifiedConnectedAccountEstablishedRuntimeOwner({
      reloadController,
      credentials: accountCredentials, getAccountEncryptionMode: async () => accountMode,
      readCredential: async () => QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
        ref: mcpAccount, authenticationModeId: 'oauth', revisionSemantics: 'revisioned', credentialRevision,
        configurationRevision: configurationRecord.revision, content: envelope('credential', { v: 1, values: { accessToken: 'unchanged' } }),
        metadata: { scopes: ['read'] },
      }),
      readConfiguration: async () => ({ target: { kind: 'account', ref: mcpAccount }, authenticationModeId: 'oauth',
        revisionSemantics: 'revisioned', credentialRevision, configurationRevision: configurationRecord.revision,
        configurationContent: envelope('configuration', { values: configurationRecord.values,
          secretRefs: configurationRecord.secretRefs, secretValues: configurationRecord.secretValues }) }),
      configuration: { read: async () => configurationRecord, secrets: { admit: async () => {}, has: async () => false, read: async () => null } },
      configurationOwner,
    });
    await expect(owner.recordScopeChallenge({ account: mcpAccount, expectedCredentialRevision: credentialRevision,
      requiredScopes: ['write', 'read', 'admin'] })).resolves.toEqual({ status: 'current_changed' });
    expect(configurationRecord.values).toEqual({ resource: 'https://mcp.example.test/api', stepUpScopes: ['read', 'write', 'admin'] });
    expect(configurationRecord.secretValues).toEqual({ clientSecret: 'retained-client-secret' });
    expect(writes[0]?.expectedRevision).toBe('config-1');
    await expect(owner.recordScopeChallenge({ account: mcpAccount, expectedCredentialRevision: credentialRevision,
      requiredScopes: ['write'] })).resolves.toEqual({ status: 'current_unchanged' });
    expect(writes).toHaveLength(1);
    credentialRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    await expect(owner.recordScopeChallenge({ account: mcpAccount, expectedCredentialRevision: requestAuthCredentialRevision,
      requiredScopes: ['different'] })).resolves.toEqual({ status: 'stale_context' });
    expect(writes).toHaveLength(1);
    conflict = true;
    await expect(owner.recordScopeChallenge({ account: mcpAccount, expectedCredentialRevision: credentialRevision,
      requiredScopes: ['different'] })).resolves.toEqual({ status: 'denied' });
    expect(configurationRecord.values.stepUpScopes).toEqual(['read', 'write', 'admin']);
    conflict = false;
    const purposes = createDaemonConnectedAccountPurposeBindingRuntime({ establishedRuntimeOwner: owner, reloadController,
      resolveQualifiedConnectedAccountV4Support: () => 'advertised', allowNativeAccountCredentials: false,
      store: { read: async () => ({ v: 1, bindings: [] }), update: async mutate => mutate({ v: 1, bindings: [] }),
        subscribe: () => ({ dispose() {} }) },
      qualifiedApi: { listAccounts: async service => ({ service, accounts: [] }), listGroups: async () => ({ groups: [] }), readGroup: async () => null },
    });
    const purpose = { consumer: { pluginId: 'happier.mcp', localId: 'remote-bridge' }, purpose: 'mcp-server' };
    const binding = { purpose, target: { kind: 'account' as const, account: mcpAccount } };
    const lease = purposes.activatePurposeBindings({ subject: { kind: 'mcp_request_auth', operationId: 'scope-challenge',
      serverId: mcpAccount.accountId, resource: 'https://mcp.example.test/api', isCurrent: () => true },
      purposes: [purpose], bindings: [binding] });
    const subject = scopeConnectedAccountPurposeBindingLease({ lease, subjectId: lease.subjectId, parentSessionId: 'requester-session',
      uses: [{ purpose, materialization: { kind: 'httpHeaders', origin: 'https://mcp.example.test', headerNames: ['authorization'] } }],
      registerRedaction: () => {} });
    let requesterCurrent = true;
    const callbacks = createDaemonQualifiedRequestAuthCallbacks({
      withSessionAccountContext: async (_sessionId, operation) => await operation(requesterCurrent
        ? { bootstrap: { serverHttpBaseUrl: 'https://requester.home.test' },
          isCurrent: async () => requesterCurrent, qualifiedConnectedAccountEstablishedRuntimeOwner: owner }
        : null),
    });
    const failure = { class: 'insufficient_scope' as const, requiredScopes: ['export'],
      evidence: { httpStatus: 403, limitCategory: 'validation_failed' as const, quotaScope: 'unknown' as const,
        evidenceSource: { kind: 'structured' as const } } };
    await expect(callbacks.reportScopeFailure!({ subject, resolved: { account: mcpAccount, credentialRevision },
      failure, signal: new AbortController().signal })).resolves.toEqual({ status: 'current_changed' });
    expect(configurationRecord.values.stepUpScopes).toEqual(['read', 'write', 'admin', 'export']);
    requesterCurrent = false;
    await expect(callbacks.reportScopeFailure!({ subject, resolved: { account: mcpAccount, credentialRevision },
      failure: { ...failure, requiredScopes: ['withdrawn'] }, signal: new AbortController().signal })).resolves.toEqual({ status: 'stale_context' });
    expect(configurationRecord.values.stepUpScopes).not.toContain('withdrawn');
    await lease.dispose();
    contributions.dispose();
  });
  it('establishes the current usage basis before provider quota work, including a failed first fetch', async () => {
    const failure = new Error('provider offline');
    let sourceReady = false;
    let providerCalls = 0;
    let runtimeCurrent = true;
    const runtime: ConnectedAccountRuntime = {
      authentication: { modes: {} },
      refresh: async () => ({ status: 'connected' }),
      revoke: async () => ({ status: 'remoteUnsupported' }),
      status: async () => ({ status: 'connected' }),
      materialize: async () => ({ kind: 'environment', env: {} }),
      quota: async () => {
        providerCalls += 1;
        expect(sourceReady).toBe(true);
        throw failure;
      },
    };
    const quotaDescriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse({
      id: service.localId,
      title: 'Quota test',
      authentication: { defaultModeId: 'token', modes: [{
        id: 'token', kind: 'manual', outcomeReconciliation: 'none',
        fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }],
      }] },
    });
    const runtimeLease = {
      ref: service,
      occurrenceId: createPluginRuntimeOccurrenceId(service.pluginId),
      sourceCustody: { kind: 'managed' as const, immutableGenerationId: 'quota-artifact', installSource: 'npm' as const },
      descriptor: quotaDescriptor,
      runtime,
      isCurrent: () => runtimeCurrent,
    };
    const invoker = createConnectedAccountHostRuntimeInvoker({
      resolveRuntime: async () => runtimeLease,
      resolvePlugin: () => ({ version: '1.0.0', hostAccessRequests: [] }),
      resolveHostPolicy: () => ({ hostAccess: [], serviceBinding:
        createLoggerAndEventsAvailablePluginInvocationServiceBinding('quota-generation', 'producer', []) }),
      // No platform service is used by this provider leaf; the real invoker owns its context.
      createServices: () => ({}) as PluginInvocationContext['services'],
      registerRawForRedaction() {},
    });
    const registry = {
      resolveConnectedAccountRuntime: async () => runtimeLease,
      connectedAccountRuntimeInvoker: invoker,
    };
    const release = vi.fn(async () => {});
    const owner = createQualifiedConnectedAccountEstablishedRuntimeOwner({
      reloadController: {
        acquireRuntimeRegistry: async () => ({ registry, source: 'active', release }),
        isRuntimeRegistryCurrent: () => true,
      } as unknown as Pick<PluginReloadController, 'acquireRuntimeRegistry' | 'isRuntimeRegistryCurrent'>,
      credentials: { token: 'token', encryption: null },
      getAccountEncryptionMode: async () => 'plain',
      readCredential: async () => QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
        ref: account, authenticationModeId: 'token', revisionSemantics: 'revisioned',
        credentialRevision: requestAuthCredentialRevision, configurationRevision: null,
        content: plainEnvelope('credential', { v: 1, values: { token: 'provider-token' } }),
        metadata: { scopes: [] },
      }),
      configuration: { read: async () => null, secrets: {
        admit: async () => {}, has: async () => false, read: async () => null,
      } },
    });
    await expect(owner.invokeWithReceipt({
      account,
      operation: { kind: 'quota' },
      beforeInvoke: async (basis) => {
        expect(basis.credentialRevision).toBe(requestAuthCredentialRevision);
        expect(basis.credentialConfigurationRevision).toBeNull();
        expect(basis.isCurrent()).toBe(true);
        sourceReady = true;
      },
    })).rejects.toBe(failure);
    expect(sourceReady).toBe(true);
    expect(release).toHaveBeenCalledOnce();
    const cancelled = new AbortController();
    await expect(owner.invokeWithReceipt({
      account,
      operation: { kind: 'quota' },
      signal: cancelled.signal,
      beforeInvoke: async () => { cancelled.abort(failure); },
    })).rejects.toBe(failure);
    expect(providerCalls).toBe(1);
    await expect(owner.invokeWithReceipt({
      account,
      operation: { kind: 'quota' },
      beforeInvoke: async () => { runtimeCurrent = false; },
    })).rejects.toBeInstanceOf(Error);
    expect(providerCalls).toBe(1);
    expect(release).toHaveBeenCalledTimes(3);
  });
  it('refuses credential material without an authentication mode before disclosing its payload', async () => {
    const snapshot = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
      ref: account,
      authenticationModeId: null,
      revisionSemantics: 'revisioned',
      credentialRevision: requestAuthCredentialRevision,
      configurationRevision: null,
      content: plainEnvelope('credential', {
        v: 1,
        values: { accessToken: 'unadmitted-access' },
      }),
      metadata: { scopes: [] },
    });

    await expect(readQualifiedConnectedAccountCredentialMaterial({
      credentials: { token: 'token-1', encryption: null },
      account,
      getAccountEncryptionMode: async () => 'plain',
      readCredential: async () => snapshot,
    })).rejects.toBeInstanceOf(Error);
  });

  it('feeds recipient-opened direct material through the installed contribution runtime without a source-row read', async () => {
    const invokeEstablished = vi.fn(async (input: ConnectedAccountRuntimeEstablishedInvocation) => {
      expect(await input.context.credentials.get('token')).toBe('recipient-direct-token');
      expect(input.context.configuration.revision).toBe('source-version-1');
      expect(input.context.configuration.values).toEqual({ endpoint: 'https://api.example.test' });
      expect(await input.context.configuration.getSecret('clientSecret')).toBe('recipient-direct-client-secret');
      expect(await input.isCredentialRevisionCurrent()).toBe(true);
      expect(await input.isConfigurationCurrent(input.context.configuration)).toBe(true);
      return { kind: 'environment', env: { ACME_TOKEN: 'recipient-direct-token' } };
    });
    const readCredential = vi.fn();
    const readConfiguration = vi.fn();
    const release = vi.fn(async () => undefined);
    const owner = createQualifiedConnectedAccountEstablishedRuntimeOwner({
      reloadController: {
        acquireRuntimeRegistry: vi.fn(async () => ({
          registry: {
            connectedAccountRuntimeInvoker: {
              invokeAuthentication: vi.fn(),
              invokeEstablished,
            },
            resolveConnectedAccountRuntime: vi.fn(async () => Object.freeze({
              ref: service,
              occurrenceId: 'generation-1',
              sourceCustody: {
                kind: 'managed',
                immutableGenerationId: 'external-plugin-artifact-1',
                installSource: 'npm',
              },
              descriptor,
              runtime: {},
              isCurrent: () => true,
            })),
          },
          source: 'active' as const,
          release,
        })),
        isRuntimeRegistryCurrent: vi.fn(() => true),
      } as unknown as Pick<
        PluginReloadController,
        'acquireRuntimeRegistry' | 'isRuntimeRegistryCurrent'
      >,
      credentials: { token: 'recipient-token', encryption: null },
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential,
      readConfiguration,
      configuration: {
        read: vi.fn(async () => null),
        secrets: {
          admit: vi.fn(async () => undefined),
          has: vi.fn(async () => false),
          read: vi.fn(async () => null),
        },
      },
    });
    let current = true;

    await expect(owner.invokeDirectMaterial({
      account,
      sourceVersion: 'source-version-1',
      material: {
        kind: 'qualified_connected_account',
        credential: { v: 1, values: { token: 'recipient-direct-token' } },
        configuration: {
          values: { endpoint: 'https://api.example.test' },
          secretValues: { clientSecret: 'recipient-direct-client-secret' },
        },
        authenticationModeId: 'oauth',
      },
      operation: { kind: 'materialize', request: { kind: 'environment', keys: ['ACME_TOKEN'] } },
      isCurrent: () => current,
    })).resolves.toEqual({
      kind: 'environment',
      env: { ACME_TOKEN: 'recipient-direct-token' },
    });

    current = false;
    expect(await invokeEstablished.mock.calls[0]?.[0].isCredentialRevisionCurrent()).toBe(false);
    expect(readCredential).not.toHaveBeenCalled();
    expect(readConfiguration).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it.each(['account', 'service'] as const)('returns a fully resolved %s configuration snapshot fenced by source and contribution revisions', async (scope) => {
    let credentialRevision = requestAuthCredentialRevision;
    let contributionCurrent = true;
    let configurationSecret = 'resolved-configuration-secret';
    let configurationFingerprint = 'saved-secret-record:v1:original';
    let configurationAvailable = true;
    let serviceCatalogAvailable = true;
    let serviceCatalogRevision = 1;
    let serviceConfiguration = {
      service, modeId: 'manual-token', revision: 'service-configuration-1',
      values: { endpoint: 'https://api.example.test' },
      secretRefs: { clientSecret: 'happier:shared-secret:v1:configuration-secret' },
    };
    const directDescriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse({
      id: service.localId,
      title: 'Acme',
      authentication: {
        defaultModeId: 'manual-token',
        modes: [{
          id: 'manual-token',
          kind: 'manual',
          outcomeReconciliation: 'none',
          fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }],
          configuration: {
            scope,
            changeBehavior: 'reconnect',
            fields: [
              { id: 'endpoint', title: 'Endpoint', schema: { type: 'string' }, required: true },
              { id: 'region', title: 'Region', schema: { type: 'string' }, default: 'us' },
              { id: 'clientSecret', title: 'Client secret', schema: { type: 'string' }, secret: true },
            ],
          },
        }],
      },
    });
    const credentialSnapshot = () => QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
      ref: account,
      authenticationModeId: 'manual-token',
      revisionSemantics: 'revisioned' as const,
      credentialRevision,
      configurationRevision: scope === 'account' ? 'configuration-1' : null,
      content: plainEnvelope('credential', {
        v: 1,
        values: { token: 'manual-token-1' },
      }),
      metadata: { scopes: [] },
    });
    const configurationSnapshot = (): QualifiedConnectedAccountConfigurationSnapshotV4 => ({
      target: { kind: 'account', ref: account },
      authenticationModeId: 'manual-token',
      revisionSemantics: 'revisioned',
      credentialRevision,
      configurationRevision: 'configuration-1',
      configurationContent: plainEnvelope('configuration', {
        values: { endpoint: 'https://api.example.test' },
        secretRefs: {},
        secretValues: { clientSecret: configurationSecret },
      }),
    });
    const acquireRuntimeRegistry = vi.fn(async () => ({
      registry: {
        connectedAccountContributions: {
          describe: vi.fn(() => Object.freeze({
            ref: service,
            descriptor: directDescriptor,
            occurrenceId: 'plugin-contract-1',
            sourceCustody: {
              kind: 'managed',
              immutableGenerationId: 'plugin-contract-1',
              installSource: 'npm',
            },
            isCurrent: () => contributionCurrent,
          })),
        },
      },
      source: 'active' as const,
      release: vi.fn(async () => undefined),
    }));
    const secrets = {
      admit: vi.fn(async () => undefined),
      has: vi.fn(async () => true),
      read: vi.fn(async () => configurationSecret),
      readMaterial: vi.fn(async () => configurationAvailable
        ? { value: configurationSecret, fingerprint: configurationFingerprint }
        : null),
    };
    const persistence = createQualifiedConnectedAccountDaemonPersistence({
      credentials: { token: 'token-1', encryption: null },
      getAccountEncryptionMode: async () => 'plain',
      readCredential: async () => credentialSnapshot(),
      readConfiguration: async () => configurationSnapshot(),
      mutateCredential: vi.fn(),
      mutateConfiguration: vi.fn(),
      secrets,
    });
    if (scope === 'service') {
      const credentials = { token: 'token-1', encryption: null };
      setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
      // Home HTTP stores the independent configuration row. Catalog opening,
      // Account admission and runtime configuration resolution remain real.
      const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
          mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        } };
        if (path === '/v1/account/entity-rows/connected-accounts/configurations') return serviceCatalogAvailable
          ? { status: 200, data: { status: 'present', revision: serviceCatalogRevision,
            content: sealConnectedAccountCatalogContentV1({ mode: 'plain', material: null,
              record: { key: 'configurations', value: { v: 1, entries: [serviceConfiguration] } } }) } }
          : { status: 503, data: {} };
        if (path === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: {} } } };
        if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
        throw new Error(`Unexpected configuration Home read: ${path}`);
      });
      onTestFinished(() => { get.mockRestore(); resetActiveAccountSettingsSnapshotForTests(); });
    }
    const owner = createQualifiedConnectedAccountEstablishedRuntimeOwner({
      reloadController: {
        acquireRuntimeRegistry,
        isRuntimeRegistryCurrent: vi.fn(() => contributionCurrent),
      } as unknown as Pick<
        PluginReloadController,
        'acquireRuntimeRegistry' | 'isRuntimeRegistryCurrent'
      >,
      credentials: { token: 'token-1', encryption: null },
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential: vi.fn(async () => credentialSnapshot()),
      readConfiguration: vi.fn(async () => configurationSnapshot()),
      configuration: {
        read: persistence.configuration.read,
        secrets,
      },
    });

    const snapshot = await owner.readMaterialSnapshot({ account });
    expect(snapshot).toMatchObject({
      authenticationModeId: 'manual-token',
      credentialRevision: requestAuthCredentialRevision,
      configurationRevision: scope === 'account' ? 'configuration-1' : null,
      contributionContractVersion: 'plugin-contract-1',
      configuration: {
        values: { endpoint: 'https://api.example.test', region: 'us' },
        secretValues: { clientSecret: 'resolved-configuration-secret' },
      },
    });
    await expect(snapshot.isCurrent()).resolves.toBe(true);
    configurationSecret = 'rotated-configuration-secret';
    configurationFingerprint = 'saved-secret-record:v1:rotated';
    await expect(snapshot.isCurrent()).resolves.toBe(false);
    if (scope === 'service') {
      const rotated = await owner.readMaterialSnapshot({ account });
      expect(rotated.serviceConfigurationFingerprint).not.toBe(snapshot.serviceConfigurationFingerprint);
      expect(rotated.configuration?.secretValues.clientSecret).toBe('rotated-configuration-secret');
      await expect(rotated.isCurrent()).resolves.toBe(true);
      serviceConfiguration = { ...serviceConfiguration, revision: 'service-configuration-2',
        values: { endpoint: 'https://updated.example.test' } };
      serviceCatalogRevision += 1;
      await expect(rotated.isCurrent()).resolves.toBe(false);
      const reconfigured = await owner.readMaterialSnapshot({ account });
      expect(reconfigured.serviceConfigurationFingerprint).not.toBe(rotated.serviceConfigurationFingerprint);
      expect(reconfigured.configuration?.values.endpoint).toBe('https://updated.example.test');
      serviceCatalogAvailable = false;
      await expect(owner.readMaterialSnapshot({ account })).rejects.toThrow();
      serviceCatalogAvailable = true;
      configurationAvailable = false;
      await expect(reconfigured.isCurrent()).resolves.toBe(false);
      await expect(owner.readMaterialSnapshot({ account })).rejects.toThrow();
      configurationAvailable = true;
    }
    configurationSecret = 'resolved-configuration-secret';
    configurationFingerprint = 'saved-secret-record:v1:original';
    credentialRevision = 'csr_1123456789ABCDEFGHJKMNPQRS';
    await expect(snapshot.isCurrent()).resolves.toBe(false);
    credentialRevision = requestAuthCredentialRevision;
    contributionCurrent = false;
    await expect(snapshot.isCurrent()).resolves.toBe(false);
  });

  it.each([undefined, { accountId: 'public-user', organizationId: 'public-org' }])('reads generic qualified identity only from canonical public metadata (%j)', (providerIdentity) => {
    const identity = readQualifiedConnectedAccountCredentialIdentity({
      storageMode: 'plain', credential: { v: 1, values: { providerAccountId: 'provider-private-value' } },
      snapshot: { ref: account, authenticationModeId: 'oauth', revisionSemantics: 'revisioned',
        credentialRevision: requestAuthCredentialRevision, configurationRevision: null,
        metadata: { scopes: [], ...(providerIdentity ? { providerIdentity } : {}) },
        content: { t: 'plain', v: { v: 1, values: {} } },
      },
    });
    expect(identity).toEqual({ providerAccountId: providerIdentity?.accountId ?? null,
      providerOrganizationId: providerIdentity?.organizationId ?? null, credentialRevision: requestAuthCredentialRevision });
  });

  it('reads an exact credential revision for qualified request-auth currentness without invoking a runtime', async () => {
    const credentialSnapshot = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
      ref: account,
      authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned' as const,
      credentialRevision: requestAuthCredentialRevision,
      configurationRevision: null,
      content: plainEnvelope('credential', {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'account-1',
        createdAt: 1,
        updatedAt: 1,
        expiresAt: null,
        kind: 'oauth',
        oauth: {
          accessToken: 'access-1',
          refreshToken: null,
          idToken: null,
          tokenType: null,
          scope: null,
          expiresAt: null,
          providerAccountId: null,
          providerEmail: null,
          raw: null,
        },
        token: null,
      }),
      metadata: { scopes: [] },
    });
    const acquireRuntimeRegistry = vi.fn();
    const readCredential = vi.fn(async () => credentialSnapshot);
    const owner = createQualifiedConnectedAccountEstablishedRuntimeOwner({
      reloadController: {
        acquireRuntimeRegistry,
        isRuntimeRegistryCurrent: vi.fn(),
      } as unknown as Pick<
        PluginReloadController,
        'acquireRuntimeRegistry' | 'isRuntimeRegistryCurrent'
      >,
      credentials: { token: 'token-1', encryption: null },
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential,
      configuration: {
        read: vi.fn(async () => null),
        secrets: {
          admit: vi.fn(async () => undefined),
          has: vi.fn(async () => false),
          read: vi.fn(async () => null),
        },
      },
    });

    const signal = new AbortController().signal;
    await expect(owner.readCredentialRevision({
      account,
      signal,
    })).resolves.toBe(requestAuthCredentialRevision);
    // The caller's cancellation signal reaches the credential read itself, so an
    // aborted request-auth currentness check cannot keep an in-flight read alive.
    expect(readCredential).toHaveBeenCalledWith({ token: 'token-1', ref: account, signal });
    expect(acquireRuntimeRegistry).not.toHaveBeenCalled();
  });

  it('refuses an unfenced snapshot before request-auth currentness can acquire a runtime', async () => {
    const credentialSnapshot = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
      ref: account,
      authenticationModeId: 'oauth',
      revisionSemantics: 'legacy_unfenced',
      credentialRevision: null,
      configurationRevision: null,
      content: plainEnvelope('credential', {
        v: 1,
        values: { accessToken: 'legacy-access' },
      }),
      metadata: { scopes: [] },
    });
    const acquireRuntimeRegistry = vi.fn();
    const readCredential = vi.fn(async () => credentialSnapshot);
    const owner = createQualifiedConnectedAccountEstablishedRuntimeOwner({
      reloadController: {
        acquireRuntimeRegistry,
        isRuntimeRegistryCurrent: vi.fn(),
      } as unknown as Pick<
        PluginReloadController,
        'acquireRuntimeRegistry' | 'isRuntimeRegistryCurrent'
      >,
      credentials: { token: 'token-1', encryption: null },
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential,
      configuration: {
        read: vi.fn(async () => null),
        secrets: {
          admit: vi.fn(async () => undefined),
          has: vi.fn(async () => false),
          read: vi.fn(async () => null),
        },
      },
    });

    await expect(owner.readCredentialRevision({ account })).rejects
      .toMatchObject({ code: 'credential_snapshot_unfenced' });
    expect(readCredential).toHaveBeenCalledWith({ token: 'token-1', ref: account });
    expect(acquireRuntimeRegistry).not.toHaveBeenCalled();
  });

  it('adopts exact qualified snapshots into the current invoker without rebuilding plugin context', async () => {
    const credentialSnapshot: QualifiedConnectedAccountCredentialSnapshotV4 = {
      ref: account,
      authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned' as const,
      credentialRevision: 'credential-1',
      configurationRevision: 'configuration-1',
      content: plainEnvelope('credential', {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'account-1',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        expiresAt: null,
        kind: 'oauth',
        oauth: {
          accessToken: 'access-1',
          refreshToken: 'refresh-1',
          idToken: null,
          tokenType: null,
          scope: null,
          expiresAt: null,
          providerAccountId: null,
          providerEmail: null,
          raw: null,
        },
        token: null,
      }),
      metadata: { providerIdentity: { accountId: 'provider-user', organizationId: 'org-a' }, scopes: [] },
      health: { v: 1, status: 'connected', reconnectRequired: false },
    };
    const configurationSnapshot: QualifiedConnectedAccountConfigurationSnapshotV4 = {
      target: { kind: 'account', ref: account },
      authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned',
      credentialRevision: 'credential-1',
      configurationRevision: 'configuration-1',
      configurationContent: plainEnvelope('configuration', {
        values: { endpoint: 'https://api.example.test' },
        secretRefs: {},
        secretValues: { clientSecret: 'secret-value' },
      }),
    };
    const assertEffectfulOperationAllowed = vi.fn();
    const invokeEstablished = vi.fn(async (
      input: ConnectedAccountRuntimeEstablishedInvocation<{
        kind: 'materialize';
        request: {
          kind: 'environment';
          keys: readonly string[];
        };
      }>,
    ) => {
      expect(assertEffectfulOperationAllowed).toHaveBeenCalledOnce();
      expect(input.target).toEqual({
        account,
        expectedCredentialRevision: 'credential-1',
        expectedRuntimeConfigurationRevision: 'configuration-1',
      });
      expect(input.context.account).toEqual(account);
      expect(input.context.configuration).toMatchObject({
        target: { kind: 'account', account, modeId: 'oauth' },
        revision: 'configuration-1',
        values: { endpoint: 'https://api.example.test' },
      });
      await expect(input.context.configuration.getSecret('clientSecret'))
        .resolves.toBe('secret-value');
      await expect(input.context.credentials.get('accessToken')).resolves.toBe('access-1');
      await expect(input.context.credentials.get('missing')).resolves.toBeNull();
      await expect(input.isConfigurationCurrent(input.context.configuration)).resolves.toBe(true);
      await expect(input.isCredentialRevisionCurrent()).resolves.toBe(true);
      return { kind: 'environment' as const, env: { TOKEN: 'access-1' } };
    });
    const invoker = Object.freeze({
      invokeAuthentication: vi.fn(),
      invokeEstablished,
    // The fixture intentionally implements only the operation exercised by this owner test.
    }) as unknown as ConnectedAccountHostRuntimeInvoker;
    const runtimeLease = Object.freeze({
      ref: service,
      occurrenceId: 'generation-1',
      sourceCustody: {
        kind: 'managed',
        immutableGenerationId: 'artifact-1',
        installSource: 'npm',
      },
      descriptor,
      runtime: {},
      isCurrent: () => true,
    });
    const registry = {
      connectedAccountRuntimeInvoker: invoker,
      resolveConnectedAccountRuntime: vi.fn(async () => runtimeLease),
    };
    const release = vi.fn(async () => undefined);
    const reloadController = {
      acquireRuntimeRegistry: vi.fn(async () => ({
        registry,
        source: 'active' as const,
        release,
      })),
      isRuntimeRegistryCurrent: vi.fn(() => true),
    } as unknown as Pick<
      PluginReloadController,
      'acquireRuntimeRegistry' | 'isRuntimeRegistryCurrent'
    >;
    const readCredential = vi.fn(async () => credentialSnapshot);
    const readConfiguration = vi.fn(async () => configurationSnapshot);
    const hasSavedSecret = vi.fn(async () => false);
    const readSavedSecret = vi.fn(async () => null);
    const owner = createQualifiedConnectedAccountEstablishedRuntimeOwner({
      reloadController,
      credentials: {
        token: 'token-1',
        encryption: null,
      },
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential,
      readConfiguration,
      configuration: {
        read: vi.fn(async () => null),
        secrets: {
          admit: vi.fn(async () => undefined),
          has: hasSavedSecret,
          read: readSavedSecret,
        },
      },
    });

    const receipt = await owner.invokeWithReceipt({
      account,
      operation: {
        kind: 'materialize',
        request: { kind: 'environment', keys: ['TOKEN'] },
      },
      assertEffectfulOperationAllowed,
    });
    expect(receipt).toEqual({
      result: {
        kind: 'environment',
        env: { TOKEN: 'access-1' },
      },
      basis: {
        credentialRevision: 'credential-1',
        credentialHealth: { v: 1, status: 'connected', reconnectRequired: false },
        credentialConfigurationRevision: 'configuration-1',
        runtimeConfigurationRevision: 'configuration-1',
        occurrenceId: 'generation-1',
        sourceCustody: {
          kind: 'managed',
          immutableGenerationId: 'artifact-1',
          installSource: 'npm',
        },
        isCurrent: expect.any(Function),
        prepareCredentialReplacement: expect.any(Function),
      },
    });
    expect(receipt.basis.isCurrent()).toBe(true);
    const replacement = await receipt.basis.prepareCredentialReplacement({
      set: { accessToken: 'access-rotated' },
      delete: [],
    });
    expect(replacement).toMatchObject({
      authenticationModeId: 'oauth',
      metadata: { providerIdentity: { accountId: 'provider-user', organizationId: 'org-a' }, scopes: [] },
    });
    expect(replacement.metadata).not.toHaveProperty('health');
    const changedContext = await receipt.basis.prepareCredentialReplacement({
      set: { accessToken: 'access-new-context' },
      delete: [],
      metadata: { providerIdentity: { accountId: 'provider-user', organizationId: 'org-b' } },
    });
    expect(changedContext.metadata.providerIdentity).toEqual({ accountId: 'provider-user', organizationId: 'org-b' });
    const unattestedContext = await receipt.basis.prepareCredentialReplacement({
      set: { accessToken: 'access-unattested-context' },
      delete: [],
      metadata: { providerIdentity: { accountId: 'provider-user' } },
    });
    expect(unattestedContext.metadata.providerIdentity).toEqual({ accountId: 'provider-user' });
    const replacementPlaintext = openQualifiedConnectedAccountContentEnvelope({
      kind: 'credential',
      accountMode: 'plain',
      envelope: replacement.content,
    });
    expect(ConnectedServiceCredentialRecordV1Schema.parse(
      replacementPlaintext,
    )).toMatchObject({
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'account-1',
      kind: 'oauth',
      oauth: {
        accessToken: 'access-rotated',
        refreshToken: 'refresh-1',
      },
    });
    expect(parseQualifiedConnectedAccountCredentialPlaintextV1({
      ref: account,
      authenticationModeId: 'oauth',
      plaintext: replacementPlaintext,
      metadata: replacement.metadata,
    })).toEqual({
      v: 1,
      values: {
        accessToken: 'access-rotated',
        refreshToken: 'refresh-1',
      },
    });
    await expect(receipt.basis.prepareCredentialReplacement({
      set: { accessToken: 'access-again' },
      delete: ['accessToken'],
    })).rejects.toThrow('cannot set and delete the same key');

    expect(readCredential).toHaveBeenCalledWith({
      token: 'token-1',
      ref: account,
    });
    expect(readConfiguration).toHaveBeenCalledWith({
      token: 'token-1',
      target: { kind: 'account', ref: account },
    });
    expect(hasSavedSecret).not.toHaveBeenCalled();
    expect(readSavedSecret).not.toHaveBeenCalled();
    expect(invokeEstablished).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('fails closed before invocation when credential/configuration revisions disagree', async () => {
    const credentialSnapshot: QualifiedConnectedAccountCredentialSnapshotV4 = {
      ref: account,
      authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned',
      credentialRevision: 'credential-2',
      configurationRevision: 'configuration-2',
      content: plainEnvelope('credential', {
        v: 1,
        values: { accessToken: 'access-2' },
      }),
      metadata: { scopes: [] },
    };
    const configurationSnapshot: QualifiedConnectedAccountConfigurationSnapshotV4 = {
      target: { kind: 'account', ref: account },
      authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned',
      credentialRevision: 'credential-stale',
      configurationRevision: 'configuration-2',
      configurationContent: plainEnvelope('configuration', {
        values: { endpoint: 'https://api.example.test' },
        secretRefs: {},
        secretValues: { clientSecret: 'secret-value' },
      }),
    };
    const invokeEstablished = vi.fn();
    const registry = {
      connectedAccountRuntimeInvoker: {
        invokeAuthentication: vi.fn(),
        invokeEstablished,
      },
      resolveConnectedAccountRuntime: vi.fn(async () => ({
        ref: service,
        occurrenceId: 'generation-1',
        sourceCustody: {
          kind: 'managed',
          immutableGenerationId: 'artifact-1',
          installSource: 'npm',
        },
        descriptor,
        runtime: {},
        isCurrent: () => true,
      })),
    };
    const owner = createQualifiedConnectedAccountEstablishedRuntimeOwner({
      reloadController: {
        acquireRuntimeRegistry: vi.fn(async () => ({
          registry,
          source: 'active' as const,
          release: vi.fn(async () => undefined),
        })),
        isRuntimeRegistryCurrent: vi.fn(() => true),
      } as unknown as Pick<
        PluginReloadController,
        'acquireRuntimeRegistry' | 'isRuntimeRegistryCurrent'
      >,
      credentials: {
        token: 'token-1',
        encryption: {
          type: 'dataKey',
          publicKey: new Uint8Array(32),
          machineKey: new Uint8Array(32),
        },
      },
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential: vi.fn(async () => credentialSnapshot),
      readConfiguration: vi.fn(async () => configurationSnapshot),
      configuration: {
        read: vi.fn(async () => null),
        secrets: {
          admit: vi.fn(async () => undefined),
          has: vi.fn(async () => true),
          read: vi.fn(async () => 'secret-value'),
        },
      },
    });

    await expect(owner.invoke({
      account,
      operation: {
        kind: 'materialize',
        request: { kind: 'environment', keys: ['TOKEN'] },
      },
    })).rejects.toThrow('snapshot revisions do not describe one exact account state');
    expect(invokeEstablished).not.toHaveBeenCalled();
  });

  it('loads service-scoped configuration from the canonical configuration owner and fences a stale revision', async () => {
    const serviceDescriptor =
      PluginConnectedAccountDescriptorContributionV2Schema.parse({
        id: service.localId,
        title: 'Acme',
        authentication: {
          defaultModeId: 'oauth',
          modes: [{
            id: 'oauth',
            kind: 'oauthAuthorizationCode',
            callbackUrl: 'https://provider.example/oauth/callback',
            pkce: 'required',
            outcomeReconciliation: 'none',
            configuration: {
              scope: 'service',
              changeBehavior: 'refresh',
              fields: [{
                id: 'endpoint',
                title: 'Endpoint',
                schema: { type: 'string', minLength: 1 },
                required: true,
              }],
            },
          }],
        },
      });
    const credentialSnapshot: QualifiedConnectedAccountCredentialSnapshotV4 = {
      ref: account,
      authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned',
      credentialRevision: 'credential-service-1',
      configurationRevision: null,
      content: plainEnvelope('credential', {
        v: 1,
        values: { accessToken: 'access-service-1' },
      }),
      metadata: { scopes: [] },
    };
    let serviceConfiguration: ConnectedAccountConfigurationRecord = Object.freeze({
      revision: 'service-configuration-1',
      values: Object.freeze({
        endpoint: 'https://api.example.test',
      }),
      secretRefs: Object.freeze({}),
    });
    const readConfigurationRecord = vi.fn(async () => serviceConfiguration);
    const sharedConfigurationOwner = createConnectedAccountConfigurationOwner({
      read: readConfigurationRecord,
      async replace(input) {
        serviceConfiguration = Object.freeze({
          revision: 'service-configuration-2',
          values: input.replacement.values,
          secretRefs: input.replacement.secretRefs,
        });
        return { status: 'committed' as const, record: serviceConfiguration };
      },
      destroyAttempt: vi.fn(),
      secrets: {
        admit: vi.fn(async () => undefined),
        has: vi.fn(async () => true),
        read: vi.fn(async () => 'secret-value'),
      },
      isRuntimeCurrent: vi.fn(async () => true),
    });
    const invokeEstablished = vi.fn(async (
      input: ConnectedAccountRuntimeEstablishedInvocation<{
        kind: 'status';
      }>,
    ) => {
      expect(input.target).toEqual({
        account,
        expectedCredentialRevision: 'credential-service-1',
        expectedRuntimeConfigurationRevision: 'service-configuration-1',
      });
      expect(input.context.configuration).toMatchObject({
        target: { kind: 'service', service, modeId: 'oauth' },
        revision: 'service-configuration-1',
        values: { endpoint: 'https://api.example.test' },
      });
      await expect(
        input.isConfigurationCurrent(input.context.configuration),
      ).resolves.toBe(true);
      expect(input.configurationRevocationSignal).toBeTypeOf('function');
      if (!input.configurationRevocationSignal) {
        throw new Error('configuration revocation signal is required for this fixture');
      }
      const currentnessSignal = input.configurationRevocationSignal(
        input.context.configuration,
      );
      if (!currentnessSignal) {
        throw new Error('configuration revocation signal is required for this fixture');
      }
      expect(currentnessSignal.aborted).toBe(false);
      await expect(sharedConfigurationOwner.replace({
        target: input.context.configuration.target,
        mode: serviceDescriptor.authentication.modes[0]!,
        expectedRevision: 'service-configuration-1',
        replacement: {
          values: { endpoint: 'https://api2.example.test' },
          secretRefs: {},
        },
        occurrenceId: 'generation-1',
        sourceCustody: {
          kind: 'managed',
          immutableGenerationId: 'artifact-1',
          installSource: 'npm',
        },
      })).resolves.toMatchObject({
        status: 'committed',
      });
      expect(currentnessSignal.aborted).toBe(true);
      await expect(
        input.isConfigurationCurrent(input.context.configuration),
      ).resolves.toBe(false);
      return { status: 'connected' as const };
    });
    const registry = {
      connectedAccountRuntimeInvoker: {
        invokeAuthentication: vi.fn(),
        invokeEstablished,
      },
      resolveConnectedAccountRuntime: vi.fn(async () => ({
        ref: service,
        occurrenceId: 'generation-1',
        sourceCustody: {
          kind: 'managed',
          immutableGenerationId: 'artifact-1',
          installSource: 'npm',
        },
        descriptor: serviceDescriptor,
        runtime: {},
        isCurrent: () => true,
      })),
    };
    const owner = createQualifiedConnectedAccountEstablishedRuntimeOwner({
      reloadController: {
        acquireRuntimeRegistry: vi.fn(async () => ({
          registry,
          source: 'active' as const,
          release: vi.fn(async () => undefined),
        })),
        isRuntimeRegistryCurrent: vi.fn(() => true),
      } as unknown as Pick<
        PluginReloadController,
        'acquireRuntimeRegistry' | 'isRuntimeRegistryCurrent'
      >,
      credentials: {
        token: 'token-1',
        encryption: {
          type: 'dataKey',
          publicKey: new Uint8Array(32),
          machineKey: new Uint8Array(32),
        },
      },
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential: vi.fn(async () => credentialSnapshot),
      readConfiguration: vi.fn(async () => null),
      configurationOwner: sharedConfigurationOwner,
      configuration: {
        read: readConfigurationRecord,
        secrets: {
          admit: vi.fn(async () => undefined),
          has: vi.fn(async () => true),
          read: vi.fn(async () => 'secret-value'),
        },
      },
    });

    const receipt = await owner.invokeWithReceipt({
      account,
      operation: { kind: 'status' },
    });
    expect(receipt.result).toEqual({ status: 'connected' });
    expect(receipt.basis).toMatchObject({
      credentialRevision: 'credential-service-1',
      credentialConfigurationRevision: null,
      runtimeConfigurationRevision: 'service-configuration-1',
    });
    expect(invokeEstablished).toHaveBeenCalledTimes(1);
    expect(readConfigurationRecord).toHaveBeenCalledWith({
      kind: 'service',
      service,
      modeId: 'oauth',
    });
  });

  it('rejects a later materialization when the callback-pinned credential revision rotates', async () => {
    const revisionA = 'csr_0123456789ABCDEFGHJKMNPQRS';
    const revisionB = 'csr_ZYXWVUTSRQPONMLKJHGFEDCBA1';
    let credentialRevision = revisionA;
    let configurationRevision = 'configuration-1';
    const readCredential = vi.fn(async () => ({
      ref: account,
      authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned' as const,
      credentialRevision,
      configurationRevision,
      content: plainEnvelope('credential', {
        v: 1,
        values: { accessToken: credentialRevision },
      }),
      metadata: { scopes: [] },
    }));
    const readConfiguration = vi.fn(async () => ({
      target: { kind: 'account' as const, ref: account },
      authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned' as const,
      credentialRevision,
      configurationRevision,
      configurationContent: plainEnvelope('configuration', {
        values: { endpoint: 'https://api.example.test' },
        secretRefs: {},
        secretValues: { clientSecret: 'secret-value' },
      }),
    }));
    const invokeEstablished = vi.fn(async (
      input: ConnectedAccountRuntimeEstablishedInvocation<{
        kind: 'materialize';
        request: { kind: 'httpHeaders'; origin: string; headerNames: readonly string[] };
      }>,
    ) => {
      expect(input.target.expectedCredentialRevision).toBe(credentialRevision);
      await expect(input.isCredentialRevisionCurrent()).resolves.toBe(true);
      return {
        kind: 'httpHeaders' as const,
        headers: { authorization: `Bearer ${credentialRevision}` },
      };
    });
    const owner = createQualifiedConnectedAccountEstablishedRuntimeOwner({
      reloadController: {
        acquireRuntimeRegistry: vi.fn(async () => ({
          registry: {
            connectedAccountRuntimeInvoker: {
              invokeAuthentication: vi.fn(),
              invokeEstablished,
            },
            resolveConnectedAccountRuntime: vi.fn(async () => ({
              ref: service,
        occurrenceId: 'generation-1',
        sourceCustody: {
          kind: 'managed',
          immutableGenerationId: 'artifact-1',
          installSource: 'npm',
        },
              descriptor,
              runtime: {},
              isCurrent: () => true,
            })),
          },
          source: 'active' as const,
          release: vi.fn(async () => undefined),
        })),
        isRuntimeRegistryCurrent: vi.fn(() => true),
      } as unknown as Pick<
        PluginReloadController,
        'acquireRuntimeRegistry' | 'isRuntimeRegistryCurrent'
      >,
      credentials: {
        token: 'token-1',
        encryption: null,
      },
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential,
      readConfiguration,
      configuration: {
        read: vi.fn(async () => null),
        secrets: {
          admit: vi.fn(async () => undefined),
          has: vi.fn(async () => false),
          read: vi.fn(async () => null),
        },
      },
    });

    const first = await owner.invokeWithReceipt({
      account,
      operation: {
        kind: 'materialize',
        request: { kind: 'httpHeaders', origin: 'https://api.example.test', headerNames: ['authorization'] },
      },
    });
    expect(first.basis.credentialRevision).toBe(revisionA);

    credentialRevision = revisionB;
    await expect(owner.invoke({
      account,
      operation: {
        kind: 'materialize',
        request: { kind: 'httpHeaders', origin: 'https://api.example.test', headerNames: ['authorization'] },
      },
      // This host-private value is first available only after the first receipt.
      expectedCredentialRevision: first.basis.credentialRevision,
    })).rejects.toThrow('credential revision');
    expect(invokeEstablished).toHaveBeenCalledTimes(1);

    const nextCallback = await owner.invokeWithReceipt({
      account,
      operation: {
        kind: 'materialize',
        request: { kind: 'httpHeaders', origin: 'https://api.example.test', headerNames: ['authorization'] },
      },
    });
    expect(nextCallback.basis.credentialRevision).toBe(revisionB);
    expect(invokeEstablished).toHaveBeenCalledTimes(2);
    // A retained machine pins its connection configuration, not the renewable
    // bearer credential. A refreshed token still addresses the same resource.
    const retainedConnection = await owner.invokeWithReceipt({
      account,
      operation: { kind: 'materialize', request: { kind: 'httpHeaders', origin: 'https://api.example.test', headerNames: ['authorization'] } },
      expectedConfigurationRevision: first.basis.credentialConfigurationRevision,
    });
    expect(retainedConnection.result).toEqual({ kind: 'httpHeaders', headers: { authorization: `Bearer ${revisionB}` } });
    configurationRevision = 'configuration-2';
    await expect(owner.invokeWithReceipt({
      account,
      operation: { kind: 'materialize', request: { kind: 'httpHeaders', origin: 'https://api.example.test', headerNames: ['authorization'] } },
      expectedConfigurationRevision: first.basis.credentialConfigurationRevision,
    })).rejects.toThrow('configuration revision');
    expect(invokeEstablished).toHaveBeenCalledTimes(3);
    // Exercise the real managed-purpose lease and daemon adapter too: the
    // public materialize request cannot choose or replace its retained basis.
    const purpose = { consumer: { pluginId: 'acme.compute', localId: 'vm' }, purpose: 'coordinator' };
    const runtime = createDaemonConnectedAccountPurposeBindingRuntime({
      establishedRuntimeOwner: owner, resolveQualifiedConnectedAccountV4Support: () => 'advertised',
      store: { read: async () => ({ v: 1, bindings: [] }), update: async mutate => mutate({ v: 1, bindings: [] }),
        subscribe: () => ({ dispose() {} }) },
      qualifiedApi: {
        listAccounts: async () => ({ service, accounts: [{ ref: account, status: 'connected', authenticationModeId: 'oauth',
          revisionSemantics: 'revisioned', credentialRevision: revisionB, configurationReady: true,
          configurationRevision, kind: 'token', expiresAt: null, providerIdentity: { accountId: 'retained' }, displayName: 'Retained account', scopes: [] }] }),
        listGroups: async () => ({ groups: [] }), readGroup: async () => null,
      },
      runtimeRegistry: { subscribe: () => () => undefined, acquire: async () => ({
        isCurrent: () => true, resolveService: () => ({ service, availability: 'available', authentication: descriptor.authentication }),
        release: async () => undefined,
      }) },
    });
    const bindingLease = runtime.activatePurposeBindings({
      subject: { kind: 'managed_provider_operation', operationId: 'retained-machine', pluginId: purpose.consumer.pluginId,
        providerLocalId: purpose.consumer.localId, isCurrent: () => true,
        credentialConfigurations: [{ account, revision: first.basis.credentialConfigurationRevision }] },
      purposes: [purpose], bindings: [{ purpose, target: { kind: 'account', account } }],
    });
    try {
      await expect(runtime.owner.materialize({ purpose, serviceRefs: [service], exactPurposeBindingSubjectId: bindingLease.subjectId,
        request: { kind: 'httpHeaders', origin: 'https://api.example.test', headerNames: ['authorization'] },
        signal: new AbortController().signal })).rejects.toThrow('configuration revision');
      expect(invokeEstablished).toHaveBeenCalledTimes(3);
    } finally { bindingLease.dispose(); }
  });

  it('projects only host-normalized credential-free configured origins for one exact account', async () => {
    const credentialSnapshot = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
      ref: account,
      authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned' as const,
      credentialRevision: requestAuthCredentialRevision,
      configurationRevision: 'configuration-1',
      content: plainEnvelope('credential', {
        v: 1,
        values: { accessToken: 'access-1' },
      }),
      metadata: { scopes: [] },
    });
    const configurationSnapshot: QualifiedConnectedAccountConfigurationSnapshotV4 = {
      target: { kind: 'account', ref: account },
      authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned',
      credentialRevision: requestAuthCredentialRevision,
      configurationRevision: 'configuration-1',
      configurationContent: plainEnvelope('configuration', {
        values: { endpoint: 'https://eu.example.test', label: 'Europe' },
        secretRefs: {},
        secretValues: { clientSecret: 'secret-value' },
      }),
    };
    const invokeEstablished = vi.fn(async () => {
      throw new Error('configured-origin projection must not invoke a plugin runtime');
    });
    const owner = createQualifiedConnectedAccountEstablishedRuntimeOwner({
      reloadController: {
        acquireRuntimeRegistry: vi.fn(async () => ({
          registry: {
            connectedAccountRuntimeInvoker: {
              invokeAuthentication: vi.fn(),
              invokeEstablished,
            },
            resolveConnectedAccountRuntime: vi.fn(async () => Object.freeze({
              ref: service,
        occurrenceId: 'generation-1',
        sourceCustody: {
          kind: 'managed',
          immutableGenerationId: 'artifact-1',
          installSource: 'npm',
        },
              descriptor: originDescriptor,
              runtime: {},
              isCurrent: () => true,
            })),
          },
          source: 'active' as const,
          release: vi.fn(async () => undefined),
        })),
        isRuntimeRegistryCurrent: vi.fn(() => true),
      } as unknown as Pick<
        PluginReloadController,
        'acquireRuntimeRegistry' | 'isRuntimeRegistryCurrent'
      >,
      credentials: { token: 'token-1', encryption: null },
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential: vi.fn(async () => credentialSnapshot),
      readConfiguration: vi.fn(async () => configurationSnapshot),
      configuration: {
        read: vi.fn(async () => null),
        secrets: {
          admit: vi.fn(async () => undefined),
          has: vi.fn(async () => false),
          read: vi.fn(async () => null),
        },
      },
    });

    await expect(owner.readConfiguredEndpoints({ account }))
      .resolves.toEqual([{
        origin: 'https://eu.example.test',
        base: 'https://eu.example.test',
        grantTargetKind: 'connectedAccountOrigin',
      }]);
    expect(invokeEstablished).not.toHaveBeenCalled();
  });

  it('fails a configured-origin projection closed when the stored origin is not credential-free', async () => {
    const credentialSnapshot = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
      ref: account,
      authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned' as const,
      credentialRevision: requestAuthCredentialRevision,
      configurationRevision: 'configuration-1',
      content: plainEnvelope('credential', {
        v: 1,
        values: { accessToken: 'access-1' },
      }),
      metadata: { scopes: [] },
    });
    const configurationSnapshot: QualifiedConnectedAccountConfigurationSnapshotV4 = {
      target: { kind: 'account', ref: account },
      authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned',
      credentialRevision: requestAuthCredentialRevision,
      configurationRevision: 'configuration-1',
      configurationContent: plainEnvelope('configuration', {
        values: { endpoint: 'https://user:secret@eu.example.test' },
        secretRefs: {},
        secretValues: { clientSecret: 'secret-value' },
      }),
    };
    const owner = createQualifiedConnectedAccountEstablishedRuntimeOwner({
      reloadController: {
        acquireRuntimeRegistry: vi.fn(async () => ({
          registry: {
            connectedAccountRuntimeInvoker: {
              invokeAuthentication: vi.fn(),
              invokeEstablished: vi.fn(),
            },
            resolveConnectedAccountRuntime: vi.fn(async () => Object.freeze({
              ref: service,
              occurrenceId: 'generation-1',
              sourceCustody: {
                kind: 'managed',
                immutableGenerationId: 'artifact-1',
                installSource: 'npm',
              },
              descriptor: originDescriptor,
              runtime: {},
              isCurrent: () => true,
            })),
          },
          source: 'active' as const,
          release: vi.fn(async () => undefined),
        })),
        isRuntimeRegistryCurrent: vi.fn(() => true),
      } as unknown as Pick<
        PluginReloadController,
        'acquireRuntimeRegistry' | 'isRuntimeRegistryCurrent'
      >,
      credentials: { token: 'token-1', encryption: null },
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential: vi.fn(async () => credentialSnapshot),
      readConfiguration: vi.fn(async () => configurationSnapshot),
      configuration: {
        read: vi.fn(async () => null),
        secrets: {
          admit: vi.fn(async () => undefined),
          has: vi.fn(async () => false),
          read: vi.fn(async () => null),
        },
      },
    });

    await expect(owner.readConfiguredEndpoints({ account })).rejects.toThrow(
      'credential-free HTTPS origin',
    );
  });
});
