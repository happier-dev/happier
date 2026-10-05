import { describe, expect, it } from 'vitest';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/protocol';

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
} from '@/plugins/runtime/connectedAccounts/authenticationAttemptOwner';
import type { PluginSourceCustody } from '@/plugins/runtime/sourceAuthority';

import {
  createQualifiedConnectedAccountAttemptTransactionAdapters,
} from './qualifiedConnectedAccountAttemptTransactionAdapters';

function transactionKey(
  kind: ConnectedAccountAttemptTransactionKind,
  attemptId: string,
): string {
  return `${kind}:${attemptId}`;
}

function createTransactionApi(): ConnectedAccountAttemptTransactionStoreApi & {
  records: Map<string, ConnectedAccountAttemptTransactionRecord>;
} {
  const records = new Map<string, ConnectedAccountAttemptTransactionRecord>();
  const scopes = new Map<string, Parameters<ConnectedAccountAttemptTransactionStoreApi['create']>[0]['scope']>();
  return {
    records,
    async create(input) {
      const key = transactionKey(input.kind, input.attemptId);
      if (records.has(key)) {
        throw new ConnectedAccountAttemptTransactionApiError(
          'connected_account_attempt_transaction_conflict',
        );
      }
      const record = Object.freeze({
        revision: 1,
        content: input.content,
        expiresAtMs: input.expiresAtMs,
      });
      records.set(key, record);
      scopes.set(key, input.scope);
      return record;
    },
    async read(input) {
      return records.get(transactionKey(input.kind, input.attemptId)) ?? null;
    },
    async replace(input) {
      const key = transactionKey(input.kind, input.attemptId);
      const current = records.get(key);
      if (!current || current.revision !== input.expectedRevision) {
        throw new ConnectedAccountAttemptTransactionApiError(
          'connected_account_attempt_transaction_conflict',
        );
      }
      const record = Object.freeze({
        revision: current.revision + 1,
        content: input.content,
        expiresAtMs: input.expiresAtMs,
      });
      records.set(key, record);
      scopes.set(key, input.scope);
      return record;
    },
    async delete(input) {
      const key = transactionKey(input.kind, input.attemptId);
      const current = records.get(key);
      if (!current || current.revision !== input.expectedRevision) {
        throw new ConnectedAccountAttemptTransactionApiError(
          'connected_account_attempt_transaction_conflict',
        );
      }
      records.delete(key);
      scopes.delete(key);
    },
    async listPending(input) {
      return [...scopes.entries()].flatMap(([key, scope]) => {
        const record = records.get(key);
        if (!record || scope.machineId !== input.machineId
          || scope.service.pluginId !== input.service.pluginId
          || scope.service.localId !== input.service.localId
          || scope.phase === 'starting') return [];
        const [kind, attemptId] = key.split(':');
        if (kind !== 'oauth' && kind !== 'device' || !attemptId) return [];
        return [{ attemptId, kind, modeId: scope.modeId, intent: scope.intent,
          phase: scope.phase, createdAtMs: scope.createdAtMs, expiresAtMs: record.expiresAtMs }];
      });
    },
  };
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
  it.each([
    ['device policy', { directExportContract: null }],
    ['direct-export policy', { directExportContract: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 }],
    ['absent policy', {}],
  ] as const)('persists and restores prepared settlement with %s', async (_label, policy) => {
    const api = createTransactionApi();
    const initial = deviceSnapshot();
    const owner = createQualifiedConnectedAccountAttemptTransactionAdapters({
      credentials: tokenOnlyCredentials(), ...plainAccount, api, now: () => 5_000,
    });
    await owner.device!.acknowledge(initial);
    const { directExportContract: _policy, ...settlement } = preparedDeviceSettlement(initial);
    const prepared = { ...initial, preparedSettlement: { ...settlement, ...policy } };

    await owner.device!.acknowledge(prepared);

    expect(api.records.get('device:device-attempt')?.revision).toBe(2);
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
    expect(api.records.get('device:device-attempt')?.revision).toBe(1);
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
    const persisted = api.records.get('oauth:oauth-attempt');

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
      ...initial,
      phase: 'outcomeUnknown',
    });
    const consumed = api.records.get('oauth:oauth-attempt');
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
    const persisted = api.records.get('device:device-attempt');
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
    const persisted = api.records.get('device:device-attempt');
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
    });
    expect(api.records.get('oauth:oauth-attempt')?.content.t).toBe('plain');
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
    const persisted = api.records.get('device:device-attempt');
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

  it('strictly rejects occurrence and retired generation fields in V2 payloads', async () => {
    const api = createTransactionApi();
    const snapshot = deviceSnapshot();
    api.records.set('device:device-attempt', Object.freeze({
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

    await expect(adapters.device!.read(snapshot.attemptId)).rejects.toThrow();
  });

  it('rejects the obsolete V1 generation-shaped payload instead of fabricating source custody', async () => {
    const api = createTransactionApi();
    const current = deviceSnapshot();
    const { sourceCustody: _custody, ...legacyRest } = current;
    api.records.set('device:device-attempt', Object.freeze({
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
