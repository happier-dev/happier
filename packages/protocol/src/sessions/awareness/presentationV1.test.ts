import { describe, expect, it } from 'vitest';

import { readSessionAwarenessWorkStatusV1, readSessionWorkStateGroupV1 } from './presentationV1.js';

describe('readSessionAwarenessWorkStatusV1', () => {
  it('keeps disconnected work quiet and in Recent, even with previous settlement', () => {
    for (const settled of [false, true]) {
      const status = readSessionAwarenessWorkStatusV1({
        awareness: { runtime: 'offline', operational: { primary: 'none' } }, settled,
      });
      expect(status).toEqual({ bucket: 'offline', tone: 'neutral' });
      expect(readSessionWorkStateGroupV1(status.bucket)).toBe('recent');
    }
  });

  it('does not claim actionable work when its runtime cannot serve it', () => {
    for (const primary of ['permission_required', 'action_required', 'failed'] as const) {
      expect(readSessionAwarenessWorkStatusV1({
        awareness: { runtime: 'offline', operational: { primary } }, settled: true,
      })).toEqual({ bucket: 'offline', tone: 'neutral' });
    }
  });

  it('keeps unreadable content and unknown or stale runtimes out of Needs you', () => {
    for (const primary of ['failed', 'permission_required', 'action_required', 'working'] as const) {
      for (const encryption of ['locked', 'preparing', 'repair_needed', 'access_pending', 'setup_required', 'content_unavailable', 'unknown'] as const) {
        expect(readSessionAwarenessWorkStatusV1({ awareness: { runtime: 'working', encryption,
          operational: { primary } } })).toEqual({ bucket: 'idle', tone: 'neutral' });
      }
      for (const runtime of ['unknown', 'offline'] as const) {
        expect(readSessionAwarenessWorkStatusV1({ awareness: { runtime, encryption: 'ready',
          operational: { primary } } })).toEqual({ bucket: runtime === 'offline' ? 'offline' : 'idle', tone: 'neutral' });
      }
      expect(readSessionAwarenessWorkStatusV1({ awareness: { runtime: 'working', freshness: 'stale',
        encryption: 'plain', operational: { primary } } })).toEqual({ bucket: 'idle', tone: 'neutral' });
    }
  });

  it('preserves live actionable facts and quiet settlement', () => {
    for (const primary of ['failed', 'permission_required', 'action_required'] as const) {
      expect(readSessionAwarenessWorkStatusV1({ awareness: { runtime: 'waiting', encryption: 'ready',
        operational: { primary } } })).toEqual({ bucket: 'needs_you', tone: primary === 'failed' ? 'danger' : 'attention' });
    }
    expect(readSessionAwarenessWorkStatusV1({ awareness: { runtime: 'idle', encryption: 'plain',
      operational: { primary: 'ready' } }, settled: true })).toEqual({ bucket: 'finished', tone: 'neutral' });
    expect(readSessionAwarenessWorkStatusV1({ awareness: { runtime: 'offline', lifecycle: 'archived',
      encryption: 'locked', operational: { primary: 'failed' } } })).toEqual({ bucket: 'idle', tone: 'neutral' });
    expect(readSessionAwarenessWorkStatusV1({ awareness: { runtime: 'offline', encryption: 'plain',
      operational: { primary: 'working', reasons: ['resuming'] } } })).toEqual({ bucket: 'idle', tone: 'neutral' });
  });
});
