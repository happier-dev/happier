import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ACCOUNT_SETTING_DEFINITIONS,
  ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION,
  accountCatalogDefinition,
  accountSettingsParse,
  DEFAULT_SESSION_HANDOFF_DEFAULTS_V1,
  isExpoPushNotificationChannelEnabled,
  SessionHandoffDefaultsV1Schema,
} from './accountSettings.js';
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
  it('owns the current schema version for a blank Account Settings document', () => {
    expect(ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION).toBe(7);
    expect(accountSettingsParse({}).schemaVersion).toBe(ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION);
  });

  it('projects the UI feature-toggle default through the canonical Protocol snapshot', () => {
    expect(accountSettingsParse({}).featureToggles).toEqual({});
  });

  it('keeps valid machine-bound recent paths when sibling rows are malformed', () => {
    const recentMachinePaths = [
      { machineId: 'machine-1', path: '/workspace/project' },
      { machineId: 'machine-2', path: '/workspace/secondary', ignoredByCurrentSchema: true },
      { machineId: '', path: '/workspace/missing-machine' },
      { machineId: 'machine-3', path: '' },
      { machineId: 'machine-4', path: 'x'.repeat(16 * 1024 + 1) },
      'legacy-path-without-machine',
    ];

    expect(accountSettingsParse({ recentMachinePaths }).recentMachinePaths).toEqual([
      { machineId: 'machine-1', path: '/workspace/project' },
      { machineId: 'machine-2', path: '/workspace/secondary' },
    ]);
    expect(accountSettingsParse({ recentMachinePaths: 'not-an-array' }).recentMachinePaths).toEqual([]);
  });

  it('drops retired Account roots while preserving a safe forward-compatible root', () => {
    const parsed = accountSettingsParse({
      expUsageReporting: true,
      experimentalFeatureToggles: { automations: true },
      sessionMruOrderV1: ['server-a:session-a'],
      multiServerProfiles: [{ id: 'old-group' }],
      activeServerTargetKind: 'group',
      transcriptMessageTimestampsEnabled: true,
      futureAccountSetting: { preserve: true },
    }) as Record<string, unknown>;

    expect(parsed).not.toHaveProperty('expUsageReporting');
    expect(parsed).not.toHaveProperty('experimentalFeatureToggles');
    expect(parsed).not.toHaveProperty('sessionMruOrderV1');
    expect(parsed).not.toHaveProperty('multiServerProfiles');
    expect(parsed).not.toHaveProperty('activeServerTargetKind');
    expect(parsed).not.toHaveProperty('transcriptMessageTimestampsEnabled');
    expect(parsed.futureAccountSetting).toEqual({ preserve: true });
  });

  it('retains valid keyboard and SavedSecret rows when sibling rows are malformed', () => {
    const parsed = accountSettingsParse({
      keyboardShortcutDisabledCommandIdsV1: ['commandPalette.open', '', 123],
      keyboardShortcutOverridesV1: {
        'commandPalette.open': [
          { binding: 'Mod+K', conflictScope: 'global', nativeConsumable: false },
        ],
        'bad.command': [{ binding: '' }, { nope: true }],
      },
      secrets: [
        {
          id: 'secret-1',
          name: 'My Secret',
          kind: 'apiKey',
          encryptedValue: { _isSecretValue: true, value: 'abc' },
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: '',
          name: '',
          kind: 'apiKey',
          encryptedValue: { _isSecretValue: true, value: 'def' },
          createdAt: 2,
          updatedAt: 2,
        },
      ],
    });

    expect(parsed.keyboardShortcutDisabledCommandIdsV1).toEqual(['commandPalette.open']);
    expect(parsed.keyboardShortcutOverridesV1).toEqual({
      'commandPalette.open': [{ binding: 'Mod+K', conflictScope: 'global', nativeConsumable: false }],
    });
    expect(parsed.secrets).toEqual([
      expect.objectContaining({ id: 'secret-1', name: 'My Secret' }),
    ]);
  });

  it('returns a parsed catalog default without reparsing transformed output', () => {
    const definition = accountCatalogDefinition(
      z.number().transform((value) => value + 1),
      1,
      {
        semanticDomain: 'test default semantics',
        classification: 'preference',
        maximumSerializedValueBytes: 1024,
      },
    );

    expect(definition.default).toBe(2);
    expect(definition.schema.parse(undefined)).toBe(2);
    expect(definition.schema.parse('invalid')).toBe(2);
  });

  it('defaults sparse new-session wizard presentation overrides and retains only supported values', () => {
    expect(ACCOUNT_SETTING_DEFINITIONS.newSessionWizardSectionPresentationV1.default).toEqual({});
    expect(accountSettingsParse({
      newSessionWizardSectionPresentationV1: {
        models: 'dropdown',
        machines: 'list',
        unknown: 'dropdown',
        paths: 'grid',
      },
    }).newSessionWizardSectionPresentationV1).toEqual({
      models: 'dropdown',
      machines: 'list',
    });
  });

  it('owns the account-synced ordinary New Session draft entry preference', () => {
    expect(ACCOUNT_SETTING_DEFINITIONS.newSessionDraftEntryMode.default).toBe('resumePrevious');
    expect(accountSettingsParse({}).newSessionDraftEntryMode).toBe('resumePrevious');
    expect(accountSettingsParse({ newSessionDraftEntryMode: 'alwaysFresh' }).newSessionDraftEntryMode)
      .toBe('alwaysFresh');
    expect(accountSettingsParse({ newSessionDraftEntryMode: 'recentDraft' }).newSessionDraftEntryMode)
      .toBe('resumePrevious');
  });

  it('accepts bounded relative session-handoff glob defaults and rejects private path or credential material', () => {
    const relativeGlobs = Array.from({ length: 64 }, (_, index) => `ignored/${index}/**/*`);
    const valid = SessionHandoffDefaultsV1Schema.safeParse({
      ignoredIncludeGlobs: relativeGlobs,
      directTargetMode: 'convert_to_persisted',
    });
    expect(valid.success).toBe(true);

    const invalidPath = accountSettingsParse({
      sessionHandoffDefaultsV1: {
        ignoredIncludeGlobs: ['/private/worktree/**/*'],
      },
    });
    expect(invalidPath.sessionHandoffDefaultsV1.ignoredIncludeGlobs).toEqual([]);

    const invalidSecret = accountSettingsParse({
      sessionHandoffDefaultsV1: {
        ignoredIncludeGlobs: ['safe/**/*'],
        sourcePayload: { bearerToken: 'do-not-persist' },
      },
    });
    expect(invalidSecret.sessionHandoffDefaultsV1.ignoredIncludeGlobs).toEqual([]);
  });

  it('ratifies the session-handoff glob count, per-item, and aggregate ceilings independently', () => {
    // Each vector below violates exactly one ceiling and satisfies the other two,
    // so a ceiling that stopped being enforced cannot hide behind a sibling.
    const glob = (bytes: number) => `ignored/${'x'.repeat(bytes - 'ignored/'.length)}`;
    const parseGlobs = (ignoredIncludeGlobs: readonly string[]) =>
      SessionHandoffDefaultsV1Schema.safeParse({ ignoredIncludeGlobs }).success;

    const overCount = Array.from({ length: 65 }, (_, index) => `ignored/${index}`);
    expect(overCount.every((entry) => entry.length <= 512)).toBe(true);
    expect(overCount.reduce((total, entry) => total + entry.length, 0)).toBeLessThanOrEqual(16 * 1024);
    expect(parseGlobs(overCount)).toBe(false);
    expect(parseGlobs(overCount.slice(0, 64))).toBe(true);

    expect(glob(513).length).toBe(513);
    expect(parseGlobs([glob(513)])).toBe(false);
    expect(parseGlobs([glob(512)])).toBe(true);

    // 40 x 500 bytes exceeds the 16 KiB aggregate while staying inside both the
    // 64-entry count and the 512-byte per-entry ceilings.
    const overAggregate = Array.from({ length: 40 }, (_, index) => `${glob(494)}/${String(index).padStart(3, '0')}`);
    expect(overAggregate.length).toBeLessThanOrEqual(64);
    expect(Math.max(...overAggregate.map((entry) => entry.length))).toBeLessThanOrEqual(512);
    expect(overAggregate.reduce((total, entry) => total + entry.length, 0)).toBeGreaterThan(16 * 1024);
    expect(parseGlobs(overAggregate)).toBe(false);
    expect(parseGlobs(overAggregate.slice(0, 32))).toBe(true);

    // Every rejection recovers the whole root to its canonical default through
    // the catalog rather than persisting a partially trimmed list.
    for (const ignoredIncludeGlobs of [overCount, [glob(513)], overAggregate]) {
      expect(accountSettingsParse({
        sessionHandoffDefaultsV1: { ignoredIncludeGlobs, directTargetMode: 'convert_to_persisted' },
      }).sessionHandoffDefaultsV1).toEqual(DEFAULT_SESSION_HANDOFF_DEFAULTS_V1);
    }
  });

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
      'backend:claude': true,
      'backend:team-review:configured:team-review': false,
    });
    expect(parsed.backendCliSourcePreferenceByTargetKey).toEqual({
      'backend:claude': 'system-first',
      'backend:team-review:configured:team-review': 'managed-first',
    });
  });

  it('treats malformed current target-keyed backend maps atomically', () => {
    const parsed = accountSettingsParse({
      backendEnabledByTargetKey: {
        'backend:codex': true,
        '': false,
        'backend:claude': 'true',
      },
      backendCliSourcePreferenceByTargetKey: {
        'backend:codex': 'managed-first',
        '': 'system-first',
        'backend:claude': 'invalid',
      },
    });

    expect(parsed.backendEnabledByTargetKey).toEqual({});
    expect(parsed.backendCliSourcePreferenceByTargetKey).toEqual({});
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
      'backend:claude': false,
      'backend:codex': true,
    });
    expect(parsed.backendCliSourcePreferenceByTargetKey).toEqual({
      'backend:claude': 'managed-first',
      'backend:codex': 'system-first',
    });
  });

  it('filters malformed legacy backend map entries before rekeying valid siblings', () => {
    const parsed = accountSettingsParse({
      backendEnabledById: {
        codex: true,
        claude: false,
        malformedValue: 'true',
        '': true,
      },
      backendCliSourcePreferenceById: {
        codex: 'managed-first',
        gemini: 'system-first',
        malformedValue: 'invalid',
        '': 'managed-first',
      },
    });

    expect(parsed.backendEnabledByTargetKey).toEqual({
      'backend:codex': true,
      'backend:claude': false,
    });
    expect(parsed.backendCliSourcePreferenceByTargetKey).toEqual({
      'backend:codex': 'managed-first',
      'backend:gemini': 'system-first',
    });
  });

  it('prefers target-keyed backend settings when both schemas are present', () => {
    const parsed = accountSettingsParse({
      backendEnabledById: {
        claude: false,
        codex: 'true',
      },
      backendEnabledByTargetKey: {
        'agent:claude': true,
      },
      backendCliSourcePreferenceById: {
        claude: 'managed-first',
        codex: 'invalid',
      },
      backendCliSourcePreferenceByTargetKey: {
        'agent:claude': 'system-first',
      },
      futureField: {
        keep: true,
      },
    });

    expect(parsed.backendEnabledByTargetKey).toEqual({
      'backend:claude': true,
    });
    expect(parsed.backendCliSourcePreferenceByTargetKey).toEqual({
      'backend:claude': 'system-first',
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

  it('preserves ordinary forward keys but rejects prototype-pollution keys at the Protocol boundary', () => {
    const parsed = accountSettingsParse(JSON.parse(`{
      "futureAccountField": { "keep": true },
      "constructor": { "polluted": true },
      "prototype": { "polluted": true },
      "__proto__": { "polluted": true }
    }`));

    expect(parsed.futureAccountField).toEqual({ keep: true });
    expect(Object.prototype.hasOwnProperty.call(parsed, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(parsed, 'prototype')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
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

  it('fills sparse prompt-library Account roots through their shared Protocol schemas', () => {
    const parsed = accountSettingsParse({
      promptStacksV1: {},
      promptFoldersV1: { v: 1 },
      promptInvocationsV1: {},
      promptExternalLinksV1: { v: 1 },
      promptRegistrySourcesV1: {},
      contextSelectionsV1: {},
    });

    expect(parsed.promptStacksV1).toEqual({
      v: 1,
      surfaces: { coding: [], voice: [], profilesById: {} },
    });
    expect(parsed.promptFoldersV1).toEqual({ v: 1, folders: [] });
    expect(parsed.promptInvocationsV1).toEqual({ v: 1, entries: [] });
    expect(parsed.promptExternalLinksV1).toEqual({ v: 1, links: [] });
    expect(parsed.promptRegistrySourcesV1).toEqual({ v: 1, sources: [] });
    expect(parsed.contextSelectionsV1).toEqual({ v: 1, selectionsByKey: {} });
  });

  it('recovers malformed prompt-library Account roots at the canonical catalog boundary', () => {
    const parsed = accountSettingsParse({
      promptStacksV1: { v: 2, surfaces: { coding: [], voice: [], profilesById: {} } },
      promptFoldersV1: { v: 2, folders: [] },
      promptInvocationsV1: { v: 2, entries: [] },
      promptExternalLinksV1: { v: 2, links: [] },
      promptRegistrySourcesV1: { v: 2, sources: [] },
      contextSelectionsV1: { v: 2, selectionsByKey: {} },
    });

    expect(parsed.promptStacksV1).toEqual({
      v: 1,
      surfaces: { coding: [], voice: [], profilesById: {} },
    });
    expect(parsed.promptFoldersV1).toEqual({ v: 1, folders: [] });
    expect(parsed.promptInvocationsV1).toEqual({ v: 1, entries: [] });
    expect(parsed.promptExternalLinksV1).toEqual({ v: 1, links: [] });
    expect(parsed.promptRegistrySourcesV1).toEqual({ v: 1, sources: [] });
    expect(parsed.contextSelectionsV1).toEqual({ v: 1, selectionsByKey: {} });
  });

  it('preserves valid prompt-library Account content while applying owned defaults', () => {
    const parsed = accountSettingsParse({
      promptStacksV1: {
        surfaces: {
          coding: [{ id: 'stack-1', ref: { kind: 'doc', artifactId: 'artifact-1' } }],
        },
      },
      promptFoldersV1: {
        v: 1,
        folders: [{ id: 'folder-1', name: 'Workspace' }],
      },
      promptInvocationsV1: {
        entries: [{
          id: 'invocation-1',
          token: '/review',
          title: 'Review',
          target: { kind: 'doc', artifactId: 'artifact-1' },
        }],
      },
      promptExternalLinksV1: {
        v: 1,
        links: [{
          id: 'link-1',
          artifactId: 'artifact-1',
          assetTypeId: 'claude.command',
          scope: 'project',
          machineId: 'machine-1',
          externalRef: { relativePath: 'review.md' },
        }],
      },
      promptRegistrySourcesV1: {
        sources: [{
          id: 'source-1',
          adapterId: 'git',
          title: 'Repository',
        }],
      },
      contextSelectionsV1: {
        selectionsByKey: {
          'new-session': { machineId: 'machine-1', workspacePath: '/workspace/project' },
        },
      },
    });

    expect(parsed.promptStacksV1).toEqual({
      v: 1,
      surfaces: {
        coding: [{
          id: 'stack-1',
          ref: { kind: 'doc', artifactId: 'artifact-1' },
          enabled: true,
          placement: 'system_append',
          editPolicy: 'user_only',
        }],
        voice: [],
        profilesById: {},
      },
    });
    expect(parsed.promptFoldersV1).toEqual({
      v: 1,
      folders: [{ id: 'folder-1', name: 'Workspace' }],
    });
    expect(parsed.promptInvocationsV1).toEqual({
      v: 1,
      entries: [{
        id: 'invocation-1',
        token: '/review',
        title: 'Review',
        target: { kind: 'doc', artifactId: 'artifact-1' },
        behavior: 'insert',
        allowArgs: false,
        availableIn: 'global',
      }],
    });
    expect(parsed.promptExternalLinksV1).toEqual({
      v: 1,
      links: [{
        id: 'link-1',
        artifactId: 'artifact-1',
        assetTypeId: 'claude.command',
        scope: 'project',
        machineId: 'machine-1',
        externalRef: { relativePath: 'review.md' },
      }],
    });
    expect(parsed.promptRegistrySourcesV1).toEqual({
      v: 1,
      sources: [{
        id: 'source-1',
        adapterId: 'git',
        title: 'Repository',
        enabled: true,
        config: {},
      }],
    });
    expect(parsed.contextSelectionsV1).toEqual({
      v: 1,
      selectionsByKey: {
        'new-session': { machineId: 'machine-1', workspacePath: '/workspace/project' },
      },
    });
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
