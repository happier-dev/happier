import { describe, expect, it } from 'vitest';

import {
  resolveVoiceSurfaceStatusPresentation,
  type VoiceSurfaceStatusPresentation,
} from './resolveVoiceSurfaceStatusPresentation';
import type { VoiceSurfaceState } from './resolveVoiceSurfaceState';

// Exhaustive over VoiceSurfaceState by construction: widening the union stops this table from
// type-checking, so a new state can never reach a presentation by falling through a default branch.
const expectedByState = {
  idle: { tone: 'neutral', labelKey: 'voiceAssistant.label' },
  connecting: { tone: 'pending', labelKey: 'voiceAssistant.connecting' },
  reconnecting: { tone: 'pending', labelKey: 'voiceAssistant.reconnecting' },
  listening: { tone: 'active', labelKey: 'voiceAssistant.listening' },
  transcribing: { tone: 'pending', labelKey: 'voiceAssistant.transcribing' },
  thinking: { tone: 'pending', labelKey: 'voiceAssistant.thinking' },
  speaking: { tone: 'active', labelKey: 'voiceAssistant.speaking' },
  permission_required: { tone: 'error', labelKey: 'voiceAssistant.microphonePermissionRequired' },
  interrupted: { tone: 'pending', labelKey: 'voiceAssistant.interrupted' },
  error: { tone: 'error', labelKey: 'voiceAssistant.connectionError' },
} satisfies Record<VoiceSurfaceState, VoiceSurfaceStatusPresentation>;

const allStates = Object.keys(expectedByState) as readonly VoiceSurfaceState[];

describe('resolveVoiceSurfaceStatusPresentation', () => {
  it.each(allStates)('projects %s to its own semantic tone and label key', (state) => {
    expect(resolveVoiceSurfaceStatusPresentation(state)).toEqual(expectedByState[state]);
  });

  it('never lets a non-idle state fall through to the idle presentation', () => {
    const idle = resolveVoiceSurfaceStatusPresentation('idle');
    const nonIdleStates = allStates.filter((state) => state !== 'idle');
    expect(nonIdleStates.length).toBeGreaterThan(0);
    for (const state of nonIdleStates) {
      expect(resolveVoiceSurfaceStatusPresentation(state).labelKey).not.toBe(idle.labelKey);
    }
  });

  it('reports a truthful tone for every state a presentation must paint', () => {
    expect(resolveVoiceSurfaceStatusPresentation('error').tone).toBe('error');
    expect(resolveVoiceSurfaceStatusPresentation('permission_required').tone).toBe('error');
    expect(resolveVoiceSurfaceStatusPresentation('listening').tone).toBe('active');
    expect(resolveVoiceSurfaceStatusPresentation('idle').tone).toBe('neutral');
  });
});
