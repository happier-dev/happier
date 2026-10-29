import { describe, it, expect, vi } from 'vitest';
import * as platformCrypto from 'rn-encryption';
import { createDeferred } from '@/dev/testkit';
import { encodeBase64 } from '@/encryption/base64';
import { Encryption } from './encryption';
import { createFakeCryptoWorker } from './nativeCryptoWorker/fakeCryptoWorker';
import type { NativeCryptoWorker } from './nativeCryptoWorker/types';
import { openSessionSharedDisplayEnvelopeV1, sealSessionSharedDisplayEnvelopeV1 } from '@happier-dev/protocol';

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
  it('opens shared display only with the installed Session key after an actual key replacement', async () => {
    const encryption = await Encryption.create(new Uint8Array(32).fill(1));
    await encryption.initializeSessions(new Map([['display', new Uint8Array(32).fill(2)]]));
    const previous = encryption.getSessionEncryption('display')!;
    const oldDisplay = await sealSessionSharedDisplayEnvelopeV1({ sessionMode: 'e2ee',
      display: { v: 1, summaryText: 'Before replacement' }, encryptPayload: payload => previous.encryptRaw(payload) });
    if (!oldDisplay.ok) throw new Error('Expected shared display fixture');
    expect(await openSessionSharedDisplayEnvelopeV1({ sessionMode: 'e2ee', envelope: oldDisplay.envelope,
      decryptPayload: ciphertext => previous.decryptRaw(ciphertext) })).toEqual({ ok: true, display: { v: 1, summaryText: 'Before replacement' } });
    // Exercise the existing key-installation owner, not an invented content-rotation service.
    await encryption.initializeSessions(new Map([['display', new Uint8Array(32).fill(3)]]));
    const current = encryption.getSessionEncryption('display')!;
    expect(await openSessionSharedDisplayEnvelopeV1({ sessionMode: 'e2ee', envelope: oldDisplay.envelope,
      decryptPayload: ciphertext => current.decryptRaw(ciphertext) })).toMatchObject({ ok: false });
    const replacement = await sealSessionSharedDisplayEnvelopeV1({ sessionMode: 'e2ee',
      display: { v: 1, summaryText: 'After replacement' }, encryptPayload: payload => current.encryptRaw(payload) });
    if (!replacement.ok) throw new Error('Expected replacement display fixture');
    expect(await openSessionSharedDisplayEnvelopeV1({ sessionMode: 'e2ee', envelope: replacement.envelope,
      decryptPayload: ciphertext => current.decryptRaw(ciphertext) })).toEqual({ ok: true, display: { v: 1, summaryText: 'After replacement' } });
    expect(await previous.decryptRaw(replacement.envelope.t === 'encrypted' ? replacement.envelope.c : '')).toBeNull();
  });

  it.each(['individual', 'snapshot'] as const)(
    'does not republish retired %s plaintext into a same-version regrant',
    async (readKind) => {
      const encryption = await Encryption.create(new Uint8Array(32).fill(1));
      encryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });
      const dataKey = new Uint8Array(32).fill(2);
      const scope = { accountId: 'account-a', serverId: 'server-a' };
      await encryption.initializeSessions(new Map([['retired', dataKey], ['retained', dataKey]]), scope);
      const retired = encryption.getSessionEncryption('retired')!;
      const retained = encryption.getSessionEncryption('retained')!;
      const oldMetadata = await retired.encryptMetadata({ path: '/old', host: 'machine' });
      const oldState = await retired.encryptAgentState({ controlledByUser: true });
      const retainedMetadata = await retained.encryptMetadata({ path: '/retained', host: 'machine' });
      const decryptStarted = createDeferred<void>();
      const releaseDecrypt = createDeferred<void>();
      const originalDecrypt = platformCrypto.decryptAsyncAES;
      // Delay the real platform crypto result; SessionEncryption and its cache stay real.
      const decryptSpy = vi.spyOn(platformCrypto, 'decryptAsyncAES').mockImplementation(async (...args) => {
        const plaintext = await originalDecrypt(...args);
        decryptStarted.resolve();
        await releaseDecrypt.promise;
        return plaintext;
      });
      const pending = readKind === 'snapshot'
        ? retired.decryptSessionSnapshotState(1, oldMetadata, 1, oldState)
        : Promise.all([retired.decryptMetadata(1, oldMetadata), retired.decryptAgentState(1, oldState)])
            .then(([metadata, agentState]) => ({ metadata, agentState }));

      try {
        await decryptStarted.promise;
        encryption.removeSessionEncryption('retired');
        await encryption.initializeSessions(new Map([['retired', dataKey]]), scope);
        const regranted = encryption.getSessionEncryption('retired')!;
        const newMetadata = await regranted.encryptMetadata({ path: '/new', host: 'machine' });
        const newState = await regranted.encryptAgentState({ controlledByUser: false });
        releaseDecrypt.resolve();
        const retiredResult = await pending;

        expect(await regranted.decryptSessionSnapshotState(1, newMetadata, 1, newState)).toEqual({
          metadata: { path: '/new', host: 'machine' },
          agentState: { controlledByUser: false },
        });
        expect(retiredResult).toEqual({ metadata: null, agentState: {} });
        expect(await retired.decryptMetadata(1, newMetadata)).toBeNull();
        expect(await retained.decryptMetadata(1, retainedMetadata)).toEqual({ path: '/retained', host: 'machine' });
      } finally {
        releaseDecrypt.resolve();
        decryptSpy.mockRestore();
        await pending;
      }
    },
  );

  it('does not republish retired transcript plaintext after a replacement key is installed', async () => {
    const encryption = await Encryption.create(new Uint8Array(32).fill(1));
    encryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });
    await encryption.initializeSessions(new Map([['retired', new Uint8Array(32).fill(2)]]));
    const retired = encryption.getSessionEncryption('retired')!;
    const ciphertext = await retired.encryptRaw({ role: 'user', content: { type: 'text', text: 'retired content' } });
    const message = { id: 'message-1', seq: 1, createdAt: 1, content: { t: 'encrypted' as const, c: ciphertext } };
    const decryptStarted = createDeferred<void>();
    const releaseDecrypt = createDeferred<void>();
    const originalDecrypt = platformCrypto.decryptAsyncAES;
    // Preserve real AES and delay only the platform completion boundary.
    const decryptSpy = vi.spyOn(platformCrypto, 'decryptAsyncAES').mockImplementationOnce(async (...args) => {
      const plaintext = await originalDecrypt(...args);
      decryptStarted.resolve();
      await releaseDecrypt.promise;
      return plaintext;
    });
    const pending = retired.decryptMessages([message]);

    try {
      await decryptStarted.promise;
      await encryption.initializeSessions(new Map([['retired', new Uint8Array(32).fill(3)]]));
      releaseDecrypt.resolve();
      const retiredResult = await pending;

      const regranted = encryption.getSessionEncryption('retired')!;
      expect((await regranted.decryptMessage(message))?.content).toBeNull();
      expect(retiredResult).toEqual([null]);
    } finally {
      releaseDecrypt.resolve();
      decryptSpy.mockRestore();
      await pending;
    }
  });

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

  it('does not let a guarded key replacement cancel itself when it advances the owning generation', async () => {
    const encryption = await Encryption.create(new Uint8Array(32).fill(1));
    const generationScope = expectGenerationScopeReader(encryption);
    const scope = { accountId: 'account-a', serverId: 'server-a' } as const;

    await encryption.initializeSessions(
      new Map([['session_1', new Uint8Array(32).fill(2)]]),
      scope,
    );
    const before = encryption.getSessionEncryption('session_1');
    const captured = generationScope.getCurrentEncryptionGenerationScope(scope);

    const committed = await encryption.initializeSessions(
      new Map([['session_1', new Uint8Array(32).fill(3)]]),
      {
        ...scope,
        shouldContinue: () => generationScope.isCurrentEncryptionGenerationScope(captured),
      },
    );

    expect(encryption.getSessionEncryption('session_1')).not.toBe(before);
    expect(generationScope.isCurrentEncryptionGenerationScope(captured)).toBe(false);
    expect(committed).not.toBeNull();
    expect(generationScope.isCurrentEncryptionGenerationScope(committed!)).toBe(true);
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

  it('invalidates an overlapping first initializer displaced while its key was opening', async () => {
    const encryption = await Encryption.create(new Uint8Array(32).fill(1));
    const generationScope = expectGenerationScopeReader(encryption);
    const originalOpenEncryption = encryption.openEncryption.bind(encryption);
    let releaseAccountA!: () => void;
    const accountAGate = new Promise<void>((resolve) => {
      releaseAccountA = resolve;
    });
    let accountAStarted!: () => void;
    const accountAStart = new Promise<void>((resolve) => {
      accountAStarted = resolve;
    });
    vi.spyOn(encryption, 'openEncryption').mockImplementation(async (dataKey, scope) => {
      const opened = await originalOpenEncryption(dataKey, scope);
      if (scope?.accountId === 'account-a') {
        accountAStarted();
        await accountAGate;
      }
      return opened;
    });

    const pendingAccountA = encryption.initializeSessions(
      new Map([['session_1', new Uint8Array(32).fill(2)]]),
      { accountId: 'account-a', serverId: 'server-a' },
    );
    await accountAStart;
    const committedAccountB = await encryption.initializeSessions(
      new Map([['session_1', new Uint8Array(32).fill(3)]]),
      { accountId: 'account-b', serverId: 'server-b' },
    );
    releaseAccountA();
    const committedAccountA = await pendingAccountA;

    expect(committedAccountA).not.toBeNull();
    expect(committedAccountB).not.toBeNull();
    expect(generationScope.isCurrentEncryptionGenerationScope(committedAccountB!)).toBe(false);
    expect(generationScope.isCurrentEncryptionGenerationScope(committedAccountA!)).toBe(true);
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
