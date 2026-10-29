import { describe, expect, it } from 'vitest';

import { resolveVoiceSurfaceState } from './resolveVoiceSurfaceState';

describe('resolveVoiceSurfaceState', () => {
  it.each([
    [{ status: 'connecting', mode: 'idle' }, 'connecting'],
    [{ status: 'connected', mode: 'listening' }, 'listening'],
    [{ status: 'connected', mode: 'transcribing' }, 'transcribing'],
    [{ status: 'connected', mode: 'thinking' }, 'thinking'],
    [{ status: 'connected', mode: 'speaking' }, 'speaking'],
    [{ status: 'connected', mode: 'idle' }, 'idle'],
  ] as const)('projects %o to %s', (snapshot, expected) => {
    expect(resolveVoiceSurfaceState(snapshot)).toBe(expected);
  });

  it('keeps permission-required, interruption, and hard error semantically distinct', () => {
    expect(resolveVoiceSurfaceState({
      status: 'disconnected',
      mode: 'idle',
      errorPresentation: 'permission_required',
    })).toBe('permission_required');
    expect(resolveVoiceSurfaceState({
      status: 'connected',
      mode: 'listening',
      presentationState: 'interrupted',
    })).toBe('interrupted');
    expect(resolveVoiceSurfaceState({
      status: 'error',
      mode: 'idle',
      errorPresentation: 'error',
    })).toBe('error');
  });

  it('uses a truthful reconnecting projection instead of inferring it from connecting', () => {
    expect(resolveVoiceSurfaceState({
      status: 'connecting',
      mode: 'idle',
      presentationState: 'reconnecting',
    })).toBe('reconnecting');
    expect(resolveVoiceSurfaceState({ status: 'connecting', mode: 'idle' })).toBe('connecting');
  });

  it('keeps a terminal retryable failure visible while clean ends and interruptions stay idle', () => {
    expect(resolveVoiceSurfaceState({ status: 'disconnected', mode: 'idle', errorPresentation: 'notice' })).toBe('error');
    expect(resolveVoiceSurfaceState({ status: 'disconnected', mode: 'idle' })).toBe('idle');
    expect(resolveVoiceSurfaceState({ status: 'disconnected', mode: 'idle', errorPresentation: 'interrupted' })).toBe('idle');
    expect(resolveVoiceSurfaceState({ status: 'connected', mode: 'listening', errorPresentation: 'notice' })).toBe('listening');
  });
});
