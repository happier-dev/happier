import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
  StoredJsonContentEnvelopeSchema,
} from '@happier-dev/protocol';

import { ApiClient } from './api';
import { decodeBase64 } from './encryption';

const mockPost = vi.fn();
const mockGet = vi.fn();
const mockFetchServerFeaturesSnapshot = vi.fn();

vi.mock('axios', () => ({
  default: {
    post: (...args: unknown[]) => mockPost(...args),
    get: (...args: unknown[]) => mockGet(...args),
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

vi.mock('@/features/serverFeaturesClient', () => ({
  fetchServerFeaturesSnapshot: (...args: unknown[]) =>
    mockFetchServerFeaturesSnapshot(...args),
}));

function decodeEnvelope(value: string) {
  return StoredJsonContentEnvelopeSchema.parse(
    JSON.parse(Buffer.from(decodeBase64(value)).toString('utf8')),
  );
}

describe('ApiClient.getOrCreateMachine plaintext account storage', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockFetchServerFeaturesSnapshot.mockReset();
    mockFetchServerFeaturesSnapshot.mockResolvedValue({
      status: 'ready',
      features: {
        capabilities: {
          accountStoredContentCompatibility: {
            v: 1,
            minimumProtocolVersion: 2,
            currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
            declarationTransport: 'http-header-and-socket-auth-v1',
          },
        },
      },
    });
  });

  it('writes and reads machine state without consulting account encryption material', async () => {
    mockGet.mockResolvedValue({
      status: 200,
      data: { mode: 'plain', updatedAt: 1 },
    });
    mockPost.mockImplementation(async (_url: string, body: Record<string, unknown>) => {
      expect(decodeEnvelope(String(body.metadata))).toEqual({
        t: 'plain',
        v: expect.objectContaining({ host: 'plain-host' }),
      });
      expect(decodeEnvelope(String(body.daemonState))).toEqual({
        t: 'plain',
        v: { status: 'running' },
      });
      expect(decodeEnvelope(String(body.dataEncryptionKey))).toEqual({ t: 'plain', v: null });
      expect(body).not.toHaveProperty('contentPublicKey');

      return {
        data: {
          machine: {
            id: 'machine-plain-1',
            metadata: body.metadata,
            metadataVersion: 1,
            daemonState: body.daemonState,
            daemonStateVersion: 1,
            dataEncryptionKey: body.dataEncryptionKey,
          },
        },
      };
    });

    const api = await ApiClient.create({
      token: 'token-test',
      encryption: null,
    });
    const machine = await api.getOrCreateMachine({
      machineId: 'machine-plain-1',
      metadata: {
        host: 'plain-host',
        homeDir: '/home/plain',
        platform: 'linux',
        happyCliVersion: '0.0.0-test',
        happyHomeDir: '/home/plain/.happier',
        happyLibDir: '/home/plain/.happier/lib',
      },
      daemonState: {
        status: 'running',
        serviceLabel: undefined,
      },
    });

    expect(machine).toMatchObject({
      id: 'machine-plain-1',
      encryptionMode: 'plain',
      metadata: { host: 'plain-host' },
      daemonState: { status: 'running' },
    });
  });

  it('refuses a plaintext Machine marker before POST against an immutable old-server capability snapshot', async () => {
    mockFetchServerFeaturesSnapshot.mockResolvedValue({
      status: 'ready',
      features: {
        capabilities: {
          encryption: {
            storagePolicy: 'optional',
          },
        },
      },
    });
    mockGet.mockResolvedValue({
      status: 200,
      data: { mode: 'plain', updatedAt: 1 },
    });

    const api = await ApiClient.create({
      token: 'token-test',
      encryption: null,
    });

    await expect(api.getOrCreateMachine({
      machineId: 'machine-plain-old-server',
      metadata: {
        host: 'plain-host',
        homeDir: '/home/plain',
        platform: 'linux',
        happyCliVersion: '0.0.0-test',
        happyHomeDir: '/home/plain/.happier',
        happyLibDir: '/home/plain/.happier/lib',
      },
    })).rejects.toMatchObject({
      code: 'client-upgrade-required',
      retryable: false,
    });

    expect(mockPost).not.toHaveBeenCalled();
  });
});
