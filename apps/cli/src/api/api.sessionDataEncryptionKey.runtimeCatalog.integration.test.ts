import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import nacl from 'tweetnacl';
import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol';

import { ApiClient } from './api';
import {
  encodeBase64,
  encrypt,
  libsodiumEncryptForPublicKey,
  libsodiumPublicKeyFromSecretKey,
} from './encryption';

const { mockPost, mockGet } = vi.hoisted(() => ({ mockPost: vi.fn(), mockGet: vi.fn() }));

vi.mock('axios', () => ({
  default: {
    defaults: {},
    post: mockPost,
    get: mockGet,
    isAxiosError: () => false,
  },
  isAxiosError: () => false,
}));

vi.mock('@/configuration', () => ({
  configuration: {
    serverUrl: 'https://api.example.com',
    apiServerUrl: 'https://api.example.com',
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
    mockGet.mockReset();
    mockGet.mockResolvedValue({ status: 200, data: {
      mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing', contentKeyFingerprint: 'content', updatedAt: 1,
      recipientEnvelopeReadiness: { status: 'available' },
    } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      features: {},
      capabilities: {
        accountStoredContentCompatibility: {
          v: 1, minimumProtocolVersion: 2,
          currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
          declarationTransport: 'http-header-and-socket-auth-v1',
        },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(['dataKey', 'legacy'] as const)('opens server-provided session.dataEncryptionKey with %s credentials and decrypts metadata', async (credentialKind) => {
    const machineSeed = new Uint8Array(32).fill(11);
    const publicKey = credentialKind === 'legacy'
      ? nacl.box.keyPair.fromSecretKey(deriveAccountMachineKeyFromRecoverySecret(machineSeed)).publicKey
      : libsodiumPublicKeyFromSecretKey(machineSeed);

    const credential = {
      token: 'token-test',
      encryption: credentialKind === 'legacy' ? { type: 'legacy' as const, secret: machineSeed } : {
        type: 'dataKey' as const,
        publicKey,
        machineKey: machineSeed,
      },
    };

    const api = await ApiClient.create(credential);

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
          projectKey: 'accepted-project',
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
    if (!session || session.encryptionMode !== 'e2ee') {
      throw new Error('Expected an encrypted session response');
    }
    expect(session.encryptionVariant).toBe('dataKey');
    expect(Array.from(session.encryptionKey)).toEqual(Array.from(sessionDataKey));
    expect(session.metadata).toEqual(metadata);
    expect(session).toMatchObject({ projectKey: 'accepted-project' });
  });

  it.each(['AAECAw==', '', 123])('throws when a present server envelope is unusable (%j), even when Account fallback could decrypt the metadata', async (invalidEnvelope) => {
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

    const api = await ApiClient.create(credential);

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
          metadata: encodeBase64(encrypt(machineSeed, 'dataKey', metadata)),
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 0,
          dataEncryptionKey: invalidEnvelope,
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
