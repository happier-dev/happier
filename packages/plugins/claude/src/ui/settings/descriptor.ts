import { CLAUDE_UNIFIED_TERMINAL_HOSTS } from '@happier-dev/agents';

type TranslationRef = Readonly<{ key: string }>;
type TranslatableText = TranslationRef;

type ClaudeProviderSettingSchema =
  | Readonly<{ kind: 'boolean' }>
  | Readonly<{ kind: 'string' }>
  | Readonly<{ kind: 'jsonObjectString'; maxLength?: number }>
  | Readonly<{ kind: 'enum'; values: readonly string[] }>
  | Readonly<{ kind: 'array'; element: ClaudeProviderSettingSchema; max?: number }>
  | Readonly<{ kind: 'number'; int?: boolean; min?: number; max?: number; nullable?: boolean }>;

type ClaudeProviderSettingDefinition = Readonly<{
  schema: ClaudeProviderSettingSchema;
  default: unknown;
  description: string;
  storageScope: 'account';
}>;

type ClaudeProviderSettingsDescriptor = Readonly<{
  kind: 'providerSettings.v1';
  descriptorId: 'claude.providerSettings.v1';
  providerId: 'claude';
  title: TranslatableText;
  icon: Readonly<{ ionName: string; color: Readonly<{ kind: 'theme'; token: 'orange' }> }>;
  settings: Readonly<Record<string, ClaudeProviderSettingDefinition>>;
  subagentSettingsSections: readonly Readonly<{
    id: string;
    title: TranslatableText;
    footer?: TranslatableText;
    items: readonly Readonly<{
      id: string;
      title: TranslatableText;
      subtitle?: TranslatableText;
      route: string;
      iconIonName?: string;
    }>[];
  }>[];
  uiSections: readonly Readonly<{
    id: string;
    title: TranslatableText;
    footer?: TranslatableText;
    fields: readonly Readonly<{
      key: string;
      kind: 'boolean' | 'enum' | 'multiEnum' | 'number' | 'json';
      title: TranslatableText;
      subtitle?: TranslatableText;
      enumOptions?: readonly Readonly<{
        id: string;
        title: TranslatableText;
        subtitle?: TranslatableText;
      }>[];
      numberSpec?: Readonly<{
        min?: number;
        step?: number;
        placeholder?: TranslatableText;
      }>;
    }>[];
  }>[];
}>;

const CLAUDE_SETTING_SOURCES_V2 = ['user', 'project', 'local'] as const;
const CLAUDE_REMOTE_DEBUG_CATEGORIES = ['api', 'mcp', 'hooks', 'file', '1p'] as const;

function translation(key: string): TranslationRef {
  return { key };
}

function booleanSetting(defaultValue: boolean, description: string): ClaudeProviderSettingDefinition {
  return {
    schema: { kind: 'boolean' },
    default: defaultValue,
    description,
    storageScope: 'account',
  };
}

function enumSetting(values: readonly string[], defaultValue: string, description: string): ClaudeProviderSettingDefinition {
  return {
    schema: { kind: 'enum', values },
    default: defaultValue,
    description,
    storageScope: 'account',
  };
}

function enumArraySetting(
  values: readonly string[],
  defaultValue: readonly string[],
  max: number,
  description: string,
): ClaudeProviderSettingDefinition {
  return {
    schema: { kind: 'array', element: { kind: 'enum', values }, max },
    default: defaultValue,
    description,
    storageScope: 'account',
  };
}

function positiveIntegerSetting(
  defaultValue: number | null,
  description: string,
  params: Readonly<{ nullable?: boolean }> = {},
): ClaudeProviderSettingDefinition {
  return {
    schema: { kind: 'number', int: true, min: 1, ...(params.nullable ? { nullable: true } : {}) },
    default: defaultValue,
    description,
    storageScope: 'account',
  };
}

