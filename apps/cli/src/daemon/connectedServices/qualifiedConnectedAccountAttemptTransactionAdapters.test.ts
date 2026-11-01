import { describe, expect, it, vi } from 'vitest';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1, QualifiedConnectedAccountCredentialPayloadV1Schema } from '@happier-dev/protocol';

import {
  ConnectedAccountAttemptTransactionApiError,
  type ConnectedAccountAttemptTransactionKind,
  type ConnectedAccountAttemptTransactionRecord,
  type ConnectedAccountAttemptTransactionStoreApi,
} from '@/api/client/connectedAccountAttemptTransactionApi';
import type { Credentials, StoredCredentials } from '@/persistence';
import type {
  ConnectedAccountAttemptSettlementRequest,
  ConnectedAccountDeviceTransactionSnapshot,
  ConnectedAccountOAuthTransactionSnapshot,
} from '@happier-dev/cli-common/connectedAccounts';
import type { PluginSourceCustody } from '@/plugins/runtime/sourceAuthority';
import { loadBundledPluginLocators } from '@/plugins/projection/registry/builtIn/locators';
import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } from '@/plugins/projection/registry/sources/generatedBundledPluginManifests';
import { createConnectedAccountAttemptTransactionApiBoundary as createTransactionApi } from '@/testkit/connectedAccountAttemptTransactionApi';

import {
  createQualifiedConnectedAccountAttemptTransactionAdapters,
} from './qualifiedConnectedAccountAttemptTransactionAdapters';

function transactionKey(
  kind: ConnectedAccountAttemptTransactionKind,
  attemptId: string,
): string {
  return attemptId;
}

function credentials(fill: number): Credentials {
  return {
    token: 'account-token',
    encryption: {
      type: 'dataKey',
      publicKey: new Uint8Array(32).fill(fill + 1),
      machineKey: new Uint8Array(32).fill(fill),
    },
  };
}

/** A genuinely keyless Account credential: a bearer token and zero Account material. */
function tokenOnlyCredentials(): StoredCredentials {
  return { token: 'account-token', encryption: null };
}

const e2eeAccount = { getAccountEncryptionMode: async () => 'e2ee' as const,
  getMachineId: () => 'machine-1' };
const plainAccount = { getAccountEncryptionMode: async () => 'plain' as const,
  getMachineId: () => 'machine-1' };

function storedContentJson(
  record: ConnectedAccountAttemptTransactionRecord | undefined,
): string {
  return JSON.stringify(record?.content ?? null);
}

const service = Object.freeze({
  pluginId: 'example.plugin',
  localId: 'example.account-service',
});

const managedCustody = Object.freeze({
  kind: 'managed' as const,
  immutableGenerationId: 'artifact-sha256',
  installSource: 'npm' as const,
});

function oauthSnapshot(
  sourceCustody: PluginSourceCustody = managedCustody,
): ConnectedAccountOAuthTransactionSnapshot {
  return Object.freeze({
    attemptId: 'oauth-attempt',
    createdAtMs: 1_000,
    intent: 'connect',
    service,
    modeId: 'oauth',
    sourceCustody,
    expectedCredentialRevision: null,
    expectedCredentialConfigurationRevision: null,
    expectedConfigurationRevision: 'configuration-1',
    phase: 'starting',
    expiresAtMs: 100_000,
    stagedCredentials: Object.freeze({
      accessToken: 'super-secret-access-token',
    }),
    stagedAccountConfigurationContent: Object.freeze({
      clientSecret: 'super-secret-configuration',
    }),
  });
}

function deviceSnapshot(
  sourceCustody: PluginSourceCustody = managedCustody,
): ConnectedAccountDeviceTransactionSnapshot {
  return Object.freeze({
    attemptId: 'device-attempt',
    createdAtMs: 2_000,
    intent: 'reconnect',
    service,
    account: Object.freeze({
      service,
      accountId: 'account-1',
    }),
    modeId: 'device',
    sourceCustody,
    expectedCredentialRevision: 'credential-1',
    expectedCredentialConfigurationRevision: 'account-configuration-1',
    expectedConfigurationRevision: 'configuration-1',
    expiresAtMs: 200_000,
    pollIntervalMs: 5_000,
    nextPollAtMs: 10_000,
    verificationUri: 'https://provider.example/device',
    verificationUriComplete:
      'https://provider.example/device?code=user-code',
    userCode: 'user-code',
    stagedCredentials: Object.freeze({
      refreshToken: 'super-secret-refresh-token',
    }),
    stagedAccountConfigurationContent: Object.freeze({
      tenant: 'super-secret-tenant',
    }),
  });
}

