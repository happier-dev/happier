import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClient } from './api';

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
      expect(typeof body.metadata).toBe('string');
      expect(body.metadata).toContain('"path":"');
      expect(body.dataEncryptionKey).toBeNull();

      return {
        data: {
          session: {
            id: 'session-plain',
            seq: 1,
            encryptionMode: 'plain',
            metadata: body.metadata,
            metadataVersion: 1,
            agentState: null,
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
      expect(body.dataEncryptionKey).toBeNull();
      return {
        data: {
          session: {
            id: 'session-plain',
            seq: 1,
            encryptionMode: 'plain',
            metadata: body.metadata,
            metadataVersion: 1,
            agentState: null,
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
});