function jsonObjectStringSetting(defaultValue: string, description: string): ClaudeProviderSettingDefinition {
  return {
    schema: { kind: 'jsonObjectString', maxLength: 16_384 },
    default: defaultValue,
    description,
    storageScope: 'account',
  };
}

function fieldTranslationKey(fieldKey: string, suffix: 'title' | 'subtitle'): string {
  return `settingsProviders.plugins.claude.fields.${fieldKey}.${suffix}`;
}

function booleanField(key: string) {
  return {
    key,
    kind: 'boolean',
    title: translation(fieldTranslationKey(key, 'title')),
    subtitle: translation(fieldTranslationKey(key, 'subtitle')),
  } as const;
}

function numberField(key: string, params: Readonly<{ min?: number; step?: number; placeholder?: TranslatableText }> = {}) {
  return {
    key,
    kind: 'number',
    title: translation(fieldTranslationKey(key, 'title')),
    subtitle: translation(fieldTranslationKey(key, 'subtitle')),
    numberSpec: params,
  } as const;
}

function jsonField(key: string) {
  return {
    key,
    kind: 'json',
    title: translation(fieldTranslationKey(key, 'title')),
    subtitle: translation(fieldTranslationKey(key, 'subtitle')),
  } as const;
}

function option(baseKey: string, id: string) {
  return {
    id,
    title: translation(`${baseKey}.options.${id}.title`),
    subtitle: translation(`${baseKey}.options.${id}.subtitle`),
  } as const;
}

function enumField(key: string, optionIds: readonly string[]) {
  const baseKey = `settingsProviders.plugins.claude.fields.${key}`;
  return {
    key,
    kind: 'enum',
    title: translation(`${baseKey}.title`),
    subtitle: translation(`${baseKey}.subtitle`),
    enumOptions: optionIds.map((id) => option(baseKey, id)),
  } as const;
}

function multiEnumField(key: string, optionIds: readonly string[]) {
  const baseKey = `settingsProviders.plugins.claude.fields.${key}`;
  return {
    key,
    kind: 'multiEnum',
    title: translation(`${baseKey}.title`),
    subtitle: translation(`${baseKey}.subtitle`),
    enumOptions: optionIds.map((id) => option(baseKey, id)),
  } as const;
}

