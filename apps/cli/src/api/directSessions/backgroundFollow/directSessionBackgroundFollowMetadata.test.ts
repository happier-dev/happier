import { describe, expect, it, vi } from 'vitest';

import {
  updateMetadataWithDirectSessionBackgroundFollow,
  updateMetadataWithDirectSessionFollowPolicy,
  updateMetadataWithDirectSessionObservedProgress,
  updateSessionMetadataWithDirectSessionBackgroundFollow as updateSessionMetadataWithDirectSessionBackgroundFollowCompat,
  updateSessionMetadataWithDirectSessionFollowPolicy,
} from './directSessionBackgroundFollowMetadata';
import type { Metadata } from '@/api/types';

const updateSessionMetadataWithRetryMock = vi.hoisted(() => vi.fn());

vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
  updateSessionMetadataWithRetry: (...args: unknown[]) => updateSessionMetadataWithRetryMock(...args),
}));

describe('directSessionBackgroundFollowMetadata', () => {
  const baseMetadata = {
    path: '',
    host: 'localhost',
    homeDir: '/tmp/home',
    happyHomeDir: '/tmp/happy',
    happyLibDir: '/tmp/happy/lib',
    happyToolsDir: '/tmp/happy/tools',
  } satisfies Metadata;

  it('updates direct-session follow policy metadata without clobbering the link', () => {
    const metadata = {
      ...baseMetadata,
      directSessionV1: {
        v: 1 as const,
        providerId: 'claude',
        machineId: 'machine-1',
        remoteSessionId: 'remote-1',
        source: { kind: 'claudeConfig' as const, configDir: '/tmp/.claude' },
        linkedAtMs: 1,
      },
    };

    expect(updateMetadataWithDirectSessionFollowPolicy(metadata, {
      policy: 'background_follow',
      updatedAtMs: 42,
    })).toEqual({
      ...baseMetadata,
      directSessionV1: {
        ...metadata.directSessionV1,
        followPolicyV1: {
          v: 1,
          policy: 'background_follow',
          updatedAtMs: 42,
        },
      },
    });
  });

  it('keeps the legacy direct-session background-follow metadata updater export aligned with the observed-progress updater', () => {
    expect(typeof updateSessionMetadataWithDirectSessionBackgroundFollowCompat).toBe('function');

    const metadata = {
      ...baseMetadata,
      directSessionV1: {
        v: 1 as const,
        providerId: 'claude',
        machineId: 'machine-1',
        remoteSessionId: 'remote-1',
        source: { kind: 'claudeConfig' as const },
        linkedAtMs: 1,
      },
    };
    const params = {
      observedProgress: {
        token: '123:message_1',
        atMs: 123,
      },
      lastKnownActivityAtMs: 123,
    };

    expect(updateMetadataWithDirectSessionBackgroundFollow(metadata, params)).toEqual(
      updateMetadataWithDirectSessionObservedProgress(metadata, params),
    );
  });

  it('persists follow policy through the shared metadata retry path', async () => {
    updateSessionMetadataWithRetryMock.mockImplementationOnce(async ({ updater }: {
      updater: (metadata: Record<string, unknown>) => Record<string, unknown>;
    }) => ({
      metadata: updater({
        directSessionV1: {
          v: 1,
          providerId: 'claude',
        },
      }),
      version: 2,
    }));

    await updateSessionMetadataWithDirectSessionFollowPolicy({
      token: 'token-1',
      credentials: { token: 'token-1', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      sessionId: 'session-1',
      rawSession: {
        metadata: '{}',
        metadataVersion: 1,
        encryptionMode: 'plain',
      },
      policy: 'attached_only',
      updatedAtMs: 99,
    });

    expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledWith(expect.objectContaining({
      token: 'token-1',
      sessionId: 'session-1',
    }));
    const retryArgs = updateSessionMetadataWithRetryMock.mock.calls[0]?.[0];
    const next = retryArgs.updater({
      directSessionV1: {
        v: 1,
        providerId: 'claude',
      },
    });
    expect(next.directSessionV1).toEqual({
      v: 1,
      providerId: 'claude',
      followPolicyV1: {
        v: 1,
        policy: 'attached_only',
        updatedAtMs: 99,
      },
    });
  });
});
