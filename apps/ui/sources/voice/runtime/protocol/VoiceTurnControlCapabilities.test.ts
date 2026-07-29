import { describe, expect, it } from 'vitest';

import {
  resolveVoiceTurnControlAction,
  type VoiceTurnControlCapabilities,
} from './VoiceTurnControlCapabilities';

const CAPABILITIES: VoiceTurnControlCapabilities = Object.freeze({
  cancelResponse: 'immediate',
  truncatePlayback: 'played_ms',
  clearInput: true,
  stopSession: true,
  resumption: 'resume',
  replay: 'stable_ids',
  exactMessage: false,
});

describe('resolveVoiceTurnControlAction', () => {
  it('gates each action on its actual semantic capability', () => {
    expect(resolveVoiceTurnControlAction(CAPABILITIES, 'cancel_response')).toEqual({ status: 'available' });
    expect(resolveVoiceTurnControlAction(CAPABILITIES, 'truncate_playback')).toEqual({
      status: 'available',
      basis: 'played_ms',
    });
    expect(resolveVoiceTurnControlAction(CAPABILITIES, 'clear_input')).toEqual({ status: 'available' });
    expect(resolveVoiceTurnControlAction(CAPABILITIES, 'stop_session')).toEqual({ status: 'available' });
    expect(resolveVoiceTurnControlAction(CAPABILITIES, 'resume_session')).toEqual({
      status: 'available',
      strategy: 'resume',
    });
    expect(resolveVoiceTurnControlAction(CAPABILITIES, 'replay_session')).toEqual({
      status: 'available',
      strategy: 'stable_ids',
    });
    expect(resolveVoiceTurnControlAction(CAPABILITIES, 'send_exact_message')).toEqual({
      status: 'unavailable',
      code: 'voice_turn_action_unsupported',
    });
  });

  it('returns typed unavailable outcomes instead of guessing provider events', () => {
    const unsupported: VoiceTurnControlCapabilities = {
      cancelResponse: 'unsupported',
      truncatePlayback: 'unsupported',
      clearInput: false,
      stopSession: false,
      resumption: 'none',
      replay: 'none',
      exactMessage: false,
    };
    for (const action of [
      'cancel_response',
      'truncate_playback',
      'clear_input',
      'stop_session',
      'resume_session',
      'replay_session',
      'send_exact_message',
    ] as const) {
      expect(resolveVoiceTurnControlAction(unsupported, action)).toEqual({
        status: 'unavailable',
        code: 'voice_turn_action_unsupported',
      });
    }
  });
});