export const CLAUDE_PROVIDER_SETTINGS_DESCRIPTOR = {
  kind: 'providerSettings.v1',
  descriptorId: 'claude.providerSettings.v1',
  providerId: 'claude',
  title: translation('settingsProviders.plugins.claude.title'),
  icon: { ionName: 'sparkles-outline', color: { kind: 'theme', token: 'orange' } },
  settings: {
    claudeRemoteAgentSdkEnabled: booleanSetting(true, 'Use Claude Agent SDK in remote mode'),
    claudeUnifiedTerminalEnabled: booleanSetting(false, 'Enable Claude unified terminal runtime'),
    claudeUnifiedTerminalHost: enumSetting(
      CLAUDE_UNIFIED_TERMINAL_HOSTS,
      'auto',
      'Claude unified terminal host adapter preference',
    ),
    claudeRemoteSettingSources: enumSetting(
      ['project', 'user_project', 'none'],
      'user_project',
      'Legacy Claude settings source mode',
    ),
    claudeRemoteSettingSourcesV2: enumArraySetting(
      CLAUDE_SETTING_SOURCES_V2,
      ['user', 'project', 'local'],
      3,
      'Claude settings sources',
    ),
    claudeCodeExperimentalAgentTeamsEnabled: booleanSetting(false, 'Force-enable Claude experimental agent teams'),
    claudeLocalPermissionBridgeEnabled: booleanSetting(true, 'Enable local Claude permission bridge'),
    claudeLocalPermissionBridgeWaitIndefinitely: booleanSetting(
      true,
      'Keep local permission requests open until the user responds',
    ),
    claudeLocalPermissionBridgeTimeoutSeconds: positiveIntegerSetting(
      600,
      'Local permission bridge timeout in seconds',
    ),
    claudeRemoteEnableFileCheckpointing: booleanSetting(false, 'Enable Claude file checkpointing'),
    claudeRemoteMaxThinkingTokens: positiveIntegerSetting(
      null,
      'Maximum Claude thinking tokens override',
      { nullable: true },
    ),
    claudeRemoteDisableTodos: booleanSetting(false, 'Disable TODO generation in Claude remote mode'),
    claudeRemoteStrictMcpServerConfig: booleanSetting(false, 'Fail if Claude MCP server config is invalid'),
    claudeRemoteDebugEnabled: booleanSetting(false, 'Enable Claude Code debug mode (remote)'),
    claudeRemoteVerboseEnabled: booleanSetting(false, 'Enable Claude Code verbose logging (remote)'),
    claudeRemoteDebugCategories: enumArraySetting(
      CLAUDE_REMOTE_DEBUG_CATEGORIES,
      [],
      5,
      'Claude Code debug categories filter (remote)',
    ),
    claudeRemoteAdvancedOptionsJson: jsonObjectStringSetting('', 'Advanced Claude remote options JSON'),
  },
  subagentSettingsSections: [
    {
      id: 'claudeTeams',
      title: translation('subAgentGuidance.settings.providers.claude.title'),
      footer: translation('subAgentGuidance.settings.providers.claude.footer'),
      items: [
        {
          id: 'claudeTeamsProviderSettings',
          title: translation('subAgentGuidance.settings.providers.claude.openTitle'),
          subtitle: translation('subAgentGuidance.settings.providers.claude.openSubtitle'),
          route: '/(app)/settings/providers/claude',
          iconIonName: 'sparkles-outline',
        },
      ],
    },
  ],
  uiSections: [
    {
      id: 'claudeCodeExperiments',
      title: translation('settingsProviders.plugins.claude.sections.claudeCodeExperiments.title'),
      footer: translation('settingsProviders.plugins.claude.sections.claudeCodeExperiments.footer'),
      fields: [
        booleanField('claudeCodeExperimentalAgentTeamsEnabled'),
      ],
    },
    {
      id: 'claudeRemoteSdk',
      title: translation('settingsProviders.plugins.claude.sections.claudeRemoteSdk.title'),
      footer: translation('settingsProviders.plugins.claude.sections.claudeRemoteSdk.footer'),
      fields: [
        booleanField('claudeRemoteAgentSdkEnabled'),
        booleanField('claudeRemoteDebugEnabled'),
        booleanField('claudeRemoteVerboseEnabled'),
        multiEnumField('claudeRemoteDebugCategories', CLAUDE_REMOTE_DEBUG_CATEGORIES),
        multiEnumField('claudeRemoteSettingSourcesV2', CLAUDE_SETTING_SOURCES_V2),
        booleanField('claudeLocalPermissionBridgeEnabled'),
        booleanField('claudeLocalPermissionBridgeWaitIndefinitely'),
        numberField('claudeLocalPermissionBridgeTimeoutSeconds', {
          min: 1,
          step: 30,
          placeholder: translation('common.default'),
        }),
        booleanField('claudeRemoteEnableFileCheckpointing'),
        numberField('claudeRemoteMaxThinkingTokens', {
          min: 1,
          step: 100,
          placeholder: translation('common.default'),
        }),
        booleanField('claudeRemoteDisableTodos'),
        booleanField('claudeRemoteStrictMcpServerConfig'),
        jsonField('claudeRemoteAdvancedOptionsJson'),
      ],
    },
    {
      id: 'claudeUnifiedTerminal',
      title: translation('settingsProviders.plugins.claude.sections.claudeUnifiedTerminal.title'),
      footer: translation('settingsProviders.plugins.claude.sections.claudeUnifiedTerminal.footer'),
      fields: [
        booleanField('claudeUnifiedTerminalEnabled'),
        enumField('claudeUnifiedTerminalHost', CLAUDE_UNIFIED_TERMINAL_HOSTS),
      ],
    },
  ],
} as const satisfies ClaudeProviderSettingsDescriptor;
