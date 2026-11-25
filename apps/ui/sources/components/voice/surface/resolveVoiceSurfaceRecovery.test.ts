import { describe, expect, it } from 'vitest';

import { resolveVoiceSnapshotRecoveryAction, resolveVoiceSurfaceRecovery } from './resolveVoiceSurfaceRecovery';

describe('resolveVoiceSurfaceRecovery', () => {
  it.each([
    ['review_credentials', 'review_credentials', 'voicePresence.recovery.setUp', 'gear'],
    ['select_speech_engine', 'select_speech_engine', 'voicePresence.recovery.setUp', 'gear'],
    ['open_settings', 'open_settings', 'voicePresence.recovery.setUp', 'gear'],
    ['open_settings_then_reconnect', 'open_settings', 'voicePresence.recovery.allow', 'microphone'],
    ['retry', 'retry', 'common.retry', 'arrow-clockwise'],
    ['reconnect', 'reconnect', 'voiceSurface.reconnect', 'arrow-clockwise'],
    ['connect_agent', 'connect_agent', 'voiceSurface.connectAgent', 'gear'],
    ['install_agent_runtime', 'install_agent_runtime', 'voiceSurface.installAgentRuntime', 'gear'],
    ['update_agent_runtime', 'update_agent_runtime', 'voiceSurface.updateAgentRuntime', 'gear'],
  ] as const)('maps %s to one actionable %s recovery with one label and glyph', (action, kind, labelKey, icon) => {
    // One label per action, drawn and announced alike in every placement (R12b): settings
    // recoveries read as "Set up", never "Open Settings" (the system Settings app).
    expect(resolveVoiceSurfaceRecovery(action)).toEqual({ kind, labelKey, icon });
  });

  it('retries an unreachable machine first and keeps Choose a machine as the alternate', () => {
    // The machine may come back (lab ST: "Retry"); choosing another one is the second remedy.
    expect(resolveVoiceSurfaceRecovery('select_execution_machine')).toEqual({
      kind: 'select_execution_machine',
      labelKey: 'common.retry',
      icon: 'arrow-clockwise',
      alternate: { labelKey: 'voice.readiness.actions.select_execution_machine', icon: 'gear' },
    });
  });

  it('does not render a recovery action for terminal none', () => {
    expect(resolveVoiceSurfaceRecovery('none')).toBeNull();
    expect(resolveVoiceSurfaceRecovery(null)).toBeNull();
  });

  it('offers Retry while a lost connection waits between tries, and the failure\'s own remedy first', () => {
    expect(resolveVoiceSurfaceRecovery(resolveVoiceSnapshotRecoveryAction({ presentationState: 'reconnecting', reconnectRetryAvailable: true })))
      .toEqual({ kind: 'retry', labelKey: 'common.retry', icon: 'arrow-clockwise' });
    expect(resolveVoiceSnapshotRecoveryAction({ presentationState: 'reconnecting' })).toBeNull();
    expect(resolveVoiceSnapshotRecoveryAction({ presentationState: 'reconnecting', reconnectRetryAvailable: true, errorRecoveryAction: 'review_credentials' }))
      .toBe('review_credentials');
  });
});
