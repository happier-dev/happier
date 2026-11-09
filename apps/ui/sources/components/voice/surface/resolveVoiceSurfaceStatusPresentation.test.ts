import { describe, expect, it } from 'vitest';
import { hasTranslation, tLoose } from '../../../text/i18n';

import {
  resolveVoiceSurfaceStatusPresentation,
  type VoiceSurfaceStatusPresentation,
} from './resolveVoiceSurfaceStatusPresentation';
import type { VoiceSurfaceState } from './resolveVoiceSurfaceState';

// Exhaustive over VoiceSurfaceState by construction: widening the union stops this table from
// type-checking, so a new state can never reach a presentation by falling through a default branch.
const expectedByState = {
  idle: { tone: 'neutral', labelKey: 'voiceAssistant.label' },
  live: { tone: 'active', labelKey: 'voiceAssistant.connected' },
  connecting: { tone: 'pending', labelKey: 'voiceAssistant.connecting' },
  reconnecting: { tone: 'pending', labelKey: 'voiceAssistant.reconnecting' },
  listening: { tone: 'active', labelKey: 'voiceAssistant.listening' },
  transcribing: { tone: 'pending', labelKey: 'voiceAssistant.transcribing' },
  thinking: { tone: 'pending', labelKey: 'voiceAssistant.thinking' },
  speaking: { tone: 'active', labelKey: 'voiceAssistant.speaking' },
  permission_required: { tone: 'error', labelKey: 'voiceAssistant.microphonePermissionRequired', wordKey: 'voiceAssistant.microphoneBlocked' },
  interrupted: { tone: 'pending', labelKey: 'voiceAssistant.interrupted' },
  error: { tone: 'error', labelKey: 'common.error' },
} satisfies Record<VoiceSurfaceState, VoiceSurfaceStatusPresentation>;

const allStates = Object.keys(expectedByState) as readonly VoiceSurfaceState[];

describe('resolveVoiceSurfaceStatusPresentation', () => {
  it.each(allStates)('renders an existing translation for the live %s status', (state) => {
    const { labelKey, wordKey } = resolveVoiceSurfaceStatusPresentation(state);
    for (const key of wordKey ? [labelKey, wordKey] : [labelKey]) {
      expect(hasTranslation(key), `Missing Voice status translation: ${key}`).toBe(true);
      expect(tLoose(key)).not.toBe(key);
    }
  });

  it.each(allStates)('projects %s to its own semantic tone and label key', (state) => {
    expect(resolveVoiceSurfaceStatusPresentation(state)).toEqual(expectedByState[state]);
  });

  it.each([
    ['voice_connection_failed', 'voiceAssistant.connectionError'],
    ['voice_connection_timeout', 'voiceAssistant.connectionError'],
    ['provider_response_invalid', 'common.error'],
    ['rate_limited', 'common.error'],
  ] as const)('only identifies an explicit connection failure for %s', (reason, labelKey) => {
    expect(resolveVoiceSurfaceStatusPresentation('error', reason)).toEqual({ tone: 'error', labelKey });
  });
});
