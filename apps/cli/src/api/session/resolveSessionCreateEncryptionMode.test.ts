import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION } from '@happier-dev/protocol';

const { fetchServerFeaturesSnapshot, fetchAccountEncryptionCurrentness } = vi.hoisted(() => ({
  fetchServerFeaturesSnapshot: vi.fn(),
  fetchAccountEncryptionCurrentness: vi.fn(),
}));

vi.mock('@/features/serverFeaturesClient', () => ({
  fetchServerFeaturesSnapshot,
}));

vi.mock('@/api/client/connectedServiceCredentialApi', () => ({
  fetchAccountEncryptionCurrentness,
}));

import { resolveSessionCreateEncryptionMode } from './resolveSessionCreateEncryptionMode';

function readySnapshot(
  accountStoredContentCompatibility?: Readonly<Record<string, unknown>>,
  storagePolicy: 'required_e2ee' | 'optional' | 'plaintext_only' = 'optional',
) {
  return {
    status: 'ready' as const,
    features: {
      capabilities: {
        encryption: {
          storagePolicy,
          allowAccountOptOut: true,
          defaultAccountMode: 'e2ee' as const,
        },
        ...(accountStoredContentCompatibility
          ? { accountStoredContentCompatibility }
          : {}),
      },
    },
  };
}

describe('resolveSessionCreateEncryptionMode', () => {
  beforeEach(() => {
    fetchServerFeaturesSnapshot.mockReset();
    fetchAccountEncryptionCurrentness.mockReset();
  });

  it.each([
    { reason: 'network' as const },
    { reason: 'timeout' as const },
    { reason: 'response_status' as const },
  ])('fails closed but retryably when the server feature snapshot has a transient $reason error', async ({ reason }) => {
    fetchServerFeaturesSnapshot.mockResolvedValue({ status: 'error', reason });

    await expect(resolveSessionCreateEncryptionMode({
      token: 'token-1',
      serverBaseUrl: 'https://server.example',
    })).rejects.toMatchObject({
      code: 'account_stored_content_compatibility_unavailable',
      retryable: true,
      reason,
    });
    expect(fetchServerFeaturesSnapshot).toHaveBeenCalledWith({
      serverUrl: 'https://server.example',
    });
    expect(fetchAccountEncryptionCurrentness).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'missing requirements',
      requirements: undefined,
      decision: 'missing',
    },
    {
      name: 'protocol v1',
      requirements: {
        v: 1,
        minimumProtocolVersion: 1,
        currentProtocolVersion: 1,
        declarationTransport: 'http-header-and-socket-auth-v1',
      },
      decision: 'server-too-old',
    },
  ])('rejects $name before resolving Account mode', async ({
    requirements,
    decision,
  }) => {
    fetchServerFeaturesSnapshot.mockResolvedValue(
      readySnapshot(requirements),
    );

    await expect(resolveSessionCreateEncryptionMode({
      token: 'token-1',
      serverBaseUrl: 'https://server.example',
    })).rejects.toMatchObject({
      code: 'client-upgrade-required',
      retryable: false,
      decision,
    });
    expect(fetchAccountEncryptionCurrentness).not.toHaveBeenCalled();
  });

  it.each([
    { storagePolicy: 'plaintext_only' as const, accountMode: 'e2ee' as const, expected: 'plain' as const },
    { storagePolicy: 'optional' as const, accountMode: 'plain' as const, expected: 'plain' as const },
    { storagePolicy: 'optional' as const, accountMode: 'e2ee' as const, expected: 'e2ee' as const },
    { storagePolicy: 'required_e2ee' as const, accountMode: 'plain' as const, expected: 'e2ee' as const },
  ])('resolves $storagePolicy Session mode from one Account-currentness snapshot', async ({
    storagePolicy,
    accountMode,
    expected,
  }) => {
    const snapshot = readySnapshot({
      v: 1,
      minimumProtocolVersion: 2,
      currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
      declarationTransport: 'http-header-and-socket-auth-v1',
    }, storagePolicy);
    fetchServerFeaturesSnapshot.mockResolvedValue(snapshot);
    fetchAccountEncryptionCurrentness.mockResolvedValue({
      mode: accountMode,
      version: 3,
      signingKeyFingerprint: null,
      contentKeyFingerprint: accountMode === 'e2ee' ? 'content-fingerprint' : null,
      updatedAt: 9,
    });

    await expect(resolveSessionCreateEncryptionMode({
      token: 'token-1',
      serverBaseUrl: 'https://server.example',
    })).resolves.toMatchObject({
      desiredSessionEncryptionMode: expected,
      accountEncryptionCurrentness: { mode: accountMode, version: 3 },
    });
    expect(fetchAccountEncryptionCurrentness).toHaveBeenCalledOnce();
  });
});
