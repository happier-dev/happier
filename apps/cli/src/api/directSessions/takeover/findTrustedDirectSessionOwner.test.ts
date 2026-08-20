import { describe, expect, it } from 'vitest';

import type { DaemonSessionMarker } from '@/daemon/sessionRegistry';

import { findTrustedDirectSessionOwner } from './findTrustedDirectSessionOwner';

describe('findTrustedDirectSessionOwner', () => {
  it('finds a live Happier-managed pi owner by its persisted pi session id', () => {
    const marker = {
      pid: 4242,
      happySessionId: 'happy_pi_owner',
      updatedAt: 200,
      flavor: 'pi',
      metadata: { flavor: 'pi', piSessionId: 'pi-session-1' },
    } as DaemonSessionMarker;

    expect(findTrustedDirectSessionOwner({
      markers: [marker],
      providerId: 'pi',
      remoteSessionId: 'pi-session-1',
      isPidAlive: () => true,
    })).toBe(marker);
  });
});
