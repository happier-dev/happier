import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ARTIFACT_PLAIN_DATA_KEY_MARKER,
  CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
  decodePlainArtifactStoredContent,
} from '@happier-dev/protocol';
import type { Credentials, StoredCredentials } from '@/persistence';

const { mockGet, mockPost, mockFetchServerFeaturesSnapshot } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockFetchServerFeaturesSnapshot: vi.fn(),
}));

vi.mock('axios', () => ({
  default: { defaults: {}, get: mockGet, post: mockPost },
}));

vi.mock('@/configuration', async () => {
  const actual = await vi.importActual<typeof import('@/configuration')>('@/configuration');
  return {
    ...actual,
    configuration: { ...actual.configuration, apiServerUrl: 'http://127.0.0.1:24599' },
  };
});

vi.mock('@/features/serverFeaturesClient', () => ({
  fetchServerFeaturesSnapshot: (...args: unknown[]) =>
    mockFetchServerFeaturesSnapshot(...args),
}));

import { createCredentialedTargetActionCurrentIntent } from './credentialedTargetActionCurrentIntent';

describe('credentialed target-action current-intent wiring', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    // The HTTP server acknowledges the producer's generated id and initial revisions.
    mockPost.mockImplementation(async (_url: string, payload: { id: string }) => ({
      status: 200, data: { id: payload.id, headerVersion: 1, bodyVersion: 1 },
    }));
    mockFetchServerFeaturesSnapshot.mockReset();
    mockFetchServerFeaturesSnapshot.mockResolvedValue({
      status: 'ready',
      features: {
        capabilities: {
          accountStoredContentCompatibility: {
            v: 1,
            minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
            currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
            declarationTransport: 'http-header-and-socket-auth-v1',
          },
        },
      },
    });
  });

  it('defers an encrypted public-input request through the default credentialed requester', async () => {
    const credentials: Credentials = {
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
    };
    // Account mode is read by path, not by call order: the writer admits it more than once.
    mockGet.mockImplementation(async (url: string) => new URL(url).pathname === '/v1/account/encryption'
      ? { status: 200, data: { mode: 'e2ee', updatedAt: 1 } } : { status: 404, data: null });
    const requester = createCredentialedTargetActionCurrentIntent(credentials);
    const result = await requester({
      action: {
        qualifiedId: 'acme.publisher/actions/releases/publish',
        pluginId: 'acme.publisher',
        localId: 'releases/publish',
        occurrenceId: 'generation-7',
        sourceCustody: { kind: 'development', registeredRootId: 'acme-publisher-root' },
        dangerLevel: 'writesRemote',
        scopes: ['global'],
        surfaces: ['cli'],
        hostAccess: [],
        input: { secret: 'must-not-leak' },
        policyFingerprint: 'a'.repeat(64),
        confirmation: { title: 'Publish release' },
      },
      fingerprint: 'b'.repeat(64),
      surface: 'cli',
    });
    expect(mockPost).toHaveBeenCalledTimes(1);
    const [url, payload] = mockPost.mock.calls[0]!;
    expect(result).toEqual({ status: 'deferred', artifactId: payload.id });
    expect(url).toContain('/v1/artifacts');
    expect(payload).toMatchObject({
      id: expect.any(String), header: expect.any(String), body: expect.any(String), dataEncryptionKey: expect.any(String),
    });
    expect(JSON.stringify(payload)).not.toContain('acme.publisher/actions/releases/publish');
    expect(JSON.stringify(payload)).not.toContain('must-not-leak');
  });

  it('defers an explicit plain public-input request with token-only credentials', async () => {
    const credentials: StoredCredentials = {
      token: 'token-only',
      encryption: null,
    };
    // Account mode is read by path, not by call order: the writer admits it more than once.
    mockGet.mockImplementation(async (url: string) => new URL(url).pathname === '/v1/account/encryption'
      ? { status: 200, data: { mode: 'plain', updatedAt: 1 } } : { status: 404, data: null });
    const requester = createCredentialedTargetActionCurrentIntent(credentials);
    const result = await requester({
      action: {
        qualifiedId: 'acme.publisher/actions/releases/publish',
        pluginId: 'acme.publisher',
        localId: 'releases/publish',
        occurrenceId: 'generation-7',
        sourceCustody: { kind: 'development', registeredRootId: 'acme-publisher-root' },
        dangerLevel: 'writesRemote',
        scopes: ['global'],
        surfaces: ['cli'],
        hostAccess: [],
        input: { release: 'preview' },
        policyFingerprint: 'a'.repeat(64),
        confirmation: { title: 'Publish release' },
      },
      fingerprint: 'b'.repeat(64),
      surface: 'cli',
    });
    expect(mockPost).toHaveBeenCalledTimes(1);
    const [, payload] = mockPost.mock.calls[0]!;
    expect(result).toEqual({ status: 'deferred', artifactId: payload.id });
    expect(payload.dataEncryptionKey).toBe(ARTIFACT_PLAIN_DATA_KEY_MARKER);
    expect(decodePlainArtifactStoredContent(payload.header)).toMatchObject({
      kind: 'target_action_approval.v1',
      qualifiedActionId: 'acme.publisher/actions/releases/publish',
    });
    expect(decodePlainArtifactStoredContent(payload.body)).toMatchObject({
      body: expect.stringContaining('"release":"preview"'),
    });
  });
});
