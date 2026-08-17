import { describe, it, expect, vi } from 'vitest';
import { encodeBase64 } from '@/encryption/base64';
import { Encryption } from './encryption';
import { createFakeCryptoWorker } from './nativeCryptoWorker/fakeCryptoWorker';
import type { NativeCryptoWorker } from './nativeCryptoWorker/types';

type EncryptionGenerationReader = Readonly<{
  getCurrentGeneration: (accountId?: string, serverId?: string | null) => number;
}>;

type EncryptionGenerationScopeReader = Readonly<{
  getCurrentEncryptionGenerationScope: (scope?: { accountId?: string; serverId?: string | null }) => {
    accountId: string;
    serverId: string | null;
    generation: number;
  };
  isCurrentEncryptionGenerationScope: (scope: { accountId: string; serverId: string | null; generation: number }) => boolean;
}>;

function expectGenerationReader(encryption: Encryption): EncryptionGenerationReader {
  const candidate = encryption as Encryption & Partial<EncryptionGenerationReader>;
  expect(typeof candidate.getCurrentGeneration).toBe('function');
  return candidate as Encryption & EncryptionGenerationReader;
}

function expectGenerationScopeReader(encryption: Encryption): EncryptionGenerationScopeReader {
  const candidate = encryption as Encryption & Partial<EncryptionGenerationScopeReader>;
  expect(typeof candidate.getCurrentEncryptionGenerationScope).toBe('function');
  expect(typeof candidate.isCurrentEncryptionGenerationScope).toBe('function');
  return candidate as Encryption & EncryptionGenerationScopeReader;
}

