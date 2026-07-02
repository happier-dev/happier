import { describe, expect, it } from 'vitest';

import { accountSettingsParse } from './accountSettings.js';
import { resolveConnectedServicesProviderStateSharingPolicyV1 } from './connectedServicesSettings.js';
import {
  isActionEnabledByActionsSettings,
  type ActionEnablementContext,
  type ActionsSettingsV1,
} from '../../actions/actionSettings.js';
import type { ActionId } from '../../actions/actionIds.js';

type ActionSurface = NonNullable<ActionEnablementContext['surface']>;

function expectActionSurfaceEnabled(
  actionId: ActionId,
  settings: ActionsSettingsV1,
  surface: ActionSurface,
  expected: boolean,
) {
  expect(isActionEnabledByActionsSettings(actionId, settings, { surface })).toBe(expected);
}

describe('accountSettings', () => {
  it('defaults usage limit recovery to asking before auto-waiting', () => {
    const parsed = accountSettingsParse({});

    expect(parsed.usageLimitRecoverySettingsV1).toEqual({
      v: 1,
      mode: 'ask',
      promptMode: 'standard',
      resumePromptMode: 'standard',
    });
  });

  it('accepts remembered usage limit auto-wait settings', () => {
    const parsed = accountSettingsParse({
      usageLimitRecoverySettingsV1: {
        v: 1,
        mode: 'auto_wait',
      },
    });

    expect(parsed.usageLimitRecoverySettingsV1).toEqual({
      v: 1,
      mode: 'auto_wait',
      promptMode: 'standard',
      resumePromptMode: 'standard',
    });
  });

  it('accepts disabled usage limit recovery resume prompts', () => {
    const parsed = accountSettingsParse({
      usageLimitRecoverySettingsV1: {
        v: 1,
        mode: 'auto_wait',
        promptMode: 'standard',
        resumePromptMode: 'off',
      },
    });

    expect(parsed.usageLimitRecoverySettingsV1).toEqual({
      v: 1,
      mode: 'auto_wait',
      promptMode: 'standard',
      resumePromptMode: 'off',
    });
  });

  it('accepts a custom resume prompt mode with trimmed custom text', () => {
    const parsed = accountSettingsParse({
      usageLimitRecoverySettingsV1: {
        v: 1,
        mode: 'auto_wait',
        resumePromptMode: 'custom',
        customResumePrompt: '  Pick up the task again.  ',
      },
    });

    expect(parsed.usageLimitRecoverySettingsV1).toEqual({
      v: 1,
      mode: 'auto_wait',
      promptMode: 'standard',
      resumePromptMode: 'custom',
      customResumePrompt: 'Pick up the task again.',
    });
  });

  it('falls back to asking for malformed usage limit recovery settings', () => {
    const parsed = accountSettingsParse({
      usageLimitRecoverySettingsV1: {
        v: 1,
        mode: 'always_switch',
      },
    });

    expect(parsed.usageLimitRecoverySettingsV1).toEqual({
      v: 1,
      mode: 'ask',
      promptMode: 'standard',
      resumePromptMode: 'standard',
    });
  });

  it('defaults session provider usage gauge settings to automatic most constrained display', () => {
    const parsed = accountSettingsParse({});

    expect(parsed.sessionProviderUsageSettingsV1).toEqual({
      v: 1,
      gaugeMode: 'auto',
      gaugeWindowMode: 'most_constrained',
    });
  });

  it('defaults pending queue draining to one message per wake', () => {
    const parsed = accountSettingsParse({});

    expect(parsed.sessionPendingQueueDrainMode).toBe('one_at_a_time');
  });

  it('accepts drain-all pending queue mode and falls back to one-at-a-time for malformed values', () => {
    expect(accountSettingsParse({ sessionPendingQueueDrainMode: 'drain_all' }).sessionPendingQueueDrainMode).toBe('drain_all');
    expect(accountSettingsParse({ sessionPendingQueueDrainMode: 'everything' }).sessionPendingQueueDrainMode).toBe('one_at_a_time');
  });

  it('accepts hidden session provider usage gauge settings', () => {
    const parsed = accountSettingsParse({
      sessionProviderUsageSettingsV1: {
        v: 1,
        gaugeMode: 'hidden',
        gaugeWindowMode: 'weekly',
      },
    });

    expect(parsed.sessionProviderUsageSettingsV1).toEqual({
      v: 1,
      gaugeMode: 'hidden',
      gaugeWindowMode: 'weekly',
    });
  });

  it('defaults connected-service provider state sharing to shared configuration with isolated session state', () => {
    const parsed = accountSettingsParse({});

    expect(parsed.connectedServicesProviderStateSharingSettingsV1).toEqual({
      v: 1,
      defaults: {
        configMode: 'linked',
        stateMode: 'isolated',
      },
      byAgentId: {},
      acknowledgedRisksByAgentId: {},
    });
  });

  it('accepts provider-specific connected-service state sharing overrides', () => {
    const parsed = accountSettingsParse({
      connectedServicesProviderStateSharingSettingsV1: {
        v: 1,
        defaults: {
          configMode: 'copied',
          stateMode: 'isolated',
        },
        byAgentId: {
          codex: {
            stateMode: 'shared',
          },
          pi: {
            configMode: 'isolated',
          },
        },
        acknowledgedRisksByAgentId: {
          codex: {
            sharedStatePrivacy: true,
          },
        },
      },
    });

    expect(parsed.connectedServicesProviderStateSharingSettingsV1).toEqual({
      v: 1,
      defaults: {
        configMode: 'copied',
        stateMode: 'isolated',
      },
      byAgentId: {
        codex: {
          stateMode: 'shared',
        },
        pi: {
          configMode: 'isolated',
        },
      },
      acknowledgedRisksByAgentId: {
        codex: {
          sharedStatePrivacy: true,
        },
      },
    });
  });

  it('resolves effective connected-service provider state sharing policy by agent id', () => {
    const settings = accountSettingsParse({
      connectedServicesProviderStateSharingSettingsV1: {
        v: 1,
        defaults: {
          configMode: 'copied',
          stateMode: 'isolated',
        },
        byAgentId: {
          codex: {
            stateMode: 'shared',
          },
          pi: {
            configMode: 'isolated',
          },
        },
      },
    });

    expect(resolveConnectedServicesProviderStateSharingPolicyV1(
      settings.connectedServicesProviderStateSharingSettingsV1,
      'codex',
    )).toEqual({
      configMode: 'copied',
      stateMode: 'shared',
    });
    expect(resolveConnectedServicesProviderStateSharingPolicyV1(
      settings.connectedServicesProviderStateSharingSettingsV1,
      'pi',
    )).toEqual({
      configMode: 'isolated',
      stateMode: 'isolated',
    });
    expect(resolveConnectedServicesProviderStateSharingPolicyV1(
      settings.connectedServicesProviderStateSharingSettingsV1,
      'gemini',
    )).toEqual({
      configMode: 'copied',
      stateMode: 'isolated',
    });
  });

  it('falls back to provider state sharing defaults when the setting is malformed', () => {
    const parsed = accountSettingsParse({
      connectedServicesProviderStateSharingSettingsV1: {
        v: 1,
        defaults: {
          configMode: 'hardlink',
          stateMode: 'shared',
        },
      },
    });

    expect(parsed.connectedServicesProviderStateSharingSettingsV1).toEqual({
      v: 1,
      defaults: {
        configMode: 'linked',
        stateMode: 'isolated',
      },
      byAgentId: {},
      acknowledgedRisksByAgentId: {},
    });
  });

  it('defaults connected-service default auth by agent to native', () => {
    const parsed = accountSettingsParse({});

    expect(parsed.connectedServicesDefaultAuthByAgentIdV1).toEqual({
      v: 1,
      bindingsByAgentId: {},
    });
  });

  it('accepts connected-service default auth bindings by agent', () => {
    const parsed = accountSettingsParse({
      connectedServicesDefaultAuthByAgentIdV1: {
        v: 1,
        bindingsByAgentId: {
          codex: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                groupId: 'codex-main',
              },
            },
          },
          claude: {
            v: 1,
            bindingsByServiceId: {
              anthropic: {
                source: 'connected',
                profileId: 'work',
              },
            },
          },
        },
      },
    });

    expect(parsed.connectedServicesDefaultAuthByAgentIdV1).toEqual({
      v: 1,
      bindingsByAgentId: {
        codex: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'codex-main',
            },
          },
        },
        claude: {
          v: 1,
          bindingsByServiceId: {
            anthropic: {
              source: 'connected',
              selection: 'profile',
              profileId: 'work',
            },
          },
        },
      },
    });
  });

  it('falls back to native defaults when connected-service default auth settings are malformed', () => {
    const parsed = accountSettingsParse({
      connectedServicesDefaultAuthByAgentIdV1: {
        v: 1,
        bindingsByAgentId: {
          codex: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'profile',
              },
            },
          },
        },
      },
    });

    expect(parsed.connectedServicesDefaultAuthByAgentIdV1).toEqual({
      v: 1,
      bindingsByAgentId: {},
    });
  });

  it('defaults connected-service quota recovered notifications from quota blocked notifications', () => {
    const parsed = accountSettingsParse({
      notificationsSettingsV1: {
        v: 1,
        connectedServiceQuotaBlocked: false,
      },
    });

    expect(parsed.notificationsSettingsV1.connectedServiceQuotaBlocked).toBe(false);
    expect(parsed.notificationsSettingsV1.connectedServiceQuotaRecovered).toBe(false);
  });

  it('defaults coding prompt behavior to current agent-managed behavior', () => {
    const parsed = accountSettingsParse({});

    expect(parsed.codingPromptBehaviorV1).toEqual({
      v: 1,
      sessionTitleUpdates: 'ongoing',
      responseOptions: 'agent',
    });
  });

  it('normalizes legacy agent-managed title updates to ongoing title updates', () => {
    const parsed = accountSettingsParse({
      codingPromptBehaviorV1: {
        v: 1,
        sessionTitleUpdates: 'agent',
        responseOptions: 'agent',
      },
    });

    expect(parsed.codingPromptBehaviorV1).toEqual({
      v: 1,
      sessionTitleUpdates: 'ongoing',
      responseOptions: 'agent',
    });
  });

  it('accepts initial-only coding prompt title updates', () => {
    const parsed = accountSettingsParse({
      codingPromptBehaviorV1: {
        v: 1,
        sessionTitleUpdates: 'initial',
        responseOptions: 'agent',
      },
    });

    expect(parsed.codingPromptBehaviorV1).toEqual({
      v: 1,
      sessionTitleUpdates: 'initial',
      responseOptions: 'agent',
    });
  });

  it('accepts disabled coding prompt behavior options', () => {
    const parsed = accountSettingsParse({
      codingPromptBehaviorV1: {
        v: 1,
        sessionTitleUpdates: 'disabled',
        responseOptions: 'disabled',
      },
    });

    expect(parsed.codingPromptBehaviorV1).toEqual({
      v: 1,
      sessionTitleUpdates: 'disabled',
      responseOptions: 'disabled',
    });
  });

  it('defaults peer mediation preferences to direct routes disabled by product posture', () => {
    const parsed = accountSettingsParse({});
    const parsedRecord = parsed as unknown as { peerMediationPreferencesV1?: unknown };

    expect(parsedRecord.peerMediationPreferencesV1).toEqual({
      v: 1,
      flows: {},
      byMachineId: {},
    });
  });

  it('accepts peer mediation per-machine direct-route preferences', () => {
    const parsed = accountSettingsParse({
      peerMediationPreferencesV1: {
        v: 1,
        flows: {
          bounded_transfer: { direct: 'disabled' },
        },
        byMachineId: {
          machine_1: {
            flows: {
              bounded_transfer: { direct: 'enabled' },
            },
          },
        },
      },
    });
    const parsedRecord = parsed as unknown as { peerMediationPreferencesV1?: unknown };

    expect(parsedRecord.peerMediationPreferencesV1).toEqual({
      v: 1,
      flows: {
        bounded_transfer: { direct: 'disabled' },
      },
      byMachineId: {
        machine_1: {
          flows: {
            bounded_transfer: { direct: 'enabled' },
          },
        },
      },
    });
  });

  it('falls back to safe peer mediation defaults for malformed preferences', () => {
    const parsed = accountSettingsParse({
      peerMediationPreferencesV1: {
        v: 1,
        flows: {
          bounded_transfer: { direct: 'enabled' },
          tcp_tunnel: { direct: 'surprise' },
        },
      },
    });
    const parsedRecord = parsed as unknown as { peerMediationPreferencesV1?: unknown };

    expect(parsedRecord.peerMediationPreferencesV1).toEqual({
      v: 1,
      flows: {},
      byMachineId: {},
    });
  });

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
    expectActionSurfaceEnabled('session.stop', settings, 'mcp', true);
    expectActionSurfaceEnabled('session.stop', settings, 'cli', true);

    // Session agents controlling other sessions is opt-in and must be fail-closed by default.
    expectActionSurfaceEnabled('session.stop', settings, 'session_agent', false);
    // Title changes are safe and are required for provider UX (auto-title on first message).
    expectActionSurfaceEnabled('session.title.set', settings, 'session_agent', true);
    expectActionSurfaceEnabled('session.message.send', settings, 'session_agent', false);
    expectActionSurfaceEnabled('session.list', settings, 'session_agent', false);
    expectActionSurfaceEnabled('session.usageLimit.waitResume.enable', settings, 'session_agent', false);
    expectActionSurfaceEnabled('session.usageLimit.waitResume.cancel', settings, 'session_agent', false);
    expectActionSurfaceEnabled('session.usageLimit.checkNow', settings, 'session_agent', false);
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

    expectActionSurfaceEnabled('session.stop', settings, 'session_agent', false);
    expectActionSurfaceEnabled('session.title.set', settings, 'session_agent', true);
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

    expectActionSurfaceEnabled('session.title.set', parsed.actionsSettingsV1, 'session_agent', true);
    expectActionSurfaceEnabled('session.message.send', parsed.actionsSettingsV1, 'session_agent', false);
  });

  it('adds the forward-compatible attention delivery policy while preserving unknown settings fields', () => {
    const parsed = accountSettingsParse({
      attentionDeliveryPolicyV1: {
        v: 1,
        futureNestedField: {
          keep: true,
        },
      },
      futureAccountField: {
        keep: true,
      },
    });

    expect(parsed.attentionDeliveryPolicyV1.v).toBe(1);
    expect(parsed.attentionDeliveryPolicyV1.futureNestedField).toEqual({ keep: true });
    expect(parsed.futureAccountField).toEqual({ keep: true });
  });

  it('defaults workspace references and preserves forward-compatible workspace fields', () => {
    const empty = accountSettingsParse({});
    expect(empty.workspaceRefsV1).toEqual([]);

    const parsed = accountSettingsParse({
      workspaceRefsV1: [
        {
          id: 'workspace_1',
          serverId: 'server_1',
          machineId: 'machine_1',
          rootPath: '/repo',
          label: null,
          createdAtMs: 1,
          lastOpenedAtMs: 2,
          futureWorkspaceField: { keep: true },
        },
      ],
      futureAccountField: true,
    });

    expect(parsed.workspaceRefsV1).toEqual([
      expect.objectContaining({
        id: 'workspace_1',
        serverId: 'server_1',
        machineId: 'machine_1',
        rootPath: '/repo',
        futureWorkspaceField: { keep: true },
      }),
    ]);
    expect(parsed.futureAccountField).toBe(true);
  });

  it('falls back to an empty workspace reference list for malformed refs', () => {
    const parsed = accountSettingsParse({
      workspaceRefsV1: [{ id: 'workspace_missing_scope' }],
    });

    expect(parsed.workspaceRefsV1).toEqual([]);
  });
});
