import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScmCommand } from '@/scm/runtime';

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
    apiServerUrl: 'https://api.example.com',
  },
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    infoFile: vi.fn(),
  },
}));

describe('ApiClient.getOrCreateSession (plaintext sessions)', () => {
  const tempDirectories: string[] = [];
  afterEach(async () => {
    await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });
  beforeEach(() => {
    mockPost.mockReset();
    mockGet.mockReset();
    vi.unstubAllGlobals();
  });

  it.each([false, true])('publishes only host-proven repository metadata with mapped execution=%s', async (mapped) => {
    const directory = await mkdtemp(join(tmpdir(), 'session-create-repository-'));
    tempDirectories.push(directory);
    expect((await runScmCommand({ bin: 'git', cwd: directory, args: ['init'] })).success).toBe(true);
    const root = await runScmCommand({ bin: 'git', cwd: directory, args: ['rev-parse', '--show-toplevel'] });
    expect(root.success).toBe(true);
    const repositoryPath = root.stdout.replace(/\n$/, '');
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
      expect(JSON.parse(body.metadata).sessionRepositoryV1).toEqual(mapped ? undefined : {
        v: 1, machineId: 'local-machine', rootPath: repositoryPath, worktreePath: repositoryPath,
      });

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
    const metadata = {
      path: directory, machineId: 'local-machine', host: 'localhost', homeDir: '/home/user',
      happyHomeDir: '/home/user/.happy', happyLibDir: '/home/user/.happy/lib',
      happyToolsDir: '/home/user/.happy/tools',
      ...(mapped ? {
        sessionWorkspaceLocationV1: {
          v: 1 as const, machineId: 'local-machine', agentPath: directory, machinePath: '/host/another-checkout',
        },
        sessionRepositoryV1: { v: 1 as const, machineId: 'local-machine', rootPath: '/old/main', worktreePath: directory },
      } : {}),
    };
    const session = await api.getOrCreateSession({
      tag: 'tag-plain',
      metadata,
      state: null,
    });

    expect(session).not.toBeNull();
    expect(session?.metadata.path).toBe(directory);
    expect(metadata.sessionRepositoryV1).toEqual(mapped ? undefined : {
      v: 1, machineId: 'local-machine', rootPath: repositoryPath, worktreePath: repositoryPath,
    });
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
