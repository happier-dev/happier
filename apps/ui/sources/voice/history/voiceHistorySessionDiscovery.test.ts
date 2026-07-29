import { describe, expect, it, vi } from 'vitest';

import type { Session } from '@/sync/domains/state/storageTypes';
import {
  VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG,
} from '@/voice/persistence/voiceTranscriptHistorySession';

import {
  discoverVoiceHistorySession,
  type VoiceHistorySessionDiscoveryDeps,
} from './voiceHistorySessionDiscovery';

function carrierSession(input: Readonly<{
  id: string;
  active?: boolean;
  key?: string;
  hidden?: boolean;
}>) {
  return {
    id: input.id,
    active: input.active ?? false,
    metadata: {
      systemSessionV1: {
        v: 1,
        key: input.key ?? 'voice_transcript_history',
        hidden: input.hidden ?? true,
      },
    },
  };
}

describe('discoverVoiceHistorySession', () => {
  it('looks up only the canonical fixed tag and accepts only its hydrated inactive hidden marker', async () => {
    const sessions = new Map<string, ReturnType<typeof carrierSession>>([
      ['active', carrierSession({ id: 'active', active: true })],
      ['wrong-marker', carrierSession({ id: 'wrong-marker', key: 'voice_conversation' })],
      ['history', carrierSession({ id: 'history' })],
    ]);
    const lookupByTags = vi.fn(async () => [
      { id: 'active' },
      { id: 'wrong-marker' },
      { id: 'history' },
    ]);
    const hydrateSession = vi.fn(async (sessionId: string) => ({
      kind: 'available',
      sessionId,
    }));

    await expect(discoverVoiceHistorySession({
      lookupByTags,
      hydrateSession,
      readHydratedSession: (sessionId) =>
        (sessions.get(sessionId) as unknown as Session | undefined) ?? null,
    })).resolves.toBe('history');

    expect(lookupByTags).toHaveBeenCalledWith([
      VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG,
    ]);
    expect(hydrateSession).toHaveBeenCalledTimes(3);
  });

  it('returns empty without creating when lookup has no exact carrier or hydration is unavailable', async () => {
    const deps: VoiceHistorySessionDiscoveryDeps = {
      lookupByTags: vi.fn(async () => [{ id: 'history' }]),
      hydrateSession: vi.fn(async () => ({ kind: 'missing', sessionId: 'history' })),
      readHydratedSession: vi.fn(() =>
        carrierSession({ id: 'history' }) as unknown as Session),
    };

    await expect(discoverVoiceHistorySession(deps)).resolves.toBeNull();
    expect(deps.readHydratedSession).not.toHaveBeenCalled();
  });
});
