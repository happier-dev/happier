import { describe, expect, it } from 'vitest';

import type { TrackedSession } from '@/daemon/types';

import {
  hasTrackedConnectedServiceGroupBinding,
  resolveTrackedConnectedServiceBindingsRaw,
} from './trackedSessionConnectedServiceBindings';

function trackedSession(overrides: Partial<TrackedSession> = {}): TrackedSession {
  return {
    startedBy: 'daemon',
    happySessionId: 'sess_1',
    pid: 123,
    spawnOptions: {
      directory: '/tmp/project',
    },
    ...overrides,
  };
}

describe('trackedSessionConnectedServiceBindings', () => {
  it('falls back to webhook metadata when spawn options do not carry connected-service bindings', () => {
    const metadataBindings = {
      v: 1 as const,
      bindingsByServiceId: {
        anthropic: {
          source: 'connected' as const,
          selection: 'group' as const,
          profileId: 'profile_1',
          groupId: 'work',
        },
      },
    };
    const tracked = trackedSession({
      happySessionMetadataFromLocalWebhook: {
        path: '/tmp/project',
        host: 'test-host',
        homeDir: '/tmp/home',
        happyHomeDir: '/tmp/home/.happier',
        happyLibDir: '/tmp/home/.happier/lib',
        happyToolsDir: '/tmp/home/.happier/tools',
        connectedServices: metadataBindings,
      },
    });

    expect(resolveTrackedConnectedServiceBindingsRaw(tracked)).toBe(metadataBindings);
    expect(hasTrackedConnectedServiceGroupBinding({
      tracked,
      serviceId: 'anthropic',
      groupId: 'work',
    })).toBe(true);
  });

  it('prefers live spawn options over stale webhook metadata', () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            anthropic: {
              source: 'connected',
              selection: 'group',
              profileId: 'profile_live',
              groupId: 'live',
            },
          },
        },
      },
      happySessionMetadataFromLocalWebhook: {
        path: '/tmp/project',
        host: 'test-host',
        homeDir: '/tmp/home',
        happyHomeDir: '/tmp/home/.happier',
        happyLibDir: '/tmp/home/.happier/lib',
        happyToolsDir: '/tmp/home/.happier/tools',
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            anthropic: {
              source: 'connected',
              selection: 'group',
              profileId: 'profile_stale',
              groupId: 'stale',
            },
          },
        },
      },
    });

    expect(hasTrackedConnectedServiceGroupBinding({
      tracked,
      serviceId: 'anthropic',
      groupId: 'live',
    })).toBe(true);
    expect(hasTrackedConnectedServiceGroupBinding({
      tracked,
      serviceId: 'anthropic',
      groupId: 'stale',
    })).toBe(false);
  });
});
