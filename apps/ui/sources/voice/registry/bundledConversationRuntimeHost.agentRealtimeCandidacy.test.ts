import { beforeEach, describe, expect, it } from 'vitest';

import { createSessionFixture } from '@/dev/testkit';
import type { Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';

import { createBundledConversationRuntimeHostLease } from './bundledConversationRuntimeHost';

const PROVIDER = Object.freeze({ pluginId: 'happier.agent.codex', localId: 'realtime-codex' });
const AGENT = Object.freeze({ pluginId: 'happier.agent.codex', localId: 'codex' });
const SESSION_ID = 'agent-realtime-candidate-session';

function installSession(overrides: Partial<Session>): void {
  storage.setState((current) => ({
    ...current,
    sessions: {
      [SESSION_ID]: createSessionFixture({
        id: SESSION_ID,
        active: true,
        ...overrides,
      }),
    },
  }) as never);
}

async function resolveAgentRealtimeBinding() {
  const lease = createBundledConversationRuntimeHostLease();
  try {
    return await lease.host.resolveAgentRealtimeVoiceConversationBinding!({
      provider: PROVIDER,
      agent: AGENT,
      controlSessionId: SESSION_ID,
      requestedTargetSessionId: null,
      settings: {},
    });
  } finally {
    lease.revoke();
  }
}

describe('Agent-realtime session candidacy for an unreadable owner metadata view', () => {
  beforeEach(() => {
    storage.setState((current) => ({ ...current, sessions: {} }) as never);
  });

  it('keeps a layout-1 session whose owner projection has not landed on the retryable fallback', async () => {
    // A live layout-1 session the device has not yet projected/decrypted the
    // owner view for. The same read succeeds once the projection arrives, so it
    // must not settle as a never-retryable terminal decline.
    installSession({
      metadataLayoutVersion: 1,
      metadata: { path: '/Users/tester/project', host: 'tester.local' } as Session['metadata'],
      ownerMetadataView: null,
    });

    await expect(resolveAgentRealtimeBinding()).resolves.toBeNull();
  });

  it('declines a session metadata layout this build cannot read as update-required', async () => {
    installSession({
      metadataLayoutVersion: 2,
      metadata: { path: '/Users/tester/project', host: 'tester.local' } as Session['metadata'],
      ownerMetadataView: null,
    });

    await expect(resolveAgentRealtimeBinding()).rejects.toMatchObject({
      code: 'update_required',
    });
  });

  it('still declines a readable session that carries no Agent identity as feature-unavailable', async () => {
    installSession({
      metadataLayoutVersion: 1,
      metadata: { path: '/Users/tester/project', host: 'tester.local' } as Session['metadata'],
      ownerMetadataView: {
        path: '/Users/tester/project',
        host: 'tester.local',
      } as Session['metadata'],
    });

    await expect(resolveAgentRealtimeBinding()).rejects.toMatchObject({
      code: 'feature_unavailable',
    });
  });
});
