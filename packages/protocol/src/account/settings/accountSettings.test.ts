import { describe, expect, it } from 'vitest';

import { accountSettingsParse } from './accountSettings.js';
import { isActionEnabledByActionsSettings } from '../../actions/actionSettings.js';

describe('accountSettings', () => {
  it('defaults ready notification preview settings to enabled', () => {
    const parsed = accountSettingsParse({});

    expect(parsed.notificationsSettingsV1.readyIncludeMessageText).toBe(true);
  });

  it('accepts explicit ready notification preview settings', () => {
    const parsed = accountSettingsParse({
      notificationsSettingsV1: {
        v: 1,
        pushEnabled: true,
        ready: true,
        readyIncludeMessageText: false,
        permissionRequest: true,
        userActionRequest: true,
        foregroundBehavior: 'full',
      },
    });

    expect(parsed.notificationsSettingsV1.readyIncludeMessageText).toBe(false);
  });

  it('defaults target-keyed backend settings maps', () => {
    const parsed = accountSettingsParse({});

    expect(parsed.backendEnabledByTargetKey).toEqual({});
    expect(parsed.backendCliSourcePreferenceByTargetKey).toEqual({});
  });

  it('accepts target-keyed backend settings', () => {
    const parsed = accountSettingsParse({
      backendEnabledByTargetKey: {
        'agent:claude': true,
        'acpBackend:team-review': false,
      },
      backendCliSourcePreferenceByTargetKey: {
        'agent:claude': 'system-first',
        'acpBackend:team-review': 'managed-first',
      },
    });

    expect(parsed.backendEnabledByTargetKey).toEqual({
      'agent:claude': true,
      'acpBackend:team-review': false,
    });
    expect(parsed.backendCliSourcePreferenceByTargetKey).toEqual({
      'agent:claude': 'system-first',
      'acpBackend:team-review': 'managed-first',
    });
  });

  it('backfills target-keyed backend settings from legacy id-keyed fields', () => {
    const parsed = accountSettingsParse({
      backendEnabledById: {
        claude: false,
        codex: true,
      },
      backendCliSourcePreferenceById: {
        claude: 'managed-first',
        codex: 'system-first',
      },
    });

    expect(parsed.backendEnabledByTargetKey).toEqual({
      'agent:claude': false,
      'agent:codex': true,
    });
    expect(parsed.backendCliSourcePreferenceByTargetKey).toEqual({
      'agent:claude': 'managed-first',
      'agent:codex': 'system-first',
    });
  });

  it('prefers target-keyed backend settings when both schemas are present', () => {
    const parsed = accountSettingsParse({
      backendEnabledById: {
        claude: false,
      },
      backendEnabledByTargetKey: {
        'agent:claude': true,
      },
      backendCliSourcePreferenceById: {
        claude: 'managed-first',
      },
      backendCliSourcePreferenceByTargetKey: {
        'agent:claude': 'system-first',
      },
      futureField: {
        keep: true,
      },
    });

    expect(parsed.backendEnabledByTargetKey).toEqual({
      'agent:claude': true,
    });
    expect(parsed.backendCliSourcePreferenceByTargetKey).toEqual({
      'agent:claude': 'system-first',
    });
    expect(parsed.futureField).toEqual({ keep: true });
  });

  it('disables cross-session session-agent controls by default (opt-in)', () => {
    const parsed = accountSettingsParse({});
    const settings = parsed.actionsSettingsV1;

    // External/CLI control plane remains enabled by default.
    expect(isActionEnabledByActionsSettings('session.stop' as any, settings, { surface: 'mcp' } as any)).toBe(true);
    expect(isActionEnabledByActionsSettings('session.stop' as any, settings, { surface: 'cli' } as any)).toBe(true);

    // Session agents controlling other sessions is opt-in and must be fail-closed by default.
    expect(isActionEnabledByActionsSettings('session.stop' as any, settings, { surface: 'session_agent' } as any)).toBe(false);
    // Title changes are safe and are required for provider UX (auto-title on first message).
    expect(isActionEnabledByActionsSettings('session.title.set' as any, settings, { surface: 'session_agent' } as any)).toBe(true);
    expect(isActionEnabledByActionsSettings('session.message.send' as any, settings, { surface: 'session_agent' } as any)).toBe(false);
    expect(isActionEnabledByActionsSettings('session.list' as any, settings, { surface: 'session_agent' } as any)).toBe(false);
  });

  it('migrates legacy default session-agent action settings to keep session.title.set enabled', () => {
    const legacyDefaultDisabled = [
      'session.stop',
      'session.title.set',
      'session.permission_mode.set',
      'session.model.set',
      'session.archive',
      'session.unarchive',
      'session.status.get',
      'session.history.get',
      'session.wait.idle',
      'session.message.send',
      'session.permission.respond',
      'session.user_action.answer',
      'session.mode.set',
      'session.list',
      'session.activity.get',
      'session.messages.recent.get',
    ] as const;

    const parsed = accountSettingsParse({
      actionsSettingsV1: {
        v: 1,
        actions: Object.fromEntries(
          legacyDefaultDisabled.map((id) => [id, { disabledSurfaces: ['session_agent'] }]),
        ),
      },
    });
    const settings = parsed.actionsSettingsV1;

    expect(isActionEnabledByActionsSettings('session.stop' as any, settings, { surface: 'session_agent' } as any)).toBe(false);
    expect(isActionEnabledByActionsSettings('session.title.set' as any, settings, { surface: 'session_agent' } as any)).toBe(true);
  });

  it('keeps session.title.set enabled even when legacy actions settings also contain approval requirements', () => {
    const legacyDefaultDisabled = [
      'session.stop',
      'session.title.set',
      'session.permission_mode.set',
      'session.model.set',
      'session.archive',
      'session.unarchive',
      'session.status.get',
      'session.history.get',
      'session.wait.idle',
      'session.message.send',
      'session.permission.respond',
      'session.user_action.answer',
      'session.mode.set',
      'session.list',
      'session.activity.get',
      'session.messages.recent.get',
    ] as const;

    const parsed = accountSettingsParse({
      actionsSettingsV1: {
        v: 1,
        actions: Object.fromEntries([
          ...legacyDefaultDisabled.map((id) => [id, { disabledSurfaces: ['session_agent'] }]),
          ['session.message.send', { disabledSurfaces: ['session_agent'], approvalRequiredSurfaces: ['cli'] }],
        ]),
      },
    });

    expect(isActionEnabledByActionsSettings('session.title.set' as any, parsed.actionsSettingsV1, { surface: 'session_agent' } as any)).toBe(true);
    expect(isActionEnabledByActionsSettings('session.message.send' as any, parsed.actionsSettingsV1, { surface: 'session_agent' } as any)).toBe(false);
  });
});
