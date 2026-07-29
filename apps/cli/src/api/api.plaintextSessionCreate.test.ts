import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClient } from './api';
import { decodeBase64, decrypt } from './encryption';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';

const mockPost = vi.fn();
const mockGet = vi.fn();

vi.mock('axios', () => ({
  default: {
    post: (...args: any[]) => mockPost(...args),
    get: (...args: any[]) => mockGet(...args),
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

describe('ApiClient.getOrCreateSession (plaintext sessions)', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockGet.mockReset();
    vi.unstubAllGlobals();
  });

  it('sends plaintext metadata when server policy is plaintext_only', async () => {
    const credential = {
      token: 'token-test',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(7),
      },
    };

    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : String((input as any)?.url ?? input);
      if (url.endsWith('/v1/features')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            features: {},
            capabilities: {
              encryption: {
                storagePolicy: 'plaintext_only',
                allowAccountOptOut: false,
                defaultAccountMode: 'e2ee',
              },
            },
          }),
        } as any;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as any);

    mockPost.mockImplementation(async (_url: string, body: any) => {
      expect(body.encryptionMode).toBe('plain');
      expect(body).not.toHaveProperty('metadataLayoutVersion');
      expect(body).not.toHaveProperty('sharedMetadata');
      expect(body).not.toHaveProperty('ownerMetadata');
      expect(JSON.parse(body.metadata)).toMatchObject({
        path: '/tmp',
        host: 'localhost',
      });
      expect(body.dataEncryptionKey).toBeNull();

      return {
        data: {
          session: {
            id: 'session-plain',
            seq: 1,
            encryptionMode: 'plain',
            metadata: body.metadata,
            ownerMetadata: null,
            metadataLayoutVersion: 0,
            metadataVersion: 1,
            agentState: body.agentState,
            agentStateVersion: 0,
            dataEncryptionKey: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      };
    });

    const api = await ApiClient.create(credential as any);
    const session = await api.getOrCreateSession({
      tag: 'tag-plain',
      metadata: {
        path: '/tmp',
        host: 'localhost',
        homeDir: '/home/user',
        happyHomeDir: '/home/user/.happy',
        happyLibDir: '/home/user/.happy/lib',
        happyToolsDir: '/home/user/.happy/tools',
      },
      state: null,
    });

    expect(session).not.toBeNull();
    expect(session?.metadata.path).toBe('/tmp');
  });

  it('uses account mode to decide plaintext session creation when policy is optional', async () => {
    const credential = {
      token: 'token-test',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(7),
      },
    };

    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : String((input as any)?.url ?? input);
      if (url.endsWith('/v1/features')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            features: {},
            capabilities: {
              encryption: {
                storagePolicy: 'optional',
                allowAccountOptOut: true,
                defaultAccountMode: 'e2ee',
              },
            },
          }),
        } as any;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as any);

    mockGet.mockResolvedValue({
      status: 200,
      data: { mode: 'plain', updatedAt: 1 },
    });

    mockPost.mockImplementation(async (_url: string, body: any) => {
      expect(body.encryptionMode).toBe('plain');
      expect(body).not.toHaveProperty('metadataLayoutVersion');
      expect(body).not.toHaveProperty('sharedMetadata');
      expect(body).not.toHaveProperty('ownerMetadata');
      expect(JSON.parse(body.metadata)).toMatchObject({
        path: '/tmp',
        host: 'localhost',
      });
      expect(body.dataEncryptionKey).toBeNull();
      return {
        data: {
          session: {
            id: 'session-plain',
            seq: 1,
            encryptionMode: 'plain',
            metadata: body.metadata,
            ownerMetadata: null,
            metadataLayoutVersion: 0,
            metadataVersion: 1,
            agentState: body.agentState,
            agentStateVersion: 0,
            dataEncryptionKey: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      };
    });

    const api = await ApiClient.create(credential as any);
    const session = await api.getOrCreateSession({
      tag: 'tag-plain',
      metadata: {
        path: '/tmp',
        host: 'localhost',
        homeDir: '/home/user',
        happyHomeDir: '/home/user/.happy',
        happyLibDir: '/home/user/.happy/lib',
        happyToolsDir: '/home/user/.happy/tools',
      },
      state: null,
    });

    expect(session).not.toBeNull();
    expect(session?.metadata.path).toBe('/tmp');
  });

  it('loads a layout-v1 response through the recipient-safe metadata contract', async () => {
    const credential = {
      token: 'token-test',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(7),
      },
    };

    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = typeof input === 'string'
        ? input
        : String((input as { url?: unknown })?.url ?? input);
      if (url.endsWith('/v1/features')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            features: {},
            capabilities: {
              encryption: {
                storagePolicy: 'plaintext_only',
                allowAccountOptOut: false,
                defaultAccountMode: 'e2ee',
              },
            },
          }),
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const responseTuple = buildSessionMetadataEnvelopeFields({
      credentials: credential,
      metadata: {
        path: '/private/workspace',
        host: 'private-host',
        homeDir: '/private/home',
        happyHomeDir: '/private/home/.happy',
        happyLibDir: '/private/home/.happy/lib',
        happyToolsDir: '/private/home/.happy/tools',
      },
      agentState: null,
      storedContentMode: 'plain',
      encryptionKey: credential.encryption.secret,
      encryptionVariant: 'legacy',
    });
    mockPost.mockImplementation(async () => ({
      data: {
        session: {
          id: 'session-layout-v1',
          seq: 1,
          encryptionMode: 'plain',
          metadata: JSON.stringify({
            v: 1,
            summary: {
              text: 'Recipient-safe summary',
              updatedAt: 10,
            },
          }),
          ownerMetadata: responseTuple.ownerMetadata.ciphertext,
          metadataLayoutVersion: 1,
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 0,
          dataEncryptionKey: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    }));

    const api = await ApiClient.create(credential);
    const session = await api.getOrCreateSession({
      tag: 'tag-layout-v1',
      metadata: {
        path: '/private/workspace',
        host: 'private-host',
        homeDir: '/private/home',
        happyHomeDir: '/private/home/.happy',
        happyLibDir: '/private/home/.happy/lib',
        happyToolsDir: '/private/home/.happy/tools',
      },
      state: null,
    });
    if (!session) throw new Error('Expected layout-v1 session response');

    expect(session).toMatchObject({
      metadataLayoutVersion: 1,
      metadata: {
        path: '/private/workspace',
        host: 'private-host',
        homeDir: '/private/home',
        happyHomeDir: '/private/home/.happy',
        happyLibDir: '/private/home/.happy/lib',
        happyToolsDir: '/private/home/.happy/tools',
        summary: {
          text: 'Recipient-safe summary',
          updatedAt: 10,
        },
      },
    });
    expect(session.ownerMetadataCiphertext).toEqual(expect.any(String));
    expect(session.ownerMetadata).toMatchObject({
      v: 1,
      workspace: {
        path: '/private/workspace',
        host: 'private-host',
      },
    });
    expect(session.metadata).not.toHaveProperty('ownerMetadata');
  });

  it('keeps encrypted fresh-session creation on layout 0 while activation is closed', async () => {
    const credential = {
      token: 'token-test',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(7),
      },
    };
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = typeof input === 'string'
        ? input
        : String((input as { url?: unknown })?.url ?? input);
      if (url.endsWith('/v1/features')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            features: {},
            capabilities: {
              encryption: {
                storagePolicy: 'required_e2ee',
                allowAccountOptOut: false,
                defaultAccountMode: 'e2ee',
              },
            },
          }),
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    mockPost.mockImplementation(async (_url: string, body: any) => {
      expect(body).not.toHaveProperty('metadataLayoutVersion');
      expect(body).not.toHaveProperty('sharedMetadata');
      expect(body).not.toHaveProperty('ownerMetadata');
      expect(decrypt(
        credential.encryption.secret,
        'legacy',
        decodeBase64(body.metadata),
      )).toMatchObject({
        path: '/private/e2ee',
        codexSessionId: 'codex-private',
      });
      expect(decrypt(
        credential.encryption.secret,
        'legacy',
        decodeBase64(body.agentState),
      )).toMatchObject({
        completedRequests: {
          permission_1: {
            arguments: { command: 'git status' },
          },
        },
      });

      return {
        data: {
          session: {
            id: 'session-e2ee-layout-v1',
            seq: 1,
            encryptionMode: 'e2ee',
            metadata: body.metadata,
            ownerMetadata: null,
            metadataLayoutVersion: 0,
            metadataVersion: 1,
            agentState: body.agentState,
            agentStateVersion: 1,
            dataEncryptionKey: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      };
    });

    const api = await ApiClient.create(credential);
    const session = await api.getOrCreateSession({
      tag: 'tag-e2ee-layout-v1',
      metadata: {
        path: '/private/e2ee',
        host: 'private-host',
        homeDir: '/private/home',
        happyHomeDir: '/private/home/.happy',
        happyLibDir: '/private/home/.happy/lib',
        happyToolsDir: '/private/home/.happy/tools',
        flavor: 'codex',
        codexSessionId: 'codex-private',
      },
      state: {
        completedRequests: {
          permission_1: {
            tool: 'Bash',
            kind: 'permission',
            arguments: { command: 'git status' },
            createdAt: 1,
            completedAt: 2,
            status: 'approved',
          },
        },
      },
    });

    expect(session).toMatchObject({
      metadataLayoutVersion: 0,
      metadata: {
        path: '/private/e2ee',
        codexSessionId: 'codex-private',
      },
    });
  });
});
