import { describe, it, expect, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit';
import { encodeBase64 } from '@/encryption/base64';
import { Encryption } from './encryption';
import { createFakeCryptoWorker } from './nativeCryptoWorker/fakeCryptoWorker';
import { resetNativeCryptoWorkerQueueLifecycleForTests } from './nativeCryptoWorker/nativeCryptoWorkerQueue';
import type { NativeCryptoWorker } from './nativeCryptoWorker/types';

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
    const sessionDataKey = new Uint8Array(32).fill(2);

    await encryption.initializeSessions(new Map([['session_1', sessionDataKey]]), {
      accountId: 'account-a',
      serverId: 'server-a',
    });
    const afterInitial = encryption.getCurrentGeneration('account-a', 'server-a');

    await encryption.initializeSessions(new Map([['session_1', sessionDataKey]]), {
      accountId: 'account-a',
      serverId: 'server-a',
    });

    expect(encryption.getCurrentGeneration('account-a', 'server-a')).toBe(afterInitial);
  });

  it('increments worker generation when an existing session key fingerprint changes', async () => {
    const encryption = await Encryption.create(new Uint8Array(32).fill(1));

    await encryption.initializeSessions(new Map([['session_1', new Uint8Array(32).fill(2)]]), {
      accountId: 'account-a',
      serverId: 'server-a',
    });
    expect(encryption.getCurrentGeneration('account-a', 'server-a')).toBe(0);
    expect(encryption.getCurrentGeneration('account-a', 'server-a', 'session_1')).toBe(0);

    await encryption.initializeSessions(new Map([['session_1', new Uint8Array(32).fill(3)]]), {
      accountId: 'account-a',
      serverId: 'server-a',
    });

    expect(encryption.getCurrentGeneration('account-a', 'server-a')).toBe(0);
    expect(encryption.getCurrentGeneration('account-a', 'server-a', 'session_1')).toBe(1);
  });

  it('invalidates the previous owning scope when a session is rebound to a different account or server', async () => {
    const encryption = await Encryption.create(new Uint8Array(32).fill(1));
    const sessionDataKey = new Uint8Array(32).fill(2);

    await encryption.initializeSessions(new Map([['session_1', sessionDataKey]]), {
      accountId: 'account-a',
      serverId: 'server-a',
    });

    const captured = encryption.getCurrentEncryptionGenerationScope({
      accountId: 'account-a',
      serverId: 'server-a',
      sessionId: 'session_1',
    });

    await encryption.initializeSessions(new Map([['session_1', sessionDataKey]]), {
      accountId: 'account-b',
      serverId: 'server-b',
    });

    expect(encryption.isCurrentEncryptionGenerationScope(captured)).toBe(false);
    expect(encryption.getCurrentGeneration('account-a', 'server-a')).toBe(0);
    expect(encryption.getCurrentGeneration('account-a', 'server-a', 'session_1')).toBe(1);
    expect(encryption.getCurrentGeneration('account-b', 'server-b')).toBe(0);
    expect(encryption.getCurrentGeneration('account-b', 'server-b', 'session_1')).toBe(0);
  });

  it('isolates worker generation by session within an account and server scope', async () => {
    const encryption = await Encryption.create(new Uint8Array(32).fill(1));

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

    expect(encryption.getCurrentGeneration('account-a', 'server-a')).toBe(0);
    expect(encryption.getCurrentGeneration('account-a', 'server-a', 'session_a')).toBe(1);
    expect(encryption.getCurrentGeneration('account-a', 'server-b')).toBe(0);
    expect(encryption.getCurrentGeneration('account-a', 'server-b', 'session_b')).toBe(0);
    expect(encryption.getCurrentGeneration('account-b', 'server-a')).toBe(0);
  });

  it('increments worker generation for the owning scope when session encryption is removed', async () => {
    const encryption = await Encryption.create(new Uint8Array(32).fill(1));

    await encryption.initializeSessions(new Map([['session_1', new Uint8Array(32).fill(2)]]), {
      accountId: 'account-a',
      serverId: 'server-a',
    });

    encryption.removeSessionEncryption('session_1');

    expect(encryption.getCurrentGeneration('account-a', 'server-a')).toBe(0);
    expect(encryption.getCurrentGeneration('account-a', 'server-a', 'session_1')).toBe(1);
    expect(encryption.getCurrentGeneration('account-a', 'server-b')).toBe(0);
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
      sessionId: 'session_1',
    });
  });

  it('keeps one session native decrypt current when another session key rotates in the same account scope', async () => {
    const encryption = await Encryption.create(new Uint8Array(32).fill(1));
    const baseWorker = createFakeCryptoWorker();
    let rotatedOtherSession = false;
    const decryptAesGcmJson = vi.fn(async (request: Parameters<NativeCryptoWorker['decryptAesGcmJson']>[0]) => {
      if (!rotatedOtherSession) {
        rotatedOtherSession = true;
        await encryption.initializeSessions(new Map([['session_2', new Uint8Array(32).fill(4)]]), {
          accountId: 'account-a',
          serverId: 'server-a',
        });
      }
      return baseWorker.decryptAesGcmJson(request);
    });
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

    await encryption.initializeSessions(new Map([
      ['session_1', new Uint8Array(32).fill(2)],
      ['session_2', new Uint8Array(32).fill(3)],
    ]), {
      accountId: 'account-a',
      serverId: 'server-a',
    });
    const sessionEncryption = encryption.getSessionEncryption('session_1');
    expect(sessionEncryption).toBeTruthy();

    const encrypted = await sessionEncryption!.encryptRaw({ hello: 'session-1-stays-current' });

    await expect(sessionEncryption!.decryptRaw(encrypted)).resolves.toEqual({ hello: 'session-1-stays-current' });
    expect(decryptAesGcmJson).toHaveBeenCalledTimes(1);
    expect(decryptAesGcmJson.mock.calls[0]?.[0].scope).toEqual({
      accountId: 'account-a',
      serverId: 'server-a',
      generation: 0,
      sessionId: 'session_1',
    });
    expect(encryption.getCurrentGeneration('account-a', 'server-a', 'session_1')).toBe(0);
    expect(encryption.getCurrentGeneration('account-a', 'server-a', 'session_2')).toBe(1);
  });

  it('isolates fallback native decrypt queues by null-data-key session scope', async () => {
    resetNativeCryptoWorkerQueueLifecycleForTests();

    const encryption = await Encryption.create(new Uint8Array(32).fill(1));
    const baseWorker = createFakeCryptoWorker();
    const firstDispatch = createDeferred<Awaited<ReturnType<NativeCryptoWorker['decryptSecretboxJson']>>>();
    let firstRequest: Parameters<NativeCryptoWorker['decryptSecretboxJson']>[0] | null = null;
    const decryptSecretboxJson = vi.fn(async (request: Parameters<NativeCryptoWorker['decryptSecretboxJson']>[0]) => {
      if (firstRequest === null) {
        firstRequest = request;
        return await firstDispatch.promise;
      }
      return baseWorker.decryptSecretboxJson(request);
    });
    const worker: NativeCryptoWorker = {
      ...baseWorker,
      decryptSecretboxJson,
    };

    try {
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

      await encryption.initializeSessions(new Map([
        ['session_1', null],
        ['session_2', null],
      ]), {
        accountId: 'account-a',
        serverId: 'server-a',
      });

      const sessionOne = encryption.getSessionEncryption('session_1');
      const sessionTwo = encryption.getSessionEncryption('session_2');
      expect(sessionOne).toBeTruthy();
      expect(sessionTwo).toBeTruthy();

      const encryptedOne = await sessionOne!.encryptRaw({ hello: 'session-1' });
      const encryptedTwo = await sessionTwo!.encryptRaw({ hello: 'session-2' });

      const firstDecrypt = sessionOne!.decryptRaw(encryptedOne);
      await expect.poll(() => decryptSecretboxJson.mock.calls.length).toBe(1);

      const secondDecrypt = sessionTwo!.decryptRaw(encryptedTwo);

      await expect.poll(() => decryptSecretboxJson.mock.calls.length).toBe(2);
      expect(decryptSecretboxJson.mock.calls.map(([request]) => request.scope)).toEqual([
        {
          accountId: 'account-a',
          serverId: 'server-a',
          generation: 0,
          sessionId: 'session_1',
        },
        {
          accountId: 'account-a',
          serverId: 'server-a',
          generation: 0,
          sessionId: 'session_2',
        },
      ]);

      expect(firstRequest).toBeTruthy();
      firstDispatch.resolve(await baseWorker.decryptSecretboxJson(firstRequest!));

      await expect(firstDecrypt).resolves.toEqual({ hello: 'session-1' });
      await expect(secondDecrypt).resolves.toEqual({ hello: 'session-2' });
    } finally {
      resetNativeCryptoWorkerQueueLifecycleForTests();
    }
  });

  it('invalidates the previous active worker scope when the configured scope changes', async () => {
    const encryption = await Encryption.create(new Uint8Array(32).fill(1));
    encryption.configureNativeCryptoWorker({
      scope: { accountId: 'account-a', serverId: 'server-a', generation: 0 },
    });
    const captured = encryption.getCurrentEncryptionGenerationScope({
      accountId: 'account-a',
      serverId: 'server-a',
    });

    encryption.configureNativeCryptoWorker({
      scope: { accountId: 'account-a', serverId: 'server-b', generation: 0 },
    });

    expect(encryption.isCurrentEncryptionGenerationScope(captured)).toBe(false);
    expect(encryption.getCurrentGeneration('account-a', 'server-a')).toBe(1);
    expect(encryption.getCurrentGeneration('account-a', 'server-b')).toBe(0);
  });
});
