import { describe, expect, it } from 'vitest';

import { resolveVoiceSurfaceRecovery } from './resolveVoiceSurfaceRecovery';

describe('resolveVoiceSurfaceRecovery', () => {
  it.each([
    ['review_credentials', 'review_credentials', 'voiceSurface.reviewCredentials'],
    ['open_settings', 'open_settings', 'modals.openSettings'],
    ['open_settings_then_reconnect', 'open_settings', 'modals.openSettings'],
    ['retry', 'retry', 'common.retry'],
    ['reconnect', 'reconnect', 'voiceSurface.reconnect'],
    ['connect_agent', 'connect_agent', 'voiceSurface.connectAgent'],
    ['install_agent_runtime', 'install_agent_runtime', 'voiceSurface.installAgentRuntime'],
    ['update_agent_runtime', 'update_agent_runtime', 'voiceSurface.updateAgentRuntime'],
  ] as const)('maps %s to one actionable %s recovery', (action, kind, labelKey) => {
    expect(resolveVoiceSurfaceRecovery(action)).toEqual({ kind, labelKey });
  });

  it('uses the existing localized execution-machine action for unavailable machine recovery', () => {
    expect(resolveVoiceSurfaceRecovery('select_execution_machine')).toEqual({
      kind: 'select_execution_machine',
      labelKey: 'voice.readiness.actions.select_execution_machine',
    });
  });

  it('does not render a recovery action for terminal none', () => {
    expect(resolveVoiceSurfaceRecovery('none')).toBeNull();
    expect(resolveVoiceSurfaceRecovery(null)).toBeNull();
  });
});
