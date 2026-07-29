import { describe, expect, it } from 'vitest';

import type { VoiceSessionSnapshot } from './types';
import { deriveMicButtonProjection } from './deriveMicButtonProjection';

function snapshot(status: VoiceSessionSnapshot['status']): VoiceSessionSnapshot {
  return {
    adapterId: status === 'disconnected' ? null : 'local_direct',
    sessionId: status === 'disconnected' ? null : 's1',
    status,
    mode: 'idle',
    canStop: status !== 'disconnected',
  };
}

describe('deriveMicButtonProjection', () => {
  it.each([
    ['connecting', true],
    ['connected', true],
    ['disconnected', false],
    ['error', false],
  ] as const)('projects known %s status without shell-local inference', (status, active) => {
    expect(deriveMicButtonProjection({
      selectedProviderId: 'local_direct',
      snapshot: snapshot(status),
    })).toMatchObject({ active, available: true, configured: true });
  });

  it('keeps an active runtime stoppable after its provider selection is cleared', () => {
    expect(deriveMicButtonProjection({
      selectedProviderId: null,
      snapshot: snapshot('connected'),
    })).toEqual({ active: true, available: true, configured: false });
  });

  it('fails inactive and unavailable for an unknown runtime status', () => {
    expect(deriveMicButtonProjection({
      selectedProviderId: 'local_direct',
      snapshot: {
        ...snapshot('connected'),
        status: 'future_status',
      } as unknown as VoiceSessionSnapshot,
    })).toEqual({ active: false, available: false, configured: true });
  });

  it('fails inactive and unavailable for a malformed provider id', () => {
    expect(deriveMicButtonProjection({
      selectedProviderId: ' future-provider ' as never,
      snapshot: snapshot('connected'),
    })).toEqual({ active: false, available: false, configured: false });
  });

  it('hides the mic action when no provider is configured and no runtime is active', () => {
    expect(deriveMicButtonProjection({
      selectedProviderId: null,
      snapshot: snapshot('disconnected'),
    })).toEqual({ active: false, available: false, configured: false });
  });
});
