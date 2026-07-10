import {
  booleanAgentSetting,
  buildAgentSettingsDefaults,
  defineAgentSettingsContribution,
  enumArrayAgentSetting,
  enumAgentSetting,
  positiveIntegerAgentSetting,
  agentSettingsContributionToUiDescriptor,
} from '@happier-dev/plugin-sdk/experimental/manifest/agentSettings';

export const CLAUDE_SETTING_SOURCES_V2 = ['user', 'project', 'local'] as const;
export type ClaudeSettingSourceV2 = (typeof CLAUDE_SETTING_SOURCES_V2)[number];

export const CLAUDE_REMOTE_DEBUG_CATEGORIES = ['api', 'mcp', 'hooks', 'file', '1p'] as const;
export type ClaudeRemoteDebugCategory = (typeof CLAUDE_REMOTE_DEBUG_CATEGORIES)[number];

export const CLAUDE_UNIFIED_TERMINAL_HOSTS = ['auto', 'tmux', 'zellij'] as const;
export type ClaudeUnifiedTerminalHost = (typeof CLAUDE_UNIFIED_TERMINAL_HOSTS)[number];

export const CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES = [
  'ask_every_time',
  'resume_from_summary',
  'resume_full_session',
] as const;
export type ClaudeUnifiedTerminalResumeChoice = (typeof CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES)[number];

export const MAX_CLAUDE_REMOTE_ADVANCED_OPTIONS_JSON_CHARS = 16_384;

type TranslationRef = Readonly<{ key: string }>;

function translation(key: string): TranslationRef {
  return { key };
}

function fieldTranslationKey(fieldKey: string, suffix: 'title' | 'subtitle'): string {
  return `settingsAgents.plugins.claude.fields.${fieldKey}.${suffix}`;
}

function fieldUi(fieldKey: string, kind: 'boolean' | 'number' | 'json') {
  return {
    kind,
    title: translation(fieldTranslationKey(fieldKey, 'title')),
    subtitle: translation(fieldTranslationKey(fieldKey, 'subtitle')),
  } as const;
}

function option(baseKey: string, id: string) {
  return {
    id,
    title: translation(`${baseKey}.options.${id}.title`),
    subtitle: translation(`${baseKey}.options.${id}.subtitle`),
  } as const;
}

function enumFieldUi(fieldKey: string, values: readonly string[]) {
  const baseKey = `settingsAgents.plugins.claude.fields.${fieldKey}`;
  return {
    kind: 'enum' as const,
    title: translation(`${baseKey}.title`),
    subtitle: translation(`${baseKey}.subtitle`),
    enumOptions: values.map((id) => option(baseKey, id)),
  };
}

function multiEnumFieldUi(fieldKey: string, values: readonly string[]) {
  const baseKey = `settingsAgents.plugins.claude.fields.${fieldKey}`;
  return {
    kind: 'multiEnum' as const,
    title: translation(`${baseKey}.title`),
    subtitle: translation(`${baseKey}.subtitle`),
    enumOptions: values.map((id) => option(baseKey, id)),
  };
}

