import { describe, expect, it } from 'vitest';

import type { DaemonSessionMarker } from '@/daemon/sessionRegistry';

import { findTrustedDirectSessionOwner } from './findTrustedDirectSessionOwner';

function createMarker(params: Readonly<{
  pid: number;
  updatedAt: number;
  flavor: DaemonSessionMarker['flavor'];
  metadata: unknown;
}>): DaemonSessionMarker {
  return {
    pid: params.pid,
    happySessionId: `sess-${params.pid}`,
    happyHomeDir: '/home/happier',
    createdAt: params.updatedAt - 1,
    updatedAt: params.updatedAt,
    flavor: params.flavor,
    metadata: params.metadata,
  };
}

describe('findTrustedDirectSessionOwner', () => {
  it('returns the newest alive marker that matches provider and remote session id', () => {
    const owner = findTrustedDirectSessionOwner({
      providerId: 'opencode',
      remoteSessionId: 'oc-2',
      isPidAlive: (pid) => pid !== 13,
      markers: [
        createMarker({ pid: 12, updatedAt: 100, flavor: 'opencode', metadata: { flavor: 'opencode', opencodeSessionId: 'oc-2' } }),
        createMarker({ pid: 13, updatedAt: 200, flavor: 'opencode', metadata: { flavor: 'opencode', opencodeSessionId: 'oc-2' } }),
        createMarker({ pid: 14, updatedAt: 300, flavor: 'claude', metadata: { flavor: 'claude', claudeSessionId: 'oc-2' } }),
      ],
    });

    expect(owner?.pid).toBe(12);
  });

  it('returns null when no marker matches the remote session id', () => {
    expect(
      findTrustedDirectSessionOwner({
        providerId: 'codex',
        remoteSessionId: 'thread-1',
        markers: [],
      }),
    ).toBeNull();
  });
});
