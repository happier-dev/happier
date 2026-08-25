import { describe, expect, it, vi } from 'vitest';

import {
  sealAccountScopedBlobCiphertext,
  type AccountSettingsStoredContentEnvelope,
  type AccountSettingsV2UpdateResponse,
} from '@happier-dev/protocol';

import type { Credentials, TokenOnlyCredentials } from '@/persistence';
import {
  updateAccountSettingsV2Once,
  updateAccountSettingsV2WithRetry,
  type UpdateAccountSettingsV2WithRetryParams,
} from './updateAccountSettingsV2WithRetry';

function createCredentials(): Credentials {
  return {
    token: 'account-token',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
  };
}

function createTokenOnlyCredentials(): TokenOnlyCredentials {
  return { token: 'account-token', encryption: null };
}

const callbackRetryParams = {
  credentials: createCredentials(),
  mutate: (settings: Readonly<Record<string, unknown>>) => settings,
};
const callbackRetryMustBeAccepted: UpdateAccountSettingsV2WithRetryParams = callbackRetryParams;
void callbackRetryMustBeAccepted;

describe('updateAccountSettingsV2WithRetry canonical mutation contract', () => {
  it('fails closed before mutation or POST when persisted E2EE mode disagrees with plain content', async () => {
    const updateSettings = vi.fn(async (): Promise<AccountSettingsV2UpdateResponse> => ({
      success: true,
      version: 5,
    }));

    await expect(updateAccountSettingsV2WithRetry({
      credentials: createCredentials(),
      mutation: {
        operations: [{
          op: 'set',
          key: 'sessionPendingQueueDeliveryTiming',
          value: 'after_runtime_idle',
        }],
      },
      deps: {
        fetchSettings: async () => ({
          content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_foreground_ready' } },
          version: 4,
        }),
        resolveAccountEncryptionMode: async () => 'e2ee',
        updateSettings,
      },
    })).resolves.toEqual({ status: 'locked', reason: 'modeMismatch' });

    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('fails closed before decrypt or POST when persisted plain mode disagrees with encrypted content', async () => {
    const credentials = createCredentials();
    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
      payload: { sessionPendingQueueDeliveryTiming: 'after_foreground_ready' },
      randomBytes: () => new Uint8Array(24).fill(2),
    });
    const updateSettings = vi.fn();

    await expect(updateAccountSettingsV2WithRetry({
      credentials,
      mutation: {
        operations: [{
          op: 'reset',
          key: 'sessionPendingQueueDeliveryTiming',
        }],
      },
      deps: {
        fetchSettings: async () => ({ content: { t: 'encrypted', c: ciphertext }, version: 4 }),
        resolveAccountEncryptionMode: async () => 'plain',
        updateSettings,
      },
    })).resolves.toEqual({ status: 'locked', reason: 'modeMismatch' });

    expect(updateSettings).not.toHaveBeenCalled();
  });

  it.each([
    ['authentication refusal', Object.assign(new Error('unauthorized'), { status: 401 }), false],
    ['unsupported V2 route', Object.assign(new Error('not found'), { status: 404 }), false],
    ['malformed successful response', new Error('Failed to parse account settings v2 response'), false],
    ['known server outage', Object.assign(new Error('server unavailable'), { status: 503 }), true],
  ] as const)('returns a total tagged result for a pre-mutation fetch %s', async (_label, failure, retryable) => {
    await expect(updateAccountSettingsV2WithRetry({
      credentials: createCredentials(),
      mutation: {
        operations: [{ op: 'reset', key: 'sessionPendingQueueDeliveryTiming' }],
      },
      deps: {
        fetchSettings: async () => { throw failure; },
      },
    })).resolves.toEqual({ status: 'unavailable', retryable });

  });

  it.each([
    ['authentication refusal', Object.assign(new Error('unauthorized'), { status: 401 }), false],
    ['malformed mode response', new Error('Failed to parse account encryption mode response'), false],
    ['known server outage', Object.assign(new Error('server unavailable'), { status: 503 }), true],
  ] as const)('returns a total tagged result when Account mode resolution meets %s', async (_label, failure, retryable) => {
    const updateSettings = vi.fn();

    await expect(updateAccountSettingsV2WithRetry({
      credentials: createTokenOnlyCredentials(),
      mutation: {
        operations: [{ op: 'reset', key: 'sessionPendingQueueDeliveryTiming' }],
      },
      deps: {
        fetchSettings: async () => ({ content: null, version: 0 }),
        resolveAccountEncryptionMode: async () => { throw failure; },
        updateSettings,
      },
    })).resolves.toEqual({ status: 'unavailable', retryable });

    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('reapplies an immutable reset to the fresh raw baseline after conflict without replaying a callback', async () => {
    const posts: AccountSettingsStoredContentEnvelope[] = [];
    let attempt = 0;

    const result = await updateAccountSettingsV2WithRetry({
      credentials: createCredentials(),
      mutation: {
        operations: [{ op: 'reset', key: 'sessionPendingQueueDeliveryTiming' }],
      },
      deps: {
        fetchSettings: async () => ({
          content: {
            t: 'plain',
            v: {
              sessionPendingQueueDeliveryTiming: 'after_foreground_ready',
              futureSetting: { original: true },
            },
          },
          version: 7,
        }),
        resolveAccountEncryptionMode: async () => 'plain',
        updateSettings: async (request): Promise<AccountSettingsV2UpdateResponse> => {
          attempt += 1;
          if (request.content) posts.push(request.content);
          if (attempt === 1) {
            return {
              success: false,
              error: 'version-mismatch',
              currentVersion: 8,
              currentContent: {
                t: 'plain',
                v: {
                  sessionPendingQueueDeliveryTiming: 'after_foreground_ready',
                  futureSetting: { concurrent: true },
                },
              },
            };
          }
          return { success: true, version: 9 };
        },
      },
    });

    expect(result).toMatchObject({ status: 'applied', version: 9 });
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual({
      t: 'plain',
      v: { futureSetting: { concurrent: true } },
    });
  });

  it('re-evaluates a retryable callback against every CAS winner instead of replaying its first raw result', async () => {
    const observedSourceValues: unknown[] = [];
    const posts: AccountSettingsStoredContentEnvelope[] = [];
    let attempt = 0;

    const result = await updateAccountSettingsV2WithRetry({
      credentials: createCredentials(),
      mutate: (settings) => {
        observedSourceValues.push(settings.providerMigrationSource);
        return {
          ...settings,
          providerMigrationWitness: `derived:${String(settings.providerMigrationSource)}`,
        };
      },
      deps: {
        fetchSettings: async () => ({
          content: { t: 'plain', v: { providerMigrationSource: 'initial' } },
          version: 7,
        }),
        resolveAccountEncryptionMode: async () => 'plain',
        updateSettings: async (request): Promise<AccountSettingsV2UpdateResponse> => {
          attempt += 1;
          if (request.content) posts.push(request.content);
          if (attempt === 1) {
            return {
              success: false,
              error: 'version-mismatch',
              currentVersion: 8,
              currentContent: { t: 'plain', v: { providerMigrationSource: 'winner' } },
            };
          }
          return { success: true, version: 9 };
        },
      },
    });

    expect(result).toMatchObject({ status: 'applied', version: 9 });
    expect(observedSourceValues).toEqual(['initial', 'winner']);
    expect(posts).toEqual([
      { t: 'plain', v: { providerMigrationSource: 'initial', providerMigrationWitness: 'derived:initial' } },
      { t: 'plain', v: { providerMigrationSource: 'winner', providerMigrationWitness: 'derived:winner' } },
    ]);
  });

  it('rejects an unrelated immutable operation when a retained known root is overdeep, with zero POST', async () => {
    let overdeep: unknown = 'leaf';
    for (let depth = 0; depth < 14; depth += 1) overdeep = { child: overdeep };
    const updateSettings = vi.fn();

    await expect(updateAccountSettingsV2WithRetry({
      credentials: createCredentials(),
      mutation: {
        operations: [{
          op: 'set',
          key: 'sessionPendingQueueDeliveryTiming',
          value: 'after_runtime_idle',
        }],
      },
      deps: {
        fetchSettings: async () => ({
          content: {
            t: 'plain',
            v: {
              // A known root whose shape the Account document itself owns.
              // `providerSettingsV1` is deliberately NOT usable here: its
              // catalog definition declares `structuralBoundsOwner:
              // 'domainOwned'`, so the Provider domain — not the Account
              // node policy — bounds its nesting and cardinality.
              profiles: overdeep,
              sessionPendingQueueDeliveryTiming: 'after_foreground_ready',
            },
          },
          version: 4,
        }),
        resolveAccountEncryptionMode: async () => 'plain',
        updateSettings,
      },
    })).resolves.toEqual({ status: 'invalid', reason: 'tooDeep' });

    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('rejects an unrelated immutable operation when a retained future root is overdeep, with zero POST', async () => {
    let overdeep: unknown = 'leaf';
    for (let depth = 0; depth < 14; depth += 1) overdeep = { child: overdeep };
    const updateSettings = vi.fn();

    await expect(updateAccountSettingsV2WithRetry({
      credentials: createCredentials(),
      mutation: {
        operations: [{
          op: 'set',
          key: 'sessionPendingQueueDeliveryTiming',
          value: 'after_runtime_idle',
        }],
      },
      deps: {
        fetchSettings: async () => ({
          content: {
            t: 'plain',
            v: {
              futureSettingOwnedElsewhere: overdeep,
              sessionPendingQueueDeliveryTiming: 'after_foreground_ready',
            },
          },
          version: 4,
        }),
        resolveAccountEncryptionMode: async () => 'plain',
        updateSettings,
      },
    })).resolves.toEqual({ status: 'invalid', reason: 'tooDeep' });

    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('allows an explicit reset to remove a malformed named root', async () => {
    const updateSettings = vi.fn(async (): Promise<AccountSettingsV2UpdateResponse> => ({
      success: true,
      version: 5,
    }));

    await expect(updateAccountSettingsV2WithRetry({
      credentials: createCredentials(),
      mutation: {
        operations: [{ op: 'reset', key: 'promptExternalLinksV1' }],
      },
      deps: {
        fetchSettings: async () => ({
          content: {
            t: 'plain',
            v: {
              promptExternalLinksV1: 'malformed-present-root',
              futureSettingOwnedElsewhere: { preserve: true },
            },
          },
          version: 4,
        }),
        resolveAccountEncryptionMode: async () => 'plain',
        updateSettings,
      },
    })).resolves.toMatchObject({ status: 'applied', version: 5 });

    expect(updateSettings).toHaveBeenCalledWith({
      expectedVersion: 4,
      content: {
        t: 'plain',
        v: { futureSettingOwnedElsewhere: { preserve: true } },
      },
    });
  });

  // A byte-identical Account write still bumps the version and records two
  // history snapshots at the server, and for an E2EE Account the server cannot
  // even recognise the reseal as a no-op. The client owner is therefore the
  // only place that can keep a no-op out of history: it must settle before the
  // transport, not after it.
  it('settles an exact no-op without a transport write on plain and E2EE Accounts', async () => {
    const noOpCacheDeps = {
      resolveCachePath: () => '/dev/null/account-settings-cache.json',
      writeCache: vi.fn(async () => {}),
    };
    // The transport mock is deliberately capable of succeeding: the guard must
    // be proven by the absent call, not by a crashing stub.
    const plainUpdate = vi.fn(async (): Promise<AccountSettingsV2UpdateResponse> => ({
      success: true,
      version: 5,
    }));
    await expect(updateAccountSettingsV2WithRetry({
      credentials: createCredentials(),
      mutation: {
        operations: [{
          op: 'set',
          key: 'sessionPendingQueueDeliveryTiming',
          value: 'after_foreground_ready',
        }],
      },
      deps: {
        ...noOpCacheDeps,
        fetchSettings: async () => ({
          content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_foreground_ready' } },
          version: 4,
        }),
        resolveAccountEncryptionMode: async () => 'plain',
        updateSettings: plainUpdate,
      },
    })).resolves.toMatchObject({ status: 'unchanged', version: 4 });
    expect(plainUpdate).not.toHaveBeenCalled();

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
      payload: { sessionPendingQueueDeliveryTiming: 'after_foreground_ready' },
      randomBytes: () => new Uint8Array(24).fill(2),
    });
    const encryptedUpdate = vi.fn(async (): Promise<AccountSettingsV2UpdateResponse> => ({
      success: true,
      version: 10,
    }));
    await expect(updateAccountSettingsV2WithRetry({
      credentials: createCredentials(),
      mutation: {
        operations: [{
          op: 'set',
          key: 'sessionPendingQueueDeliveryTiming',
          value: 'after_foreground_ready',
        }],
      },
      deps: {
        ...noOpCacheDeps,
        fetchSettings: async () => ({ content: { t: 'encrypted', c: ciphertext }, version: 9 }),
        resolveAccountEncryptionMode: async () => 'e2ee',
        // A fresh nonce would reseal to different bytes, so a post-seal
        // comparison could not recognise this no-op.
        randomBytes: () => new Uint8Array(24).fill(3),
        updateSettings: encryptedUpdate,
      },
    })).resolves.toMatchObject({ status: 'unchanged', version: 9 });
    expect(encryptedUpdate).not.toHaveBeenCalled();

    const onceUpdate = vi.fn(async (): Promise<AccountSettingsV2UpdateResponse> => ({
      success: true,
      version: 5,
    }));
    await expect(updateAccountSettingsV2Once({
      credentials: createCredentials(),
      expectedVersion: 4,
      mutate: (settings) => settings,
      deps: {
        ...noOpCacheDeps,
        fetchSettings: async () => ({
          content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_foreground_ready' } },
          version: 4,
        }),
        resolveAccountEncryptionMode: async () => 'plain',
        updateSettings: onceUpdate,
      },
    })).resolves.toMatchObject({ status: 'unchanged', version: 4 });
    expect(onceUpdate).not.toHaveBeenCalled();

    // Positive twin: a real change still reaches the transport exactly once.
    const changingUpdate = vi.fn(async (): Promise<AccountSettingsV2UpdateResponse> => ({
      success: true,
      version: 5,
    }));
    await expect(updateAccountSettingsV2WithRetry({
      credentials: createCredentials(),
      mutation: {
        operations: [{
          op: 'set',
          key: 'sessionPendingQueueDeliveryTiming',
          value: 'after_runtime_idle',
        }],
      },
      deps: {
        ...noOpCacheDeps,
        fetchSettings: async () => ({
          content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_foreground_ready' } },
          version: 4,
        }),
        resolveAccountEncryptionMode: async () => 'plain',
        updateSettings: changingUpdate,
      },
    })).resolves.toMatchObject({ status: 'applied', version: 5 });
    expect(changingUpdate).toHaveBeenCalledTimes(1);
  });
});