function preparedDeviceSettlement(
  snapshot: ConnectedAccountDeviceTransactionSnapshot,
): ConnectedAccountAttemptSettlementRequest {
  return {
    intent: snapshot.intent,
    service: snapshot.service,
    accountId: 'account-1',
    authenticationModeId: snapshot.modeId,
    directExportContract: null,
    expectedCredentialRevision: snapshot.expectedCredentialRevision,
    expectedCredentialConfigurationRevision: snapshot.expectedCredentialConfigurationRevision,
    expectedConfigurationRevision: snapshot.expectedConfigurationRevision,
    sourceCustody: snapshot.sourceCustody,
    stagedCredentials: snapshot.stagedCredentials,
    stagedAccountConfigurationContent: snapshot.stagedAccountConfigurationContent,
    displayName: 'Connected account',
    scopes: ['read'],
  };
}

describe('qualified Connected Account attempt transaction adapters', () => {
  it.each(['oauth', 'device'] as const)('restores %s from its already addressed record without another lookup', async kind => {
    const api = createTransactionApi();
    const owner = createQualifiedConnectedAccountAttemptTransactionAdapters({
      credentials: tokenOnlyCredentials(), ...plainAccount, api, now: () => 5_000,
    });
    const snapshot = kind === 'oauth' ? oauthSnapshot() : deviceSnapshot();
    if (kind === 'oauth') {
      await owner.oauth.create({ attemptId: snapshot.attemptId, service,
        snapshot: oauthSnapshot(), callbackUrl: 'https://app.example/callback' });
    } else {
      await owner.device.acknowledge(deviceSnapshot());
    }
    const reads = vi.spyOn(api, 'read');
    const record = await api.read({ attemptId: snapshot.attemptId });
    expect(record).not.toBeNull();
    if (kind === 'oauth') {
      expect((await owner.oauth.read(snapshot.attemptId, record!))?.snapshot).toEqual(snapshot);
    } else {
      expect(await owner.device.read(snapshot.attemptId, record!)).toEqual(snapshot);
    }
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('leaves another transaction kind untouched during device cleanup', async () => {
    const api = createTransactionApi();
    const owner = createQualifiedConnectedAccountAttemptTransactionAdapters({
      credentials: tokenOnlyCredentials(), ...plainAccount, api, now: () => 5_000,
    });
    const snapshot = oauthSnapshot();
    const transaction = await owner.oauth.create({ attemptId: snapshot.attemptId,
      service, snapshot, callbackUrl: 'https://app.example/callback' });
    await owner.device.clear(snapshot.attemptId);
    expect(await owner.oauth.read(snapshot.attemptId)).toMatchObject({ request: transaction.request });
    expect(api.records.size).toBe(1);
  });

  it.each(['plain', 'e2ee'] as const)('uses one finite %s address while configuration advances to OAuth', async accountMode => {
    const api = createTransactionApi();
    let now = 5_000;
    const owner = createQualifiedConnectedAccountAttemptTransactionAdapters({
      credentials: accountMode === 'plain' ? tokenOnlyCredentials() : credentials(7),
      ...(accountMode === 'plain' ? plainAccount : e2eeAccount), api, now: () => now,
    });
    const snapshot = oauthSnapshot();
    const address = { attemptId: snapshot.attemptId, kind: 'oauth' as const,
      phase: 'configurationRequired' as const, createdAtMs: snapshot.createdAtMs,
      intent: snapshot.intent, service, modeId: snapshot.modeId };
    const acknowledged = await owner.address.acknowledge(address);
    const first = api.records.get(snapshot.attemptId)!;
    expect(first.scope.phase).toBe('configurationRequired');
    expect(await owner.oauth.read(snapshot.attemptId)).toBeNull();
    now += 1_000;
    expect(await owner.address.acknowledge(address)).toEqual(acknowledged);
    const transaction = await owner.oauth.create({ attemptId: snapshot.attemptId,
      service, snapshot, callbackUrl: 'https://app.example/callback' });
    expect(api.records.size).toBe(1);
    expect(api.records.get(snapshot.attemptId)?.scope.phase).toBe('starting');
    expect(transaction.expiresAtMs).toBeLessThanOrEqual(acknowledged.expiresAtMs);
    await transaction.close();
    expect(api.records.size).toBe(0);
  });

  it('advances a configuration address to a device challenge without adding a second record', async () => {
    const api = createTransactionApi();
    const owner = createQualifiedConnectedAccountAttemptTransactionAdapters({
      credentials: tokenOnlyCredentials(), ...plainAccount, api, now: () => 5_000,
    });
    const snapshot = deviceSnapshot();
    await owner.address.acknowledge({ attemptId: snapshot.attemptId, kind: 'device',
      phase: 'configurationRequired', createdAtMs: snapshot.createdAtMs,
      intent: snapshot.intent, service, modeId: snapshot.modeId });
    expect(await owner.device.read(snapshot.attemptId)).toBeNull();
    await owner.device.acknowledge(snapshot);
    expect(api.records.size).toBe(1);
    expect(await owner.device.read(snapshot.attemptId)).toEqual(snapshot);
    await owner.device.clear(snapshot.attemptId);
    expect(api.records.size).toBe(0);
  });

  it('keeps a manual host address at its admitted expiry and clears the same record', async () => {
    const api = createTransactionApi();
    let now = 5_000;
    const owner = createQualifiedConnectedAccountAttemptTransactionAdapters({
      credentials: tokenOnlyCredentials(), ...plainAccount, api, now: () => now,
    });
    const snapshot = { attemptId: 'manual-attempt', kind: 'manual' as const,
      phase: 'configurationRequired' as const, createdAtMs: now,
      intent: 'connect' as const, service, modeId: 'manual' };
    const acknowledged = await owner.address.acknowledge(snapshot);
    now += 1_000;
    expect(await owner.address.acknowledge({ ...snapshot, phase: 'awaitingManual' })).toEqual(acknowledged);
    expect(api.records.size).toBe(1);
    expect(api.records.get(snapshot.attemptId)).toMatchObject({ kind: 'manual',
      expiresAtMs: acknowledged.expiresAtMs, scope: { phase: 'awaitingManual' } });
    await owner.address.clear(snapshot.attemptId);
    expect(api.records.size).toBe(0);
  });

  it('persists and restores an Account-scoped attempt without a Machine', async () => {
    const api = createTransactionApi();
    const owner = createQualifiedConnectedAccountAttemptTransactionAdapters({
      credentials: tokenOnlyCredentials(),
      getAccountEncryptionMode: plainAccount.getAccountEncryptionMode,
      api,
      now: () => 5_000,
    });
    const snapshot = oauthSnapshot();
    const transaction = await owner.oauth.create({
      attemptId: snapshot.attemptId, service, snapshot, callbackUrl: 'https://app.example/callback',
    });
    await transaction.acknowledge({ ...snapshot, phase: 'awaitingOAuth' });
    expect(await owner.listPending(service)).toEqual([expect.objectContaining({ attemptId: snapshot.attemptId })]);
    const otherHost = createQualifiedConnectedAccountAttemptTransactionAdapters({
      credentials: tokenOnlyCredentials(), ...plainAccount, api, now: () => 5_000,
    });
    const restored = await otherHost.oauth.read(snapshot.attemptId);
    expect(restored?.request).toEqual(transaction.request);
    await restored?.acknowledge({ ...snapshot, phase: 'awaitingOAuth' });
    expect(api.records.get(transactionKey('oauth', snapshot.attemptId))?.scope).not.toHaveProperty('machineId');
  });
  it.each(['credential', 'redirect'] as const)('retains valid large %s material through the canonical transaction envelope', async (kind) => {
    const api = createTransactionApi();
    const owner = createQualifiedConnectedAccountAttemptTransactionAdapters({
      credentials: tokenOnlyCredentials(), ...plainAccount, api, now: () => 5_000,
    });
    const values = QualifiedConnectedAccountCredentialPayloadV1Schema.parse({
      v: 1, values: { accessToken: 't'.repeat(kind === 'credential' ? 80_000 : 20) },
    }).values;
    const snapshot = { ...oauthSnapshot(), stagedCredentials: values,
      authorizationUrl: `https://provider.example/authorize?state=${'s'.repeat(kind === 'redirect' ? 9_000 : 20)}` };
    const transaction = await owner.oauth.create({ attemptId: snapshot.attemptId, service, snapshot,
      callbackUrl: 'https://app.example/callback' });
    expect((await owner.oauth.read!(snapshot.attemptId))?.snapshot).toEqual(snapshot);
    await transaction.close();
  });

  it.each(['oauth', 'device'] as const)('retains a valid %s provider authorization beyond fifteen minutes within server custody', async (kind) => {
    const api = createTransactionApi();
    const now = 5_000;
    const providerExpiry = now + 40 * 60_000;
    const owner = createQualifiedConnectedAccountAttemptTransactionAdapters({
      credentials: tokenOnlyCredentials(), ...plainAccount, api, now: () => now,
    });
    if (kind === 'oauth') {
      const snapshot = { ...oauthSnapshot(), expiresAtMs: providerExpiry };
      const transaction = await owner.oauth.create({ attemptId: snapshot.attemptId, service,
        snapshot, callbackUrl: 'https://provider.example/oauth/callback' });
      expect(transaction.expiresAtMs).toBe(providerExpiry);
      await transaction.close();
    } else {
      const snapshot = { ...deviceSnapshot(), expiresAtMs: providerExpiry };
      await owner.device.acknowledge(snapshot);
      expect(api.records.get('device-attempt')?.expiresAtMs).toBe(providerExpiry);
      await owner.device.clear(snapshot.attemptId);
    }
  });

  it('seals host-discovered configuration before the redirect and refuses changes after publication', async () => {
    const api = createTransactionApi();
    const owner = createQualifiedConnectedAccountAttemptTransactionAdapters({ credentials: credentials(7), ...e2eeAccount, api });
    const snapshot = { ...oauthSnapshot(), service: { pluginId: 'happier', localId: 'mcp-sign-in' }, sourceCustody: { kind: 'host' as const } };
    const handle = await owner.oauth.create({ attemptId: snapshot.attemptId, service: snapshot.service, snapshot,
      callbackUrl: 'https://app.happier.dev/oauth/mcp/callback' });
    expect(handle.expiresAtMs).toBe(api.records.get('oauth-attempt')!.expiresAtMs);
    const issuer = `https://issuer.example/${'issuer-path'.repeat(420)}`;
    const discovered = { ...snapshot, phase: 'awaitingOAuth' as const, issuer, issuerResponseParameterRequired: true, stagedAccountConfigurationContent: {
      values: { resource: 'https://mcp.example/mcp', issuer }, secretValues: { clientSecret: 'secret-client' },
    } };
    await handle.acknowledge!(discovered);
    expect(storedContentJson(api.records.get('oauth-attempt'))).not.toContain('secret-client');
    expect((await owner.oauth.read!(snapshot.attemptId))?.snapshot).toEqual(discovered);
    await expect(handle.acknowledge!({ ...discovered, stagedAccountConfigurationContent: { values: { resource: 'https://other.example' } } }))
      .rejects.toThrow();
    await handle.close();
  });
  it('routes by the attempt prefix but rejects a different whole state after restart', async () => {
    const api = createTransactionApi();
    const params = { credentials: tokenOnlyCredentials(), ...plainAccount, api };
    const adapters = createQualifiedConnectedAccountAttemptTransactionAdapters(params);
    const snapshot = oauthSnapshot();
    const handle = await adapters.oauth.create({ attemptId: snapshot.attemptId, service, snapshot,
      callbackUrl: 'https://app.happier.dev/oauth/mcp/callback' });
    expect(handle.request.state).toMatch(/^oauth-attempt\.[A-Za-z0-9_-]{43}$/);
    const restored = await createQualifiedConnectedAccountAttemptTransactionAdapters(params).oauth.read!(snapshot.attemptId);
    expect(restored).not.toBeNull();
    await expect(restored!.acceptCompletion({ code: 'code', callbackUrl: handle.request.callbackUrl,
      state: `${snapshot.attemptId}.${'a'.repeat(43)}` })).rejects.toThrow();
    await expect(restored!.acceptCompletion({ code: 'code', callbackUrl: handle.request.callbackUrl,
      state: handle.request.state })).resolves.toMatchObject({ code: 'code', state: handle.request.state });
    await restored!.close();
  });
  it('uses the callback declared by the admitted Codex descriptor for its OAuth attempt', async () => {
    const locator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find((candidate) => candidate.pluginId === 'happier.agent.codex');
    if (!locator) throw new Error('Missing bundled Codex locator');
    const [plugin] = loadBundledPluginLocators([locator]);
    const descriptor = plugin?.manifest.contributes?.connectedAccountDescriptors?.find((candidate) => candidate.id === 'openai-codex');
    const mode = descriptor?.authentication?.modes.find((candidate) => candidate.kind === 'oauthAuthorizationCode');
    if (!descriptor || mode?.kind !== 'oauthAuthorizationCode' || !mode.callbackUrl) {
      throw new Error('Missing admitted Codex callback declaration');
    }
    const api = createTransactionApi();
    const owner = createQualifiedConnectedAccountAttemptTransactionAdapters({
      credentials: tokenOnlyCredentials(), ...plainAccount, api, now: () => 5_000,
    });
    const snapshot = {
      ...oauthSnapshot(),
      service: { pluginId: locator.pluginId, localId: descriptor.id },
      modeId: mode.id,
    };
    const transaction = await owner.oauth.create({
      attemptId: snapshot.attemptId, service: snapshot.service, snapshot, callbackUrl: mode.callbackUrl,
    });
    expect(transaction.request.callbackUrl).toBe(mode.callbackUrl);
    expect((await owner.oauth.read!(snapshot.attemptId))?.request.callbackUrl).toBe(mode.callbackUrl);
  });

  it.each(['oauth', 'device'] as const)('restores %s stored attempts with retired fields while keeping fresh snapshots strict', async kind => {
    const api = createTransactionApi();
    const owner = createQualifiedConnectedAccountAttemptTransactionAdapters({
      credentials: tokenOnlyCredentials(), ...plainAccount, api, now: () => 5_000,
    });
    const initial = kind === 'oauth' ? oauthSnapshot() : deviceSnapshot();
    if (kind === 'oauth') await owner.oauth!.create({
      attemptId: initial.attemptId, service, snapshot: oauthSnapshot(),
      callbackUrl: 'https://provider.example/oauth/callback',
    });
    else await owner.device!.acknowledge(deviceSnapshot());
    const key = transactionKey(kind, initial.attemptId);
    const record = api.records.get(key)!;
    if (record.content.t !== 'plain') throw new Error('Expected a plain stored attempt');
    const payload = record.content.v;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Expected stored payload');
    api.records.set(key, { ...record, content: { ...record.content, v: {
      ...payload, retiredPayloadField: true,
      snapshot: { ...initial, retiredSnapshotField: true,
        service: { ...initial.service, retiredServiceField: true },
        sourceCustody: { ...initial.sourceCustody, retiredCustodyField: true } },
    } } });
    if (kind === 'oauth') {
      const read = owner.oauth?.read;
      if (!read) throw new Error('Expected the retained OAuth transaction reader');
      await expect(read(initial.attemptId)).resolves.toMatchObject({ snapshot: initial });
    }
    else await expect(owner.device!.read(initial.attemptId)).resolves.toEqual(initial);
    const freshWithUnknown = { ...deviceSnapshot(), retiredSnapshotField: true };
    await expect(owner.device!.acknowledge(freshWithUnknown))
      .rejects.toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ code: 'unrecognized_keys', path: ['snapshot'], keys: ['retiredSnapshotField'] })]) });
  });

  it.each([
    ['device policy', { directExportContract: null }],
    ['direct-export policy', { directExportContract: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 }],
    ['absent policy', {}],
    ['authentication provenance', { authenticationProvenance: {
      authenticatedAt: 2_000, machine: { serverId: 'auth-home', machineId: 'auth-machine' },
    } }],
  ] as const)('persists and restores prepared settlement with %s', async (_label, policy) => {
    const api = createTransactionApi();
    const initial = deviceSnapshot();
    const owner = createQualifiedConnectedAccountAttemptTransactionAdapters({
      credentials: tokenOnlyCredentials(), ...plainAccount, api, now: () => 5_000,
    });
    await owner.device!.acknowledge(initial);
    const { directExportContract: _policy, ...settlement } = preparedDeviceSettlement(initial);
    const prepared = { ...initial, preparedSettlement: { ...settlement, ...policy, providerIdentity: { accountId: 'provider-user', organizationId: 'org-b' } } };

    await owner.device!.acknowledge(prepared);

    expect(api.records.get('device-attempt')?.revision).toBe(2);
    const replacement = createQualifiedConnectedAccountAttemptTransactionAdapters({
      credentials: tokenOnlyCredentials(), ...plainAccount, api, now: () => 5_000,
    });
    await expect(replacement.device!.read(initial.attemptId)).resolves.toEqual(prepared);
  });

  it('rejects malformed direct-export policy and unknown prepared-settlement fields without replacing custody', async () => {
    const api = createTransactionApi();
    const initial = deviceSnapshot();
    const owner = createQualifiedConnectedAccountAttemptTransactionAdapters({
      credentials: tokenOnlyCredentials(), ...plainAccount, api, now: () => 5_000,
    });
    await owner.device!.acknowledge(initial);
    const settlement = preparedDeviceSettlement(initial);
    await expect(owner.device!.acknowledge({
      ...initial,
      preparedSettlement: {
        ...settlement,
        // A malformed persisted policy must fail at the adapter's runtime boundary.
        // @ts-expect-error Deliberately invalid public input.
        directExportContract: 'unsupported-contract',
      },
    })).rejects.toMatchObject({ issues: expect.arrayContaining([
      expect.objectContaining({ path: ['snapshot', 'preparedSettlement', 'directExportContract'] }),
    ]) });
    const unknownField = { ...initial, preparedSettlement: { ...settlement, unknownPolicy: true } };
    await expect(owner.device!.acknowledge(unknownField)).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'unrecognized_keys' })]),
    });
    expect(api.records.get('device-attempt')?.revision).toBe(1);
    await expect(owner.device!.read(initial.attemptId)).resolves.toEqual(initial);
  });

  it('discovers only safe pending metadata and restores a sealed OAuth link', async () => {
    const api = createTransactionApi();
    const owner = createQualifiedConnectedAccountAttemptTransactionAdapters({
      credentials: credentials(7), ...e2eeAccount, api,
      now: () => 5_000,
      randomBytes: (length) => new Uint8Array(length).fill(3),
    });
    const starting = oauthSnapshot();
    const handle = await owner.oauth.create({
      attemptId: starting.attemptId, service: starting.service, snapshot: starting,
      callbackUrl: 'https://provider.example/oauth/callback',
    });
    expect(await owner.listPending(service)).toEqual([]);
    const authorizationUrl = 'https://provider.example/authorize?state=secret-state';
    await handle.acknowledge!({ ...starting, phase: 'awaitingOAuth', authorizationUrl });
    const pending = await owner.listPending(service);
    expect(pending).toEqual([expect.objectContaining({
      attemptId: starting.attemptId, kind: 'oauth', modeId: 'oauth', phase: 'awaitingOAuth',
    })]);
    expect(JSON.stringify(pending)).not.toContain(authorizationUrl);
    expect(JSON.stringify(pending)).not.toContain('super-secret');
    const replacement = createQualifiedConnectedAccountAttemptTransactionAdapters({
      credentials: credentials(7), ...e2eeAccount, api,
      now: () => 5_000,
      randomBytes: (length) => new Uint8Array(length).fill(4),
    });
    expect((await replacement.oauth.read!(starting.attemptId))?.snapshot.authorizationUrl)
      .toBe(authorizationUrl);
    expect(await replacement.listPending({ pluginId: service.pluginId, localId: 'other' }))
      .toEqual([]);
  });
  it('seals OAuth custody, rehydrates after restart, and consumes completion once by CAS', async () => {
    const api = createTransactionApi();
    const first = createQualifiedConnectedAccountAttemptTransactionAdapters({
      credentials: credentials(7),
      ...e2eeAccount,
      api,
      now: () => 5_000,
      randomBytes: (length) => new Uint8Array(length).fill(3),
    });
    const initial = oauthSnapshot();
    const original = await first.oauth!.create({
      attemptId: initial.attemptId,
      service: initial.service,
      snapshot: initial,
      callbackUrl: 'https://provider.example/oauth/callback',
    });
    expect(original.request.callbackUrl).toBe(
      'https://provider.example/oauth/callback',
    );
    const persisted = api.records.get('oauth-attempt');

    expect(persisted).toBeDefined();
    expect(persisted!.content.t).toBe('encrypted');
    expect(storedContentJson(persisted)).not.toContain('super-secret-access-token');
    expect(storedContentJson(persisted)).not.toContain('super-secret-configuration');
    expect(storedContentJson(persisted)).not.toContain(original.request.state);
    expect(storedContentJson(persisted)).not.toContain('verifier');

    const afterRestart =
      createQualifiedConnectedAccountAttemptTransactionAdapters({
        credentials: credentials(7),
        ...e2eeAccount,
        api,
        now: () => 5_000,
        randomBytes: (length) => new Uint8Array(length).fill(4),
      });
    const restored = await afterRestart.oauth!.read!(initial.attemptId);
    expect(restored?.snapshot).toEqual(initial);
    expect(restored?.request).toEqual(original.request);

    const discovered = { ...initial, phase: 'awaitingOAuth' as const,
      issuer: 'https://issuer.example', issuerResponseParameterRequired: true };
    await restored!.acknowledge!(discovered);
    const issuerRestored = await afterRestart.oauth!.read!(initial.attemptId);
    expect(issuerRestored?.snapshot).toMatchObject({ issuer: discovered.issuer, issuerResponseParameterRequired: true });
    await expect(restored!.acknowledge!({ ...discovered, issuer: 'https://other.example' })).rejects.toThrow();

    await expect(restored!.acknowledge!({
      ...initial,
      phase: 'awaitingOAuth',
      expectedCredentialConfigurationRevision:
        'account-configuration-drift',
    })).rejects.toThrow(
      'Connected-account OAuth transaction acknowledgement is invalid',
    );

    const completion = {
      code: 'authorization-code',
      callbackUrl: restored!.request.callbackUrl,
      state: restored!.request.state,
    };
    await expect(restored!.acceptCompletion(completion)).resolves.toEqual({
      ...completion,
      pkceVerifier: expect.any(String),
    });
    await expect(original.acceptCompletion(completion)).rejects.toMatchObject({
      code: 'connected_account_attempt_transaction_conflict',
    });

    await restored!.acknowledge!({
      ...discovered,
      phase: 'outcomeUnknown',
    });
    const consumed = api.records.get('oauth-attempt');
    expect(storedContentJson(consumed)).not.toContain(completion.state);
    expect(storedContentJson(consumed)).not.toContain('authorization-code');

    await restored!.close();
    await expect(afterRestart.oauth!.read!(initial.attemptId)).resolves.toBeNull();
  });

  it('retains device cadence and staged settlement state across restart, then deletes terminal custody', async () => {
    const api = createTransactionApi();
    const initial = deviceSnapshot();
    const first = createQualifiedConnectedAccountAttemptTransactionAdapters({
      credentials: credentials(8),
      ...e2eeAccount,
      api,
      now: () => 5_000,
      randomBytes: (length) => new Uint8Array(length).fill(5),
    });

    await first.device!.acknowledge(initial);
    const persisted = api.records.get('device-attempt');
    expect(persisted?.content.t).toBe('encrypted');
    expect(storedContentJson(persisted)).not.toContain('super-secret-refresh-token');
    expect(storedContentJson(persisted)).not.toContain('super-secret-tenant');

    const afterRestart =
      createQualifiedConnectedAccountAttemptTransactionAdapters({
        credentials: credentials(8),
        ...e2eeAccount,
        api,
        now: () => 5_000,
        randomBytes: (length) => new Uint8Array(length).fill(6),
      });
    await expect(afterRestart.device!.read(initial.attemptId)).resolves.toEqual(
      initial,
    );

    const advanced = Object.freeze({
      ...initial,
      nextPollAtMs: 15_000,
      pollIntervalMs: 7_000,
      stagedCredentials: Object.freeze({
        ...initial.stagedCredentials,
        accessToken: 'staged-access-token',
      }),
    });
    await afterRestart.device!.acknowledge(advanced);
    await expect(first.device!.read(initial.attemptId)).resolves.toEqual(
      advanced,
    );

    await afterRestart.device!.clear(initial.attemptId);
    await expect(first.device!.read(initial.attemptId)).resolves.toBeNull();
  });

  it('fails closed when a different account key tries to open transaction custody', async () => {
    const api = createTransactionApi();
    const first = createQualifiedConnectedAccountAttemptTransactionAdapters({
      credentials: credentials(9),
      ...e2eeAccount,
      api,
      now: () => 5_000,
      randomBytes: (length) => new Uint8Array(length).fill(7),
    });
    await first.device!.acknowledge(deviceSnapshot());

    const wrongAccount =
      createQualifiedConnectedAccountAttemptTransactionAdapters({
        credentials: credentials(10),
        ...e2eeAccount,
        api,
        now: () => 5_000,
      });
    await expect(
      wrongAccount.device!.read('device-attempt'),
    ).rejects.toThrow('content is unavailable for the current account mode');
  });

  it('gives a keyless plaintext Account the same durable custody through a plain envelope', async () => {
    const api = createTransactionApi();
    const initial = deviceSnapshot();
    const first = createQualifiedConnectedAccountAttemptTransactionAdapters({
      credentials: tokenOnlyCredentials(),
      ...plainAccount,
      api,
      now: () => 5_000,
      randomBytes: (length) => new Uint8Array(length).fill(5),
    });

    await first.device!.acknowledge(initial);
    const persisted = api.records.get('device-attempt');
    expect(persisted?.content.t).toBe('plain');
    expect(persisted?.content).toMatchObject({
      t: 'plain',
      v: {
        version: 2,
        snapshot: {
          sourceCustody: managedCustody,
        },
      },
    });
    expect(JSON.stringify(persisted?.content)).not.toContain('"generation"');

    const afterRestart =
      createQualifiedConnectedAccountAttemptTransactionAdapters({
        credentials: tokenOnlyCredentials(),
        ...plainAccount,
        api,
        now: () => 5_000,
      });
    await expect(afterRestart.device!.read(initial.attemptId)).resolves.toEqual(
      initial,
    );

    const oauthInitial = oauthSnapshot();
    const created = await afterRestart.oauth!.create({
      attemptId: oauthInitial.attemptId,
      service: oauthInitial.service,
      snapshot: oauthInitial,
      callbackUrl: 'https://provider.example/oauth/callback',
    });
    expect(api.records.get('oauth-attempt')?.content.t).toBe('plain');
    await expect(afterRestart.oauth!.read!(oauthInitial.attemptId))
      .resolves.toMatchObject({
        snapshot: oauthInitial,
        request: created.request,
      });
  });

  it.each([
    Object.freeze({
      name: 'bundled CLI version root',
      custody: Object.freeze({
        kind: 'bundled_first_party' as const,
        packagedRuntime: Object.freeze({
          kind: 'cli_version_root' as const,
          versionRootId: 'cli-version-1',
        }),
      }),
    }),
    Object.freeze({
      name: 'bundled pinned runner snapshot',
      custody: Object.freeze({
        kind: 'bundled_first_party' as const,
        packagedRuntime: Object.freeze({
          kind: 'pinned_runner_snapshot' as const,
          snapshotId: 'runner-snapshot-1',
        }),
      }),
    }),
    Object.freeze({
      name: 'registered development root',
      custody: Object.freeze({
        kind: 'development' as const,
        registeredRootId: 'development-root-1',
      }),
    }),
  ])('round-trips $name custody across restart without persisting occurrence', async ({ custody }) => {
    const api = createTransactionApi();
    const first = createQualifiedConnectedAccountAttemptTransactionAdapters({
      credentials: tokenOnlyCredentials(),
      ...plainAccount,
      api,
      now: () => 5_000,
    });
    const initial = deviceSnapshot(custody);

    await first.device!.acknowledge(initial);
    const persisted = api.records.get('device-attempt');
    expect(persisted?.content).toMatchObject({
      t: 'plain',
      v: {
        version: 2,
        snapshot: { sourceCustody: custody },
      },
    });
    expect(JSON.stringify(persisted?.content)).not.toContain('occurrence');

    const restarted = createQualifiedConnectedAccountAttemptTransactionAdapters({
      credentials: tokenOnlyCredentials(),
      ...plainAccount,
      api,
      now: () => 5_000,
    });
    await expect(restarted.device!.read(initial.attemptId)).resolves.toEqual(initial);
  });

  it('refuses a stored envelope whose kind disagrees with the persisted Account mode', async () => {
    const api = createTransactionApi();
    const sealedByE2ee =
      createQualifiedConnectedAccountAttemptTransactionAdapters({
        credentials: credentials(12),
        ...e2eeAccount,
        api,
        now: () => 5_000,
        randomBytes: (length) => new Uint8Array(length).fill(5),
      });
    await sealedByE2ee.device!.acknowledge(deviceSnapshot());

    // The Account transitioned to plain while the sealed row stayed encrypted.
    const readAsPlain =
      createQualifiedConnectedAccountAttemptTransactionAdapters({
        credentials: credentials(12),
        ...plainAccount,
        api,
        now: () => 5_000,
      });
    await expect(readAsPlain.device!.read('device-attempt')).rejects.toThrow(
      'does not match the persisted Account encryption mode',
    );

    const plainApi = createTransactionApi();
    const sealedByPlain =
      createQualifiedConnectedAccountAttemptTransactionAdapters({
        credentials: tokenOnlyCredentials(),
        ...plainAccount,
        api: plainApi,
        now: () => 5_000,
      });
    await sealedByPlain.device!.acknowledge(deviceSnapshot());
    const readAsE2ee =
      createQualifiedConnectedAccountAttemptTransactionAdapters({
        credentials: credentials(12),
        ...e2eeAccount,
        api: plainApi,
        now: () => 5_000,
      });
    await expect(readAsE2ee.device!.read('device-attempt')).rejects.toThrow(
      'does not match the persisted Account encryption mode',
    );
  });

  it('rejects snapshots that omit the immutable credential-configuration CAS basis', async () => {
    const adapters = createQualifiedConnectedAccountAttemptTransactionAdapters({
      credentials: credentials(11),
      ...e2eeAccount,
      api: createTransactionApi(),
      now: () => 5_000,
    });
    const { expectedCredentialConfigurationRevision: _omitted, ...oldOAuth } =
      oauthSnapshot();
    const { expectedCredentialConfigurationRevision: _alsoOmitted, ...oldDevice } =
      deviceSnapshot();

    await expect(adapters.oauth!.create({
      attemptId: oldOAuth.attemptId,
      service: oldOAuth.service,
      snapshot: oldOAuth as ConnectedAccountOAuthTransactionSnapshot,
    })).rejects.toThrow();
    await expect(adapters.device!.acknowledge(
      oldDevice as ConnectedAccountDeviceTransactionSnapshot,
    )).rejects.toThrow();
  });

  it('drops stored occurrence and retired generation fields while preserving canonical source custody', async () => {
    const api = createTransactionApi();
    const snapshot = deviceSnapshot();
    api.records.set('device-attempt', Object.freeze({
      kind: 'device',
      scope: Object.freeze({ machineId: 'machine-1', service: snapshot.service, modeId: snapshot.modeId,
        intent: snapshot.intent, phase: 'awaitingDeviceAuthorization', createdAtMs: snapshot.createdAtMs }),
      revision: 1,
      expiresAtMs: 60_000,
      content: {
        t: 'plain' as const,
        v: {
          version: 2,
          kind: 'device',
          snapshot: {
            ...snapshot,
            occurrenceId: 'process-local-occurrence',
            generation: 'retired-generation',
          },
        },
      },
    }));
    const adapters = createQualifiedConnectedAccountAttemptTransactionAdapters({
      credentials: tokenOnlyCredentials(),
      ...plainAccount,
      api,
      now: () => 5_000,
    });

    await expect(adapters.device!.read(snapshot.attemptId)).resolves.toEqual(snapshot);
  });

  it('rejects the obsolete V1 generation-shaped payload instead of fabricating source custody', async () => {
    const api = createTransactionApi();
    const current = deviceSnapshot();
    const { sourceCustody: _custody, ...legacyRest } = current;
    api.records.set('device-attempt', Object.freeze({
      kind: 'device',
      scope: Object.freeze({ machineId: 'machine-1', service: current.service, modeId: current.modeId,
        intent: current.intent, phase: 'awaitingDeviceAuthorization', createdAtMs: current.createdAtMs }),
      revision: 1,
      expiresAtMs: 60_000,
      content: {
        t: 'plain' as const,
        v: {
          version: 1,
          kind: 'device',
          snapshot: {
            ...legacyRest,
            immutableGenerationId: 'artifact-sha256',
          },
        },
      },
    }));
    const adapters = createQualifiedConnectedAccountAttemptTransactionAdapters({
      credentials: tokenOnlyCredentials(),
      ...plainAccount,
      api,
      now: () => 5_000,
    });

    await expect(adapters.device!.read(current.attemptId)).rejects.toThrow();
  });
});
