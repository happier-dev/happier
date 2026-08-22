import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ARTIFACT_PLAIN_DATA_KEY_MARKER,
  decodePlainArtifactStoredContent,
} from '@happier-dev/protocol';
import type { Credentials, StoredCredentials } from '@/persistence';

const { mockGet, mockPost } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
}));

vi.mock('axios', () => ({
  default: { get: mockGet, post: mockPost },
}));

vi.mock('@/configuration', async () => {
  const actual = await vi.importActual<typeof import('@/configuration')>('@/configuration');
  return {
    ...actual,
    configuration: { ...actual.configuration, apiServerUrl: 'http://127.0.0.1:24599' },
  };
});

import { createCredentialedTargetActionCurrentIntent } from './createCliActionExecutor';

describe('credentialed target-action current-intent wiring', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
  });

  it('creates an encrypted durable request through the default credentialed requester', async () => {
    const credentials: Credentials = {
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
    };
    mockPost.mockResolvedValueOnce({ status: 200, data: { id: 'target-approval-1' } });
    mockGet.mockResolvedValue({ status: 404, data: null });
    const requester = createCredentialedTargetActionCurrentIntent(credentials);
    const abortController = new AbortController();

    const pending = requester({
      action: {
        qualifiedId: 'acme.publisher/actions/releases/publish',
        pluginId: 'acme.publisher',
        localId: 'releases/publish',
        generation: 'generation-7',
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
      signal: abortController.signal,
    });

    await vi.waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    const [url, payload] = mockPost.mock.calls[0]!;
    expect(url).toContain('/v1/artifacts');
    expect(payload).toMatchObject({
      id: expect.any(String), header: expect.any(String), body: expect.any(String), dataEncryptionKey: expect.any(String),
    });
    expect(JSON.stringify(payload)).not.toContain('acme.publisher/actions/releases/publish');
    expect(JSON.stringify(payload)).not.toContain('must-not-leak');

    abortController.abort('test complete');
    await expect(pending).rejects.toThrow('test complete');
  });

  it('creates an explicit plain durable request with token-only credentials', async () => {
    const credentials: StoredCredentials = {
      token: 'token-only',
      encryption: null,
    };
    mockGet
      .mockResolvedValueOnce({ status: 200, data: { mode: 'plain', updatedAt: 1 } })
      .mockResolvedValue({ status: 404, data: null });
    mockPost.mockResolvedValueOnce({ status: 200, data: { id: 'target-approval-plain-1' } });
    const requester = createCredentialedTargetActionCurrentIntent(credentials);
    const abortController = new AbortController();

    const pending = requester({
      action: {
        qualifiedId: 'acme.publisher/actions/releases/publish',
        pluginId: 'acme.publisher',
        localId: 'releases/publish',
        generation: 'generation-7',
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
      signal: abortController.signal,
    });

    await vi.waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    const [, payload] = mockPost.mock.calls[0]!;
    expect(payload.dataEncryptionKey).toBe(ARTIFACT_PLAIN_DATA_KEY_MARKER);
    expect(decodePlainArtifactStoredContent(payload.header)).toMatchObject({
      kind: 'target_action_approval.v1',
      qualifiedActionId: 'acme.publisher/actions/releases/publish',
    });
    expect(decodePlainArtifactStoredContent(payload.body)).toMatchObject({
      body: expect.stringContaining('"release":"preview"'),
    });

    abortController.abort('test complete');
    await expect(pending).rejects.toThrow('test complete');
  });
});
