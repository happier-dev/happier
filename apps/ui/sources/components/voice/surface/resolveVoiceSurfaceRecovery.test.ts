import { describe, expect, it } from 'vitest';

import { resolveVoiceSurfaceRecovery } from './resolveVoiceSurfaceRecovery';

describe('resolveVoiceSurfaceRecovery', () => {
  it.each([
    ['review_credentials', 'review_credentials', 'voicePresence.recovery.setUp', 'gear'],
    // VOICE-START-REASON-1107: use the same Machine recovery as Settings.
    ['select_execution_machine', 'select_execution_machine', 'voice.readiness.actions.select_execution_machine', 'gear'],
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

  it('does not render a recovery action for terminal none', () => {
    expect(resolveVoiceSurfaceRecovery('none')).toBeNull();
    expect(resolveVoiceSurfaceRecovery(null)).toBeNull();
  });
});
