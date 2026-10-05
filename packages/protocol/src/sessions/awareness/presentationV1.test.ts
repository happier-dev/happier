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

  it('preserves actionable owner facts while disconnected', () => {
    for (const primary of ['permission_required', 'action_required', 'failed'] as const) {
      expect(readSessionAwarenessWorkStatusV1({
        awareness: { runtime: 'offline', operational: { primary } }, settled: true,
      })).toEqual({ bucket: 'needs_you', tone: primary === 'failed' ? 'danger' : 'attention' });
    }
  });
});
