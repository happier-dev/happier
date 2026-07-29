import { describe, expect, it } from 'vitest';

import { accountSettingsParse, isExpoPushNotificationChannelEnabled } from './accountSettings.js';
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

  it('no longer materializes a sessionProviderUsageSettingsV1 default (dead duplicate of the flat gauge keys)', () => {
    const parsed = accountSettingsParse({});

    expect((parsed as Record<string, unknown>).sessionProviderUsageSettingsV1).toBeUndefined();
  });

  it('defaults pending queue draining to one message per wake', () => {
    const parsed = accountSettingsParse({});

    expect(parsed.sessionPendingQueueDrainMode).toBe('one_at_a_time');
  });

  it('accepts drain-all pending queue mode and falls back to one-at-a-time for malformed values', () => {
    expect(accountSettingsParse({ sessionPendingQueueDrainMode: 'drain_all' }).sessionPendingQueueDrainMode).toBe('drain_all');
    expect(accountSettingsParse({ sessionPendingQueueDrainMode: 'everything' }).sessionPendingQueueDrainMode).toBe('one_at_a_time');
  });

  it('defaults pending queue delivery timing to foreground-ready and falls back for malformed values', () => {
    expect(accountSettingsParse({}).sessionPendingQueueDeliveryTiming).toBe('after_foreground_ready');
    expect(accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_runtime_idle' }).sessionPendingQueueDeliveryTiming)
      .toBe('after_runtime_idle');
    expect(accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_everything' }).sessionPendingQueueDeliveryTiming)
      .toBe('after_foreground_ready');
  });

  it('preserves a stored legacy sessionProviderUsageSettingsV1 blob as an inert unknown key', () => {
    // Migration safety: AccountSettingsSchema is passthrough, so stored blobs that still carry the
    // removed nested key parse fine — the key is preserved but has no application reader.
    const parsed = accountSettingsParse({
      sessionProviderUsageSettingsV1: {
        v: 1,
        gaugeMode: 'hidden',
        gaugeWindowMode: 'weekly',
      },
    });

    expect((parsed as Record<string, unknown>).sessionProviderUsageSettingsV1).toEqual({
      v: 1,
      gaugeMode: 'hidden',
      gaugeWindowMode: 'weekly',
    });
  });

  it('defaults connected-service provider state sharing to shared configuration and shared session state', () => {
    const parsed = accountSettingsParse({});

    expect(parsed.connectedServicesProviderStateSharingSettingsV1).toEqual({
      v: 1,
      defaults: {
        configMode: 'linked',
        stateMode: 'shared',
      },
      byAgentId: {},
      acknowledgedRisksByAgentId: {},
    });
  });

  it('resolves shared session state by default while per-agent overrides can opt out', () => {
    const parsed = accountSettingsParse({});
    expect(resolveConnectedServicesProviderStateSharingPolicyV1(
      parsed.connectedServicesProviderStateSharingSettingsV1,
      'codex',
    )).toEqual({
      configMode: 'linked',
      stateMode: 'shared',
    });

    const overridden = accountSettingsParse({
      connectedServicesProviderStateSharingSettingsV1: {
        v: 1,
        byAgentId: {
          codex: {
            stateMode: 'isolated',
          },
        },
      },
    });
    expect(resolveConnectedServicesProviderStateSharingPolicyV1(
      overridden.connectedServicesProviderStateSharingSettingsV1,
      'codex',
    )).toEqual({
      configMode: 'linked',
      stateMode: 'isolated',
    });
    // Other agents keep the shared default.
    expect(resolveConnectedServicesProviderStateSharingPolicyV1(
      overridden.connectedServicesProviderStateSharingSettingsV1,
      'pi',
    )).toEqual({
      configMode: 'linked',
      stateMode: 'shared',
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
        stateMode: 'shared',
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

  it('allows agent coordination by default while keeping destructive actions opt-in', () => {
    const parsed = accountSettingsParse({});
    const settings = parsed.actionsSettingsV1;

    // External/CLI control plane remains enabled by default.
    expectActionSurfaceEnabled('session.stop', settings, 'mcp', true);
    expectActionSurfaceEnabled('session.stop', settings, 'cli', true);

    // Destructive actions remain opt-in.
    expectActionSurfaceEnabled('session.stop', settings, 'agent', false);
    expectActionSurfaceEnabled('session.archive', settings, 'agent', false);
    expectActionSurfaceEnabled('session.unarchive', settings, 'agent', false);
    expectActionSurfaceEnabled('session.usageLimit.consumeResetCredit', settings, 'agent', false);
    expectActionSurfaceEnabled('session.permission.respond', settings, 'agent', false);
    expectActionSurfaceEnabled('session.user_action.answer', settings, 'agent', false);

    // Coordination and non-destructive runtime controls are Allowed by default.
    // Title changes are safe and are required for provider UX (auto-title on first message).
    expectActionSurfaceEnabled('session.title.set', settings, 'agent', true);
    expectActionSurfaceEnabled('session.message.send', settings, 'agent', true);
    expectActionSurfaceEnabled('session.list', settings, 'agent', true);
    expectActionSurfaceEnabled('session.status.get', settings, 'agent', true);
    expectActionSurfaceEnabled('session.history.get', settings, 'agent', true);
    expectActionSurfaceEnabled('session.wait.idle', settings, 'agent', true);
    expectActionSurfaceEnabled('session.permission_mode.set', settings, 'agent', true);
    expectActionSurfaceEnabled('session.model.set', settings, 'agent', true);
    expectActionSurfaceEnabled('session.mode.set', settings, 'agent', true);
    expectActionSurfaceEnabled('session.usageLimit.waitResume.enable', settings, 'agent', true);
    expectActionSurfaceEnabled('session.usageLimit.waitResume.cancel', settings, 'agent', true);
    expectActionSurfaceEnabled('session.usageLimit.checkNow', settings, 'agent', true);
  });

  it('defaults agent spawn policy to open override controls', () => {
    const parsed = accountSettingsParse({});

    expect(parsed.sessionAgentSpawnPolicyV1).toEqual({
      v: 1,
      allowCustomDirectory: true,
      allowCrossMachine: true,
      allowBackendTargetOverride: true,
      allowModelOverride: true,
      allowPermissionModeOverride: true,
      allowAgentModeOverride: true,
      allowConfigOptionOverrides: true,
      allowProfileOverride: true,
      allowEnvironmentVariables: true,
      allowConnectedServicesOverride: true,
      allowMcpSelectionOverride: true,
      allowTranscriptStorageOverride: true,
      permissionCeiling: null,
    });
  });

  it('sanitizes invalid agent spawn policy values back to safe defaults', () => {
    const parsed = accountSettingsParse({
      sessionAgentSpawnPolicyV1: {
        v: 1,
        allowCustomDirectory: false,
        allowEnvironmentVariables: false,
        permissionCeiling: 'not-a-real-mode',
      },
    });

    expect(parsed.sessionAgentSpawnPolicyV1).toMatchObject({
      v: 1,
      allowCustomDirectory: false,
      allowEnvironmentVariables: false,
      permissionCeiling: null,
    });
  });

  it('migrates legacy default agent action settings to the current agent default matrix', () => {
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
          legacyDefaultDisabled.map((id) => [id, { disabledSurfaces: ['agent'] }]),
        ),
      },
    });
    const settings = parsed.actionsSettingsV1;

    expectActionSurfaceEnabled('session.stop', settings, 'agent', false);
    expectActionSurfaceEnabled('session.title.set', settings, 'agent', true);
    expectActionSurfaceEnabled('session.message.send', settings, 'agent', true);
    expectActionSurfaceEnabled('session.list', settings, 'agent', true);
    expectActionSurfaceEnabled('session.permission_mode.set', settings, 'agent', true);
    expectActionSurfaceEnabled('session.usageLimit.consumeResetCredit', settings, 'agent', false);
  });

  it('migrates legacy agent locks while preserving unrelated action settings fields', () => {
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
          ...legacyDefaultDisabled.map((id) => [id, { disabledSurfaces: ['agent'] }]),
          ['session.message.send', { disabledSurfaces: ['agent'], approvalRequiredSurfaces: ['cli'] }],
        ]),
      },
    });

    expectActionSurfaceEnabled('session.title.set', parsed.actionsSettingsV1, 'agent', true);
    expectActionSurfaceEnabled('session.message.send', parsed.actionsSettingsV1, 'agent', true);
    expect(parsed.actionsSettingsV1.actions['session.message.send']?.approvalRequiredSurfaces).toEqual(['cli']);
  });

  it('migrates partial legacy agent locks for actions that are now default-open', () => {
    const parsed = accountSettingsParse({
      actionsSettingsV1: {
        v: 1,
        actions: {
          'session.permission_mode.set': { disabledSurfaces: ['agent'] },
          'session.message.send': { disabledSurfaces: ['agent'], approvalRequiredSurfaces: ['cli'] },
          'session.stop': { disabledSurfaces: ['agent'] },
        },
      },
    });

    expectActionSurfaceEnabled('session.permission_mode.set', parsed.actionsSettingsV1, 'agent', true);
    expectActionSurfaceEnabled('session.message.send', parsed.actionsSettingsV1, 'agent', true);
    expect(parsed.actionsSettingsV1.actions['session.message.send']?.approvalRequiredSurfaces).toEqual(['cli']);
    expectActionSurfaceEnabled('session.stop', parsed.actionsSettingsV1, 'agent', false);
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

describe('isExpoPushNotificationChannelEnabled', () => {
  it('treats an account with no notification settings as push-enabled', () => {
    expect(isExpoPushNotificationChannelEnabled({})).toBe(true);
  });

  it('honors the legacy pushEnabled flag through the attention delivery policy', () => {
    expect(isExpoPushNotificationChannelEnabled({
      notificationsSettingsV1: { v: 1, pushEnabled: false },
    })).toBe(false);
  });

  it('reads the explicit attention delivery policy when one is configured', () => {
    expect(isExpoPushNotificationChannelEnabled({
      notificationsSettingsV1: { v: 1, pushEnabled: true },
      attentionDeliveryPolicyV1: { v: 1, channels: { expo_push: { enabled: false } } },
    })).toBe(false);
  });

  it('lets an explicit attention delivery policy re-enable push over a legacy opt-out', () => {
    expect(isExpoPushNotificationChannelEnabled({
      notificationsSettingsV1: { v: 1, pushEnabled: false },
      attentionDeliveryPolicyV1: { v: 1, channels: { expo_push: { enabled: true } } },
    })).toBe(true);
  });

  it('does not treat a local notification channel as Expo push enablement', () => {
    expect(isExpoPushNotificationChannelEnabled({
      attentionDeliveryPolicyV1: {
        v: 1,
        channels: { expo_push: { enabled: false }, local_notification: { enabled: true } },
      },
    })).toBe(false);
  });
});
