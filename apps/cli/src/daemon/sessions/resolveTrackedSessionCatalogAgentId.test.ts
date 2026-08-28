import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/api/types';
import type { TrackedSession } from '@/daemon/types';
import { resolveTrackedSessionCatalogAgentId } from './resolveTrackedSessionCatalogAgentId';

function trackedSession(overrides: Partial<TrackedSession>): TrackedSession {
  return {
    startedBy: 'daemon',
    pid: 123,
    ...overrides,
  };
}

function metadata(overrides: Partial<Metadata>): Metadata {
  return {
    path: '/repo',
    host: 'host',
    homeDir: '/home/user',
    happyHomeDir: '/home/user/.happy',
    happyLibDir: '/home/user/.happy/lib',
    happyToolsDir: '/home/user/.happy/tools',
    ...overrides,
  };
}

describe('resolveTrackedSessionCatalogAgentId', () => {
  it('uses the explicit built-in backend target before webhook metadata', () => {
    expect(resolveTrackedSessionCatalogAgentId(trackedSession({
      happySessionMetadataFromLocalWebhook: metadata({
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          agent: { backendMode: 'appServer', providerSessionId: 'codex-session' },
        },
      }),
      spawnOptions: {
        directory: '/repo',
        backendTarget: { kind: 'backend', backendId: 'opencode', sourceKind: 'built_in' },
      } as TrackedSession['spawnOptions'],
    }))).toBe('opencode');
  });

  it('infers Codex from webhook metadata when spawn options are not hydrated yet', () => {
    expect(resolveTrackedSessionCatalogAgentId(trackedSession({
      happySessionMetadataFromLocalWebhook: metadata({
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          agent: { backendMode: 'appServer', providerSessionId: 'codex-session' },
        },
      }),
    }))).toBe('codex');
  });

  it('does not turn configured ACP backend targets into built-in catalog identities', () => {
    expect(resolveTrackedSessionCatalogAgentId(trackedSession({
      happySessionMetadataFromLocalWebhook: metadata({
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          agent: { backendMode: 'appServer', providerSessionId: 'codex-session' },
        },
      }),
      spawnOptions: {
        directory: '/repo',
        backendTarget: {
          kind: 'backend',
          backendId: 'review-bot',
          configuredBackendId: 'review-bot',
          sourceKind: 'configured',
        },
      } as TrackedSession['spawnOptions'],
    }))).toBeNull();
  });
});
