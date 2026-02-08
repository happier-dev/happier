import { describe, expect, it, vi } from 'vitest';

import { toggleLocalVoiceTurnWithTracking } from './localVoiceTelemetry';

describe('toggleLocalVoiceTurnWithTracking', () => {
  it('captures statusBefore/statusAfter after awaiting the toggle', async () => {
    let status: 'idle' | 'recording' = 'idle';
    const toggle = vi.fn(async () => {
      status = status === 'idle' ? 'recording' : 'idle';
    });
    const getStatus = () => status;
    const tracking = { capture: vi.fn() };

    await toggleLocalVoiceTurnWithTracking({ sessionId: 's1', toggleLocalVoiceTurn: toggle, getStatus, tracking });

    expect(tracking.capture).toHaveBeenCalledWith('voice_local_turn_toggled', {
      sessionId: 's1',
      statusBefore: 'idle',
      statusAfter: 'recording',
    });
  });

  it('is a no-op for tracking when tracking is undefined', async () => {
    const toggle = vi.fn(async () => {});
    await expect(
      toggleLocalVoiceTurnWithTracking({
        sessionId: 's1',
        toggleLocalVoiceTurn: toggle,
        getStatus: () => 'idle',
      }),
    ).resolves.toBeUndefined();
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('does not capture event when toggle throws', async () => {
    const capture = vi.fn();
    await expect(
      toggleLocalVoiceTurnWithTracking({
        sessionId: 's1',
        toggleLocalVoiceTurn: async () => {
          throw new Error('toggle-failed');
        },
        getStatus: () => 'idle',
        tracking: { capture },
      }),
    ).rejects.toThrow('toggle-failed');
    expect(capture).not.toHaveBeenCalled();
  });
});