export const CLAUDE_AGENT_SETTINGS_CONTRIBUTION = defineAgentSettingsContribution({
  id: 'claude.agentSettings.v1',
  agentId: 'claude',
  fields: [
    booleanAgentSetting({
      id: 'claudeRemoteAgentSdkEnabled',
      default: true,
      description: 'Use Claude Agent SDK in remote mode',
      analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
      ui: fieldUi('claudeRemoteAgentSdkEnabled', 'boolean'),
    }),
    booleanAgentSetting({
      id: 'claudeUnifiedTerminalEnabled',
      default: false,
      description: 'Enable Claude unified terminal runtime',
      analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
      ui: fieldUi('claudeUnifiedTerminalEnabled', 'boolean'),
    }),
    enumAgentSetting({
      id: 'claudeUnifiedTerminalHost',
      values: CLAUDE_UNIFIED_TERMINAL_HOSTS,
      default: 'auto',
      description: 'Claude unified terminal host adapter preference',
      analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
      ui: enumFieldUi('claudeUnifiedTerminalHost', CLAUDE_UNIFIED_TERMINAL_HOSTS),
    }),
    enumAgentSetting({
      id: 'claudeUnifiedTerminalResumeChoice',
      values: CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES,
      default: 'ask_every_time',
      description: 'Default action for Claude heavy-session resume choice prompts',
      analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
      ui: enumFieldUi('claudeUnifiedTerminalResumeChoice', CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES),
    }),
    enumAgentSetting({
      id: 'claudeRemoteSettingSources',
      values: ['project', 'user_project', 'none'],
      default: 'user_project',
      description: 'Legacy Claude settings source mode',
      ui: enumFieldUi('claudeRemoteSettingSources', ['project', 'user_project', 'none']),
    }),
    enumArrayAgentSetting({
      id: 'claudeRemoteSettingSourcesV2',
      values: CLAUDE_SETTING_SOURCES_V2,
      default: ['user', 'project', 'local'],
      max: 3,
      description: 'Claude settings sources',
      analytics: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'enum',
        privacy: 'safe',
        identityScope: 'person',
        serializeCurrentRule: 'orderedEnumArrayJoin',
      },
      ui: multiEnumFieldUi('claudeRemoteSettingSourcesV2', CLAUDE_SETTING_SOURCES_V2),
    }),
    booleanAgentSetting({
      id: 'claudeLocalPermissionBridgeEnabled',
      default: true,
      description: 'Enable local Claude permission bridge',
      analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
      ui: fieldUi('claudeLocalPermissionBridgeEnabled', 'boolean'),
    }),
    booleanAgentSetting({
      id: 'claudeLocalPermissionBridgeWaitIndefinitely',
      default: true,
      description: 'Keep local permission requests open until the user responds',
      analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
      ui: fieldUi('claudeLocalPermissionBridgeWaitIndefinitely', 'boolean'),
    }),
    positiveIntegerAgentSetting({
      id: 'claudeLocalPermissionBridgeTimeoutSeconds',
      default: 600,
      description: 'Local permission bridge timeout in seconds',
      ui: {
        ...fieldUi('claudeLocalPermissionBridgeTimeoutSeconds', 'number'),
        numberSpec: { min: 1, step: 30, placeholder: translation('common.default') },
      },
    }),
    booleanAgentSetting({
      id: 'claudeRemoteEnableFileCheckpointing',
      default: false,
      description: 'Enable Claude file checkpointing',
      analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
      ui: fieldUi('claudeRemoteEnableFileCheckpointing', 'boolean'),
    }),
    positiveIntegerAgentSetting({
      id: 'claudeRemoteMaxThinkingTokens',
      default: null,
      nullable: true,
      description: 'Maximum Claude thinking tokens override',
      ui: {
        ...fieldUi('claudeRemoteMaxThinkingTokens', 'number'),
        numberSpec: { min: 1, step: 100, placeholder: translation('common.default') },
      },
    }),
    booleanAgentSetting({
      id: 'claudeRemoteDisableTodos',
      default: false,
      description: 'Disable TODO generation in Claude remote mode',
      analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
      ui: fieldUi('claudeRemoteDisableTodos', 'boolean'),
    }),
    booleanAgentSetting({
      id: 'claudeRemoteStrictMcpServerConfig',
      default: false,
      description: 'Fail if Claude MCP server config is invalid',
      analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
      ui: fieldUi('claudeRemoteStrictMcpServerConfig', 'boolean'),
    }),
    booleanAgentSetting({
      id: 'claudeRemoteDebugEnabled',
      default: false,
      description: 'Enable Claude Code debug mode (remote)',
      analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
      ui: fieldUi('claudeRemoteDebugEnabled', 'boolean'),
    }),
    booleanAgentSetting({
      id: 'claudeRemoteVerboseEnabled',
      default: false,
      description: 'Enable Claude Code verbose logging (remote)',
      analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
      ui: fieldUi('claudeRemoteVerboseEnabled', 'boolean'),
    }),
    enumArrayAgentSetting({
      id: 'claudeRemoteDebugCategories',
      values: CLAUDE_REMOTE_DEBUG_CATEGORIES,
      default: [],
      max: 5,
      description: 'Claude Code debug categories filter (remote)',
      analytics: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'enum',
        privacy: 'safe',
        identityScope: 'person',
        serializeCurrentRule: 'orderedEnumArrayJoin',
      },
      ui: multiEnumFieldUi('claudeRemoteDebugCategories', CLAUDE_REMOTE_DEBUG_CATEGORIES),
    }),
  ],
  ui: {
    title: translation('settingsAgents.plugins.claude.title'),
    icon: { ionName: 'sparkles-outline', color: { kind: 'theme', token: 'orange' } },
    subagentSettingsSections: [
      {
        id: 'claudeTeams',
        title: translation('subAgentGuidance.settings.agents.claude.title'),
        footer: translation('subAgentGuidance.settings.agents.claude.footer'),
        items: [
          {
            id: 'claudeTeamsAgentSettings',
            title: translation('subAgentGuidance.settings.agents.claude.openTitle'),
            subtitle: translation('subAgentGuidance.settings.agents.claude.openSubtitle'),
            route: '/(app)/settings/agents/claude',
            iconIonName: 'sparkles-outline',
          },
        ],
      },
    ],
    sections: [
      {
        id: 'claudeRemoteSdk',
        title: translation('settingsAgents.plugins.claude.sections.claudeRemoteSdk.title'),
        footer: translation('settingsAgents.plugins.claude.sections.claudeRemoteSdk.footer'),
        fields: [
          'claudeRemoteAgentSdkEnabled',
          'claudeRemoteDebugEnabled',
          'claudeRemoteVerboseEnabled',
          'claudeRemoteDebugCategories',
          'claudeRemoteSettingSourcesV2',
          'claudeLocalPermissionBridgeEnabled',
          'claudeLocalPermissionBridgeWaitIndefinitely',
          'claudeLocalPermissionBridgeTimeoutSeconds',
          'claudeRemoteEnableFileCheckpointing',
          'claudeRemoteMaxThinkingTokens',
          'claudeRemoteDisableTodos',
          'claudeRemoteStrictMcpServerConfig',
        ],
      },
      {
        id: 'claudeUnifiedTerminal',
        title: translation('settingsAgents.plugins.claude.sections.claudeUnifiedTerminal.title'),
        footer: translation('settingsAgents.plugins.claude.sections.claudeUnifiedTerminal.footer'),
        fields: ['claudeUnifiedTerminalEnabled', 'claudeUnifiedTerminalHost', 'claudeUnifiedTerminalResumeChoice'],
      },
    ],
  },
});

export const CLAUDE_REMOTE_AGENT_SETTINGS_DEFAULTS = buildAgentSettingsDefaults(
  CLAUDE_AGENT_SETTINGS_CONTRIBUTION,
);

export const CLAUDE_AGENT_SETTINGS_DESCRIPTOR = agentSettingsContributionToUiDescriptor(
  CLAUDE_AGENT_SETTINGS_CONTRIBUTION,
);
