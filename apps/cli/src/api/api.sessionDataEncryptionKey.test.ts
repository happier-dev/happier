import { describe, expect, it, vi, beforeEach } from 'vitest';

import { ApiClient } from './api';
import {
  encodeBase64,
  encrypt,
  libsodiumEncryptForPublicKey,
  libsodiumPublicKeyFromSecretKey,
} from './encryption';

const mockPost = vi.fn();

vi.mock('axios', () => ({
  default: {
    post: (...args: any[]) => mockPost(...args),
    isAxiosError: () => false,
  },
  isAxiosError: () => false,
}));

vi.mock('@/configuration', () => ({
  configuration: {
    serverUrl: 'https://api.example.com',
  },
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

describe('ApiClient.getOrCreateSession (dataEncryptionKey)', () => {
  beforeEach(() => {
    mockPost.mockReset();
  });

  it('opens server-provided session.dataEncryptionKey and uses it to decrypt metadata', async () => {
    const machineSeed = new Uint8Array(32).fill(11);
    const publicKey = libsodiumPublicKeyFromSecretKey(machineSeed);

    const credential = {
      token: 'token-test',
      encryption: {
        type: 'dataKey' as const,
        publicKey,
        machineKey: machineSeed,
      },
    };

    const api = await ApiClient.create(credential as any);

    const sessionDataKey = new Uint8Array(32).fill(9);
    const metadata = {
      path: '/tmp',
      host: 'localhost',
      homeDir: '/home/user',
      happyHomeDir: '/home/user/.happy',
      happyLibDir: '/home/user/.happy/lib',
      happyToolsDir: '/home/user/.happy/tools',
    };

    const encryptedMetadata = encodeBase64(encrypt(sessionDataKey, 'dataKey', metadata));
    const boxed = libsodiumEncryptForPublicKey(sessionDataKey, publicKey);
    const dataEncryptionKeyBundle = new Uint8Array(boxed.length + 1);
    dataEncryptionKeyBundle[0] = 0;
    dataEncryptionKeyBundle.set(boxed, 1);

    mockPost.mockResolvedValue({
      data: {
        session: {
          id: 'session-1',
          seq: 1,
          metadata: encryptedMetadata,
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 0,
          dataEncryptionKey: encodeBase64(dataEncryptionKeyBundle),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });

    const session = await api.getOrCreateSession({
      tag: 'tag-1',
      metadata,
      state: null,
    });

    expect(session).not.toBeNull();
    expect(session!.encryptionVariant).toBe('dataKey');
    expect(Array.from(session!.encryptionKey)).toEqual(Array.from(sessionDataKey));
    expect(session!.metadata).toEqual(metadata);
  });

  it('throws when server provides session.dataEncryptionKey but the client cannot open it', async () => {
    const machineSeed = new Uint8Array(32).fill(11);
    const publicKey = libsodiumPublicKeyFromSecretKey(machineSeed);

    const credential = {
      token: 'token-test',
      encryption: {
        type: 'dataKey' as const,
        publicKey,
        machineKey: machineSeed,
      },
    };

    const api = await ApiClient.create(credential as any);

    const metadata = {
      path: '/tmp',
      host: 'localhost',
      homeDir: '/home/user',
      happyHomeDir: '/home/user/.happy',
      happyLibDir: '/home/user/.happy/lib',
      happyToolsDir: '/home/user/.happy/tools',
    };

    // Response includes a dataEncryptionKey, but it's not a valid box bundle.
    mockPost.mockResolvedValue({
      data: {
        session: {
          id: 'session-1',
          seq: 1,
          metadata: encodeBase64(encrypt(new Uint8Array(32).fill(9), 'dataKey', metadata)),
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 0,
          dataEncryptionKey: encodeBase64(new Uint8Array([0, 1, 2, 3])),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });

    await expect(
      api.getOrCreateSession({
        tag: 'tag-1',
        metadata,
        state: null,
      }),
    ).rejects.toThrow(/dataEncryptionKey/i);
  });
});
