import { describe, expect, it } from 'vitest';

import {
  ConnectedAccountAttemptTransactionApiError,
  type ConnectedAccountAttemptTransactionKind,
  type ConnectedAccountAttemptTransactionRecord,
  type ConnectedAccountAttemptTransactionStoreApi,
} from '@/api/client/connectedAccountAttemptTransactionApi';
import type { Credentials } from '@/persistence';
import type {
  ConnectedAccountDeviceTransactionSnapshot,
  ConnectedAccountOAuthTransactionSnapshot,
} from '@/plugins/runtime/connectedAccounts/authenticationAttemptOwner';

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
        ciphertext: input.ciphertext,
        expiresAtMs: input.expiresAtMs,
      });
      records.set(key, record);
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
        ciphertext: input.ciphertext,
        expiresAtMs: input.expiresAtMs,
      });
      records.set(key, record);
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

const service = Object.freeze({
  pluginId: 'example.plugin',
  localId: 'example.account-service',
});

function oauthSnapshot(): ConnectedAccountOAuthTransactionSnapshot {
  return Object.freeze({
    attemptId: 'oauth-attempt',
    createdAtMs: 1_000,
    intent: 'connect',
    service,
    modeId: 'oauth',
    immutableGenerationId: 'artifact-sha256',
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

function deviceSnapshot(): ConnectedAccountDeviceTransactionSnapshot {
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
    immutableGenerationId: 'artifact-sha256',
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

describe('qualified Connected Account attempt transaction adapters', () => {
  it('seals OAuth custody, rehydrates after restart, and consumes completion once by CAS', async () => {
    const api = createTransactionApi();
    const first = createQualifiedConnectedAccountAttemptTransactionAdapters({
      credentials: credentials(7),
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
    expect(persisted!.ciphertext).not.toContain('super-secret-access-token');
    expect(persisted!.ciphertext).not.toContain('super-secret-configuration');
    expect(persisted!.ciphertext).not.toContain(original.request.state);
    expect(persisted!.ciphertext).not.toContain('verifier');

    const afterRestart =
      createQualifiedConnectedAccountAttemptTransactionAdapters({
        credentials: credentials(7),
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
    expect(consumed?.ciphertext).not.toContain(completion.state);
    expect(consumed?.ciphertext).not.toContain('authorization-code');

    await restored!.close();
    await expect(afterRestart.oauth!.read!(initial.attemptId)).resolves.toBeNull();
  });

  it('retains device cadence and staged settlement state across restart, then deletes terminal custody', async () => {
    const api = createTransactionApi();
    const initial = deviceSnapshot();
    const first = createQualifiedConnectedAccountAttemptTransactionAdapters({
      credentials: credentials(8),
      api,
      now: () => 5_000,
      randomBytes: (length) => new Uint8Array(length).fill(5),
    });

    await first.device!.acknowledge(initial);
    const persisted = api.records.get('device:device-attempt');
    expect(persisted?.ciphertext).not.toContain('super-secret-refresh-token');
    expect(persisted?.ciphertext).not.toContain('super-secret-tenant');

    const afterRestart =
      createQualifiedConnectedAccountAttemptTransactionAdapters({
        credentials: credentials(8),
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
      api,
      now: () => 5_000,
      randomBytes: (length) => new Uint8Array(length).fill(7),
    });
    await first.device!.acknowledge(deviceSnapshot());

    const wrongAccount =
      createQualifiedConnectedAccountAttemptTransactionAdapters({
        credentials: credentials(10),
        api,
        now: () => 5_000,
      });
    await expect(
      wrongAccount.device!.read('device-attempt'),
    ).rejects.toThrow('cannot be decrypted');
  });

  it('rejects snapshots that omit the immutable credential-configuration CAS basis', async () => {
    const adapters = createQualifiedConnectedAccountAttemptTransactionAdapters({
      credentials: credentials(11),
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
});
