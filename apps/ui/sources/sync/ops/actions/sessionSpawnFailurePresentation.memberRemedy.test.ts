import { describe, expect, it, vi } from 'vitest';
import type { SessionSpawnNewResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { preloadTranslations, t } from '@/text';
import { presentSessionSpawnNewAgentIsolationFailure } from './sessionSpawnFailurePresentation';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

describe('member setup refusal remedies', () => {
  it.each(['ask_machine_manager', 'open_machine_security'] as const)('presents the plugin-code %s remedy through the existing Security navigation', async kind => {
    await preloadTranslations('en');
    const result = SessionSpawnNewResultV1Schema.parse({ type: 'error', code: 'spawn_failed', retryable: false, launchError: {
      kind: 'launch_error', code: 'plugin_code_unreadable', message: 'Plugin code is unavailable',
      pluginCodeRefusal: { remedy: kind === 'open_machine_security'
        ? { kind, target: { serverId: 'saved-home', machineId: 'member/machine' } } : { kind } },
    } });
    if (result.type === 'success') throw new Error('Expected a launch refusal');
    const navigate = vi.fn();
    const alert = vi.fn();
    expect(presentSessionSpawnNewAgentIsolationFailure(result, navigate, alert)).toBe(true);
    const [, message, buttons] = alert.mock.calls[0]!;
    expect(message).toBe(t(kind === 'ask_machine_manager'
      ? 'errors.pluginCodeUnreadableAskManager' : 'errors.pluginCodeUnreadableOpenSecurity'));
    if (kind === 'ask_machine_manager') {
      expect(buttons).toBeUndefined();
      expect(navigate).not.toHaveBeenCalled();
    } else {
      buttons.find((button: { onPress?: () => void }) => button.onPress)?.onPress();
      expect(navigate).toHaveBeenCalledWith('/machines/member%2Fmachine?serverId=saved-home&tab=security');
    }
  });
  it.each(['ask_machine_manager', 'open_machine_security'] as const)('consumes the %s remedy without inventing a repair', async kind => {
    await preloadTranslations('en');
    const result = { type: 'error', code: 'spawn_failed', retryable: false, launchError: {
      kind: 'launch_error', code: 'agent_isolation_unavailable', message: 'Member setup unavailable',
      agentIsolationRefusal: { reason: 'member_setup_required', phase: 'native_execution_preparation',
        remedy: kind === 'open_machine_security' ? { kind, target: { serverId: 'saved-home', machineId: 'member/machine' } } : { kind } },
    } } satisfies SessionSpawnNewResultV1;
    const navigate = vi.fn();
    const alert = vi.fn();
    expect(presentSessionSpawnNewAgentIsolationFailure(result, navigate, alert)).toBe(true);
    const [, message, buttons] = alert.mock.calls[0]!;
    expect(message).toContain(t(kind === 'ask_machine_manager'
      ? 'errors.agentIsolationMemberSetupAskManager' : 'errors.agentIsolationMemberSetupOpenSecurity'));
    if (kind === 'ask_machine_manager') {
      expect(buttons).toBeUndefined();
      expect(navigate).not.toHaveBeenCalled();
    } else {
      buttons.find((button: { onPress?: () => void }) => button.onPress)?.onPress();
      expect(navigate).toHaveBeenCalledWith('/machines/member%2Fmachine?serverId=saved-home&tab=security');
    }
  });
});