describe('Encryption.initializeSessions (key updates)', () => {
  it('updates session encryption when a data key becomes available later', async () => {
    const masterSecret = new Uint8Array(32).fill(1);
    const sessionDataKey = new Uint8Array(32).fill(2);
    const sessionId = 'session_1';

    const encryption = await Encryption.create(masterSecret);

    // First initialize without a data key (fallback encryption).
    await encryption.initializeSessions(new Map([[sessionId, null]]));
    const before = encryption.getSessionEncryption(sessionId);
    expect(before).toBeTruthy();

    // Encrypt a payload using the session data key (AES mode).
    const aes = await encryption.openEncryption(sessionDataKey);
    const payload = { hello: 'world' };
    const encrypted = await aes.encrypt([payload]);
    const ciphertextB64 = encodeBase64(encrypted[0], 'base64');

    // With fallback encryption, decrypting AES ciphertext must fail.
    expect(await before!.decryptRaw(ciphertextB64)).toBeNull();

    // Later, the data key becomes available (e.g. after decryptEncryptionKey succeeds).
    await encryption.initializeSessions(new Map([[sessionId, sessionDataKey]]));
    const after = encryption.getSessionEncryption(sessionId);
    expect(after).toBeTruthy();

    // After re-initialization, decryption should succeed.
    expect(await after!.decryptRaw(ciphertextB64)).toEqual(payload);
  });

  it('keeps worker generation stable for no-op session initialization', async () => {
    const encryption = await Encryption.create(new Uint8Array(32).fill(1));
    const generation = expectGenerationReader(encryption);
    const sessionDataKey = new Uint8Array(32).fill(2);

    await encryption.initializeSessions(new Map([['session_1', sessionDataKey]]), {
      accountId: 'account-a',
      serverId: 'server-a',
    });
    const afterInitial = generation.getCurrentGeneration('account-a', 'server-a');

    await encryption.initializeSessions(new Map([['session_1', sessionDataKey]]), {
      accountId: 'account-a',
      serverId: 'server-a',
    });

    expect(generation.getCurrentGeneration('account-a', 'server-a')).toBe(afterInitial);
  });

  it('increments worker generation when an existing session key fingerprint changes', async () => {
    const encryption = await Encryption.create(new Uint8Array(32).fill(1));
    const generation = expectGenerationReader(encryption);

    await encryption.initializeSessions(new Map([['session_1', new Uint8Array(32).fill(2)]]), {
      accountId: 'account-a',
      serverId: 'server-a',
    });
    expect(generation.getCurrentGeneration('account-a', 'server-a')).toBe(0);

    await encryption.initializeSessions(new Map([['session_1', new Uint8Array(32).fill(3)]]), {
      accountId: 'account-a',
      serverId: 'server-a',
    });

    expect(generation.getCurrentGeneration('account-a', 'server-a')).toBe(1);
  });

  it('invalidates the previous owning scope when a session is rebound to a different account or server', async () => {
    const encryption = await Encryption.create(new Uint8Array(32).fill(1));
    const generation = expectGenerationReader(encryption);
    const generationScope = expectGenerationScopeReader(encryption);
    const sessionDataKey = new Uint8Array(32).fill(2);

    await encryption.initializeSessions(new Map([['session_1', sessionDataKey]]), {
      accountId: 'account-a',
      serverId: 'server-a',
    });

    const captured = generationScope.getCurrentEncryptionGenerationScope({
      accountId: 'account-a',
      serverId: 'server-a',
    });

    await encryption.initializeSessions(new Map([['session_1', sessionDataKey]]), {
      accountId: 'account-b',
      serverId: 'server-b',
    });

    expect(generationScope.isCurrentEncryptionGenerationScope(captured)).toBe(false);
    expect(generation.getCurrentGeneration('account-a', 'server-a')).toBe(1);
    expect(generation.getCurrentGeneration('account-b', 'server-b')).toBe(0);
  });

  it('isolates worker generation by account and server scope', async () => {
    const encryption = await Encryption.create(new Uint8Array(32).fill(1));
    const generation = expectGenerationReader(encryption);

    await encryption.initializeSessions(new Map([['session_a', new Uint8Array(32).fill(2)]]), {
      accountId: 'account-a',
      serverId: 'server-a',
    });
    await encryption.initializeSessions(new Map([['session_b', new Uint8Array(32).fill(3)]]), {
      accountId: 'account-a',
      serverId: 'server-b',
    });
    await encryption.initializeSessions(new Map([['session_a', new Uint8Array(32).fill(4)]]), {
      accountId: 'account-a',
      serverId: 'server-a',
    });

    expect(generation.getCurrentGeneration('account-a', 'server-a')).toBe(1);
    expect(generation.getCurrentGeneration('account-a', 'server-b')).toBe(0);
    expect(generation.getCurrentGeneration('account-b', 'server-a')).toBe(0);
  });

  it('increments worker generation for the owning scope when session encryption is removed', async () => {
    const encryption = await Encryption.create(new Uint8Array(32).fill(1));
    const generation = expectGenerationReader(encryption);

    await encryption.initializeSessions(new Map([['session_1', new Uint8Array(32).fill(2)]]), {
      accountId: 'account-a',
      serverId: 'server-a',
    });

    encryption.removeSessionEncryption('session_1');

    expect(generation.getCurrentGeneration('account-a', 'server-a')).toBe(1);
    expect(generation.getCurrentGeneration('account-a', 'server-b')).toBe(0);
  });

  it('does not install a session key after initialization currentness is revoked', async () => {
    const encryption = await Encryption.create(new Uint8Array(32).fill(1));
    let current = true;

    const initialization = encryption.initializeSessions(
      new Map([['session_deleted_during_initialization', new Uint8Array(32).fill(2)]]),
      { shouldContinue: () => current },
    );
    current = false;
    await initialization;

    expect(
      encryption.getSessionEncryption('session_deleted_during_initialization'),
    ).toBeNull();
  });

  it('routes session AES native decrypt batches with the session owning scope', async () => {
    const encryption = await Encryption.create(new Uint8Array(32).fill(1));
    const baseWorker = createFakeCryptoWorker();
    const decryptAesGcmJson = vi.fn(baseWorker.decryptAesGcmJson.bind(baseWorker));
    const worker: NativeCryptoWorker = {
      ...baseWorker,
      decryptAesGcmJson,
    };

    encryption.configureNativeCryptoWorker({
      worker,
      routing: {
        mode: 'require',
        minPayloadBytes: 0,
        minBatchSize: 1,
      },
      scope: {
        accountId: 'account-a',
        serverId: 'server-a',
        generation: 0,
      },
    });

    await encryption.initializeSessions(new Map([['session_1', new Uint8Array(32).fill(2)]]), {
      accountId: 'account-a',
      serverId: 'server-b',
    });
    const sessionEncryption = encryption.getSessionEncryption('session_1');
    expect(sessionEncryption).toBeTruthy();

    const encrypted = await sessionEncryption!.encryptRaw({ hello: 'owner-scope' });

    await expect(sessionEncryption!.decryptRaw(encrypted)).resolves.toEqual({ hello: 'owner-scope' });
    expect(decryptAesGcmJson).toHaveBeenCalledTimes(1);
    expect(decryptAesGcmJson.mock.calls[0]?.[0].scope).toEqual({
      accountId: 'account-a',
      serverId: 'server-b',
      generation: 0,
    });
  });

  it('invalidates the previous active worker scope when the configured scope changes', async () => {
    const encryption = await Encryption.create(new Uint8Array(32).fill(1));
    const generation = expectGenerationReader(encryption);
    const generationScope = expectGenerationScopeReader(encryption);
    encryption.configureNativeCryptoWorker({
      scope: { accountId: 'account-a', serverId: 'server-a', generation: 0 },
    });
    const captured = generationScope.getCurrentEncryptionGenerationScope({
      accountId: 'account-a',
      serverId: 'server-a',
    });

    encryption.configureNativeCryptoWorker({
      scope: { accountId: 'account-a', serverId: 'server-b', generation: 0 },
    });

    expect(generationScope.isCurrentEncryptionGenerationScope(captured)).toBe(false);
    expect(generation.getCurrentGeneration('account-a', 'server-a')).toBe(1);
    expect(generation.getCurrentGeneration('account-a', 'server-b')).toBe(0);
  });
});
