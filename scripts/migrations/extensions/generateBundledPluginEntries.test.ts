import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { main as generateBundledPluginEntries } from './generateBundledPluginEntries.ts';

function writeJson(path: string, value: unknown): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readGeneratedAgentBlock(output: string, agentId: string, nextAgentId?: string): string {
  const startMarker = `"${agentId}": Object.freeze((`;
  const start = output.indexOf(startMarker);
  assert.notEqual(start, -1, `expected generated ${agentId} block`);
  if (!nextAgentId) return output.slice(start);

  const end = output.indexOf(`\n  "${nextAgentId}": Object.freeze((`, start + startMarker.length);
  assert.notEqual(end, -1, `expected generated ${nextAgentId} block after ${agentId}`);
  return output.slice(start, end);
}

function readGeneratedAgentProviderIdsOutput(repoRoot: string): string {
  const agentProviderIdsOutPath = resolve(repoRoot, 'packages/agents/src/generated/agentProviderIds.ts');
  assert.equal(existsSync(agentProviderIdsOutPath), true, 'expected generated agent provider id output');
  return readFileSync(agentProviderIdsOutPath, 'utf8');
}

function readGeneratedProtocolAgentProviderIdsOutput(repoRoot: string): string {
  const agentProviderIdsOutPath = resolve(repoRoot, 'packages/protocol/src/providers/agentProviderIdsV1.ts');
  assert.equal(existsSync(agentProviderIdsOutPath), true, 'expected generated protocol agent provider id output');
  return readFileSync(agentProviderIdsOutPath, 'utf8');
}

function readGeneratedSessionControlAdaptersOutput(repoRoot: string): string {
  const outPath = resolve(repoRoot, 'packages/agents/src/generated/sessionControlAdapters.ts');
  assert.equal(existsSync(outPath), true, 'expected generated session-control adapter output');
  return readFileSync(outPath, 'utf8');
}

function readGeneratedRuntimeDescriptorReadersOutput(repoRoot: string): string {
  const outPath = resolve(repoRoot, 'packages/agents/src/generated/runtimeDescriptorReaders.ts');
  assert.equal(existsSync(outPath), true, 'expected generated runtime descriptor reader output');
  return readFileSync(outPath, 'utf8');
}

function readGeneratedProtocolRuntimeDescriptorContributionsOutput(repoRoot: string): string {
  const outPath = resolve(repoRoot, 'packages/protocol/src/providers/runtimeDescriptorContributionsV1.ts');
  assert.equal(existsSync(outPath), true, 'expected generated protocol runtime descriptor contribution output');
  return readFileSync(outPath, 'utf8');
}

function readGeneratedProtocolRuntimeDescriptorModuleOutput(repoRoot: string, providerId: string): string {
  const outPath = resolve(repoRoot, `packages/protocol/src/providers/generated/runtime/descriptors/${providerId}.ts`);
  assert.equal(existsSync(outPath), true, `expected generated protocol runtime descriptor module for ${providerId}`);
  return readFileSync(outPath, 'utf8');
}

function readGeneratedProtocolBuiltInBackendProfilesOutput(repoRoot: string): string {
  const outPath = resolve(repoRoot, 'packages/protocol/src/providers/generated/profiles/builtInBackendProfiles.ts');
  assert.equal(existsSync(outPath), true, 'expected generated protocol built-in backend profiles output');
  return readFileSync(outPath, 'utf8');
}

function readGeneratedProtocolMemoryDefaultsOutput(repoRoot: string): string {
  const outPath = resolve(repoRoot, 'packages/protocol/src/providers/generated/memory/defaults.ts');
  assert.equal(existsSync(outPath), true, 'expected generated protocol memory defaults output');
  return readFileSync(outPath, 'utf8');
}

function readGeneratedProtocolExternalSessionSourcesOutput(repoRoot: string): string {
  const outPath = resolve(repoRoot, 'packages/protocol/src/providers/generated/externalSession/sources.ts');
  assert.equal(existsSync(outPath), true, 'expected generated protocol external-session sources output');
  return readFileSync(outPath, 'utf8');
}

function readGeneratedPromptAssetPluginDescriptorsOutput(repoRoot: string): string {
  const outPath = resolve(repoRoot, 'apps/cli/src/prompts/assets/generated/pluginDescriptors.ts');
  assert.equal(existsSync(outPath), true, 'expected generated prompt asset plugin descriptor output');
  return readFileSync(outPath, 'utf8');
}

function readGeneratedStringArray(output: string, symbol: string): readonly string[] {
  const match = output.match(new RegExp(`export const ${symbol} = Object\\.freeze\\(\\[([\\s\\S]*?)\\] as const\\);`));
  assert.ok(match, `expected generated ${symbol} array`);
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((entry) => entry[1]);
}

function assertNoExecutableUiProjectionImports(output: string): void {
  assert.doesNotMatch(output, /@happier-dev\/plugins-[^'"]+\/ui/);
  assert.doesNotMatch(output, /@\/agents\/providers\/(?:codex|claude|opencode|gemini|pi|ohMyPi|kiro|auggie|kimi|kilo|copilot|cursor)\//);
  assert.doesNotMatch(output, /from '\.\/bundled\/(?:codex|claude|opencode|gemini|pi|ohMyPi|kiro|auggie|kimi|kilo|copilot|cursor)\//);
}

function pluginManifestSource(input: Readonly<{
  id: string;
  capabilities?: readonly string[];
  contributes?: string;
}>): string {
  return [
    'export const PLUGIN_MANIFEST = Object.freeze({',
    '  schemaVersion: 2,',
    `  id: ${JSON.stringify(input.id)},`,
    '  version: "0.0.0",',
    `  displayName: ${JSON.stringify(input.id)},`,
    '  description: "Test plugin manifest.",',
    '  engines: { happier: "^0.0.0" },',
    `  runtime: { apiVersion: 1, capabilities: ${JSON.stringify(input.capabilities ?? [])} },`,
    '  targets: {},',
    '  capabilities: { permissions: [] },',
    `  contributes: ${input.contributes ?? '{}'},`,
    '});',
    '',
  ].join('\n');
}

function writeGeneratorOutputScaffold(repoRoot: string, uiSource?: string): void {
  mkdirSync(resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'apps/ui/sources/agents/registry'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/agents/src/generated'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/agents/src/definitions'), { recursive: true });

  writeFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts'),
    uiSource ?? 'export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: readonly string[] = Object.freeze([]);\n',
    'utf8',
  );
  writeFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.sessionProviderBehaviors.ts'),
    'export const BUNDLED_CANONICAL_AGENT_SESSION_PROVIDER_BEHAVIORS = Object.freeze({});\n',
    'utf8',
  );
  writeFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.messageMetaOverrides.ts'),
    'export const BUNDLED_PROVIDER_MESSAGE_META_OVERRIDE_BUILDERS = Object.freeze({});\n',
    'utf8',
  );
  writeFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.providerSettings.ts'),
    'export const BUNDLED_PROVIDER_SETTINGS_PLUGINS = Object.freeze([]);\n',
    'utf8',
  );
  writeFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.visibleMessageResolvers.ts'),
    'export const BUNDLED_SESSION_SUBAGENT_VISIBLE_MESSAGE_REGISTRY = Object.freeze([]);\n',
    'utf8',
  );
  writeFileSync(
    resolve(repoRoot, 'packages/agents/src/definitions/agentDefinition.ts'),
    'export type AgentDefinition = Readonly<{ id: string } & Record<string, unknown>>;\n',
    'utf8',
  );
}

function writeAgentPluginFixture(repoRoot: string, pluginPackageId: string, agentId = pluginPackageId): void {
  writeJson(resolve(repoRoot, `packages/plugins/${pluginPackageId}/package.json`), {
    name: `@happier-dev/plugins-${pluginPackageId}`,
    version: '0.0.0',
  });
  mkdirSync(resolve(repoRoot, `packages/plugins/${pluginPackageId}/src`), { recursive: true });
  writeFileSync(
    resolve(repoRoot, `packages/plugins/${pluginPackageId}/src/manifest.ts`),
    pluginManifestSource({ id: `happier.agent.${pluginPackageId}`, capabilities: ['agents'] }),
    'utf8',
  );
  mkdirSync(resolve(repoRoot, `packages/plugins/${pluginPackageId}/src/agent`), { recursive: true });
  writeFileSync(
    resolve(repoRoot, `packages/plugins/${pluginPackageId}/src/agent/definition.ts`),
    [
      'export const AGENT_DEFINITION = Object.freeze({',
      `  id: ${JSON.stringify(agentId)},`,
      '  agentCliRuntime: {',
      `    id: ${JSON.stringify(agentId)},`,
      `    title: ${JSON.stringify(`${agentId} CLI`)},`,
      `    binaryName: ${JSON.stringify(agentId)},`,
      '    sourcePreferenceDefault: "system-first",',
      '    managedInstall: null,',
      '    manualInstallKind: "none",',
      '    manualInstallRecipes: null,',
      '    acceptsJavaScriptFileOverride: false,',
      '  },',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
}

function writeOpenCodeAgentPluginFixture(repoRoot: string): void {
  writeAgentPluginFixture(repoRoot, 'opencode');
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/opencode/src/agent/definition.ts'),
    [
      'export const AGENT_DEFINITION = Object.freeze({',
      '  id: "opencode",',
      '  agentCliRuntime: {',
      '    id: "opencode",',
      '    title: "opencode CLI",',
      '    binaryName: "opencode",',
      '    sourcePreferenceDefault: "system-first",',
      '    managedInstall: null,',
      '    manualInstallKind: "none",',
      '    manualInstallRecipes: null,',
      '    acceptsJavaScriptFileOverride: false,',
      '  },',
      '  commandSurface: {',
      '    rootHelpLabel: "happier opencode",',
      '    rootHelpDescription: "Start OpenCode mode",',
      '    allowTmux: true,',
      '  },',
      '  runtimeContributions: {',
      '    providerCatalogEntry: { importName: "OPENCODE_PROVIDER_RUNTIME_CONTRIBUTION", source: "./agent/contributions/runtime" },',
      '  },',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  mkdirSync(resolve(repoRoot, 'packages/plugins/opencode/src/agent/contributions'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/opencode/src/agent/contributions/runtime.ts'),
    'export const OPENCODE_PROVIDER_RUNTIME_CONTRIBUTION = Object.freeze({ agentId: "opencode" });\n',
    'utf8',
  );
}

function writeUiDescriptorFixture(
  repoRoot: string,
  pluginPackageId: string,
  exportName: string,
  descriptor: Record<string, unknown>,
): void {
  mkdirSync(resolve(repoRoot, `packages/plugins/${pluginPackageId}/src/ui`), { recursive: true });
  writeFileSync(
    resolve(repoRoot, `packages/plugins/${pluginPackageId}/src/ui/descriptor.ts`),
    [
      `export const ${exportName} = Object.freeze(${JSON.stringify(descriptor, null, 2)});`,
      '',
    ].join('\n'),
    'utf8',
  );
}

function writeCursorUiDescriptorFixture(repoRoot: string): void {
  writeUiDescriptorFixture(repoRoot, 'cursor', 'CURSOR_UI_DESCRIPTOR', {
    kind: 'plugin.ui.v1',
    pluginId: 'cursor',
    agentId: 'cursor',
    version: 1,
    display: {
      nameKey: 'test.cursor.descriptorName',
      subtitleKey: 'test.cursor.descriptorSubtitle',
      permissionModeI18nPrefix: 'test.cursor.permissionMode',
      availability: { experimental: false },
      connectedService: { serviceId: null, labelKey: 'test.cursor.descriptorName', connectRoute: null },
      flavorAliases: ['descriptor-cursor'],
      permissions: { modeGroup: 'codexLike', promptProtocol: 'codexDecision' },
      resume: {
        uiVendorResumeIdLabelKey: 'test.cursor.resumeId',
        uiVendorResumeIdCopiedKey: 'test.cursor.resumeCopied',
      },
      localControl: true,
      runtimeInput: { inFlightSteerSupported: true },
      toolRendering: { hideUnknownToolsByDefault: false },
      picker: {
        iconName: 'descriptor-icon',
        iconScale: 0.7,
        cliGlyphTokenId: 'agentGlyph.cursor',
        cliGlyphScale: 0.8,
        profileCompatibilityGlyphScale: 0.9,
      },
      avatarOverlay: { circleScale: 0.4, iconScaleRatio: 0.25 },
      icon: { assetId: 'cursor' },
    },
    settings: {},
    behavior: {},
    session: {},
    message: {},
    components: {
      slots: [
        {
          id: 'claude.subagentLaunchCards',
          slot: 'sessionSubagents.launchCards',
          componentId: 'firstParty.claude.subagentLaunchCards',
          props: {
            teamIds: {
              kind: 'subagentGroupKeys',
              subagentKinds: ['agent_team_member'],
            },
          },
        },
        {
          id: 'claude.teammateDetailsTab',
          slot: 'sessionSubagents.teammateDetailsTab',
          componentId: 'firstParty.claude.teammateDetailsTab',
          resourceKind: 'claudeSubagentLauncher',
          iconName: 'people',
          tab: {
            keyPrefix: 'claude-subagent-launcher',
            titleKey: 'session.subagents.panel.launchTeammateAction',
            subtitleKey: 'session.subagents.panel.launchClaudeTeamsSubtitle',
          },
        },
      ],
    },
    assets: { svgIcon: { assetId: 'cursor' } },
  });
}

function writeClaudeUiDescriptorFixture(repoRoot: string): void {
  writeUiDescriptorFixture(repoRoot, 'claude', 'CLAUDE_UI_DESCRIPTOR', {
    kind: 'plugin.ui.v1',
    pluginId: 'claude',
    agentId: 'claude',
    version: 1,
    display: {
      nameKey: 'agentInput.agent.claude',
      subtitleKey: 'profiles.aiBackend.claudeSubtitle',
      permissionModeI18nPrefix: 'agentInput.permissionMode',
      availability: { experimental: false },
      connectedService: {
        serviceId: 'anthropic',
        labelKey: 'agentInput.agent.claude',
        connectRoute: '/(app)/settings/connect/claude',
      },
      flavorAliases: ['claude'],
      permissions: { modeGroup: 'claude', promptProtocol: 'claude' },
      sessionModes: {
        staticOptions: [
          { id: 'default', nameKey: 'agentInput.mode.build', descriptionKey: 'agentInput.mode.buildDescription' },
          { id: 'plan', nameKey: 'agentInput.mode.plan', descriptionKey: 'agentInput.mode.planDescription' },
        ],
      },
      resume: {
        uiVendorResumeIdLabelKey: 'sessionInfo.claudeCodeSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.claudeCodeSessionIdCopied',
      },
      localControl: true,
      toolRendering: { hideUnknownToolsByDefault: false },
      picker: {
        iconName: 'sparkles-outline',
        cliGlyphTokenId: 'agentGlyph.claude',
        cliGlyphScale: 1.0,
        profileCompatibilityGlyphScale: 1.14,
      },
      avatarOverlay: { circleScale: 0.35, iconScaleRatio: 0.22 },
      icon: { assetId: 'claude' },
    },
    settings: { descriptorId: 'claude.providerSettings.v1' },
    behavior: { descriptorId: 'claude.uiBehavior.v1' },
    session: {
      providerBehaviorDescriptorId: 'claude.sessionProviderBehavior.v1',
      visibleMessages: {
        kind: 'session.visibleMessages.v1',
        subagentKinds: ['agent_team_member'],
        fallbackToolNames: ['Agent', 'Task'],
        excludeJsonEventTypes: ['idle_notification', 'shutdown_approved'],
      },
    },
    message: {
      metaOverrides: [
        {
          id: 'reasoning-effort',
          targetKey: 'reasoningEffort',
          value: {
            kind: 'sessionConfigOptionOverride',
            key: 'reasoning_effort',
          },
          normalize: 'trimLowercase',
        },
      ],
    },
    components: {
      slots: [
        {
          id: 'claude.subagentLaunchCards',
          slot: 'sessionSubagents.launchCards',
          componentId: 'firstParty.claude.subagentLaunchCards',
          props: {
            teamIds: {
              kind: 'subagentGroupKeys',
              subagentKinds: ['agent_team_member'],
            },
          },
        },
        {
          id: 'claude.teammateDetailsTab',
          slot: 'sessionSubagents.teammateDetailsTab',
          componentId: 'firstParty.claude.teammateDetailsTab',
          resourceKind: 'claudeSubagentLauncher',
          iconName: 'people',
          tab: {
            keyPrefix: 'claude-subagent-launcher',
            titleKey: 'session.subagents.panel.launchTeammateAction',
            subtitleKey: 'session.subagents.panel.launchClaudeTeamsSubtitle',
          },
        },
      ],
    },
    assets: { svgIcon: { assetId: 'claude' } },
  });
}

function writeOpenCodeUiDescriptorFixture(repoRoot: string): void {
  writeUiDescriptorFixture(repoRoot, 'opencode', 'OPENCODE_UI_DESCRIPTOR', {
    kind: 'plugin.ui.v1',
    pluginId: 'opencode',
    agentId: 'opencode',
    version: 1,
    display: {
      nameKey: 'agentInput.agent.opencode',
      subtitleKey: 'profiles.aiBackend.opencodeSubtitle',
      permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
      availability: { experimental: false },
      connectedService: { serviceId: null, labelKey: 'agentInput.agent.opencode', connectRoute: null },
      flavorAliases: ['opencode', 'open-code'],
      permissions: { modeGroup: 'codexLike', promptProtocol: 'codexDecision' },
      resume: {
        uiVendorResumeIdLabelKey: 'sessionInfo.opencodeSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.opencodeSessionIdCopied',
      },
      localControl: true,
      toolRendering: { hideUnknownToolsByDefault: false },
      picker: {
        iconName: 'code-slash-outline',
        iconScale: 0.9,
        cliGlyphTokenId: 'agentGlyph.opencode',
        cliGlyphScale: 1.0,
        profileCompatibilityGlyphScale: 1.0,
      },
      avatarOverlay: { circleScale: 0.35, iconScaleRatio: 0.22 },
      icon: { assetId: 'opencode' },
    },
    settings: {
      kind: 'providerSettings.v1',
      descriptorId: 'opencode.providerSettings.v1',
      providerId: 'opencode',
      title: { key: 'settingsProviders.plugins.opencode.title' },
      icon: { ionName: 'code-slash-outline', color: { kind: 'theme', token: 'blue' } },
      settings: {
        opencodeBackendMode: {
          schema: { kind: 'enum', values: ['server', 'acp'] },
          default: 'server',
          description: 'Preferred OpenCode backend mode',
          storageScope: 'account',
        },
        opencodeServerBaseUrl: {
          schema: { kind: 'string' },
          default: '',
          description: 'Optional override for a user-managed OpenCode server URL',
          storageScope: 'account',
        },
        opencodeServerBaseUrlByServerIdV1: {
          schema: { kind: 'stringRecord' },
          default: {},
          description: 'Per-server overrides for user-managed OpenCode server URLs',
          storageScope: 'account',
        },
      },
      uiSections: [
        {
          id: 'opencodeBackendMode',
          title: { key: 'settingsProviders.plugins.opencode.sections.backendMode.title' },
          footer: { key: 'settingsProviders.plugins.opencode.sections.backendMode.footer' },
          fields: [
            {
              key: 'opencodeBackendMode',
              kind: 'enum',
              title: { key: 'settingsProviders.plugins.opencode.fields.opencodeBackendMode.title' },
              subtitle: { key: 'settingsProviders.plugins.opencode.fields.opencodeBackendMode.subtitle' },
              enumOptions: [
                {
                  id: 'server',
                  title: { key: 'settingsProviders.plugins.opencode.fields.opencodeBackendMode.options.server.title' },
                  subtitle: { key: 'settingsProviders.plugins.opencode.fields.opencodeBackendMode.options.server.subtitle' },
                },
                {
                  id: 'acp',
                  title: { key: 'settingsProviders.plugins.opencode.fields.opencodeBackendMode.options.acp.title' },
                  subtitle: { key: 'settingsProviders.plugins.opencode.fields.opencodeBackendMode.options.acp.subtitle' },
                },
              ],
            },
          ],
        },
        {
          id: 'opencodeServer',
          title: { key: 'settingsProviders.plugins.opencode.sections.server.title' },
          footer: { key: 'settingsProviders.plugins.opencode.sections.server.footer' },
          fields: [
            {
              key: 'opencodeServerBaseUrl',
              kind: 'text',
              title: { key: 'settingsProviders.plugins.opencode.fields.opencodeServerBaseUrl.title' },
              subtitle: { key: 'settingsProviders.plugins.opencode.fields.opencodeServerBaseUrl.subtitle' },
              binding: {
                kind: 'perActiveServer',
                fallbackSettingKey: 'opencodeServerBaseUrl',
                byServerIdSettingKey: 'opencodeServerBaseUrlByServerIdV1',
              },
            },
          ],
        },
      ],
    },
    behavior: {
      descriptorId: 'opencode.uiBehavior.v1',
      guidance: { includeInSessionGettingStartedCliExamples: true },
      mcpServers: { supportsDetectedConfigScan: true },
      externalSessions: {
        supportsBackgroundFollow: false,
        browse: {
          order: 30,
          sourceOptions: [
            {
              key: 'opencode:default',
              labelKey: 'externalSessions.browseSourceOpenCodeDefault',
              source: { kind: 'opencodeServer' },
            },
          ],
          compatibleSource: {
            sourceKind: 'opencodeServer',
            optionalFields: ['baseUrl', 'directory'],
          },
        },
      },
      payload: {
        environmentVariables: {
          providerId: 'opencode',
          backendMode: {
            envKey: 'HAPPIER_OPENCODE_BACKEND_MODE',
            settingKey: 'opencodeBackendMode',
            legacyMetadataKey: 'opencodeBackendMode',
            runtimeDescriptorField: 'backendMode',
            defaultValue: 'server',
            values: ['server', 'acp'],
          },
          serverBaseUrl: {
            envKey: 'HAPPIER_OPENCODE_SERVER_URL',
            explicitEnvKey: 'HAPPIER_OPENCODE_SERVER_URL_EXPLICIT',
            settingKey: 'opencodeServerBaseUrl',
            byServerIdSettingKey: 'opencodeServerBaseUrlByServerIdV1',
            legacyMetadataKey: 'opencodeServerBaseUrl',
            legacyExplicitMetadataKey: 'opencodeServerBaseUrlExplicit',
            runtimeDescriptorField: 'serverBaseUrl',
            runtimeDescriptorExplicitField: 'serverBaseUrlExplicit',
            allowedProtocols: ['http:', 'https:'],
            rejectCredentials: true,
            httpLoopbackOnly: true,
            originOnly: true,
          },
        },
      },
    },
    session: {},
    message: {},
    components: { slots: [] },
    assets: {
      svgIcon: {
        assetId: 'opencode',
        viewBox: '0 0 240 300',
        paths: [
          {
            fillToken: 'text.primary',
            fillRule: 'evenodd',
            clipRule: 'evenodd',
            d: 'M0 0H240V300H0V0ZM60 60H180V240H60V60Z',
          },
          {
            fillToken: 'text.primary',
            fillOpacity: 0.25,
            d: 'M60 120H180V240H60V120Z',
          },
        ],
      },
    },
  });
}

function writeAuggieUiDescriptorFixture(repoRoot: string): void {
  writeUiDescriptorFixture(repoRoot, 'auggie', 'AUGGIE_UI_DESCRIPTOR', {
    kind: 'plugin.ui.v1',
    pluginId: 'auggie',
    agentId: 'auggie',
    version: 1,
    display: {
      nameKey: 'agentInput.agent.auggie',
      subtitleKey: 'profiles.aiBackend.auggieSubtitle',
      permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
      availability: { experimental: true },
      connectedService: { serviceId: null, labelKey: 'agentInput.agent.auggie', connectRoute: null },
      flavorAliases: ['auggie'],
      permissions: { modeGroup: 'codexLike', promptProtocol: 'codexDecision' },
      resume: {
        uiVendorResumeIdLabelKey: 'sessionInfo.auggieSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.auggieSessionIdCopied',
      },
      toolRendering: { hideUnknownToolsByDefault: false },
      picker: {
        iconName: 'sparkles',
        iconScale: 1.15,
        cliGlyphTokenId: 'agentGlyph.auggie',
        cliGlyphScale: 1.0,
        profileCompatibilityGlyphScale: 1.0,
      },
      avatarOverlay: { circleScale: 0.35, iconScaleRatio: 0.22 },
      icon: { assetId: 'auggie' },
    },
    settings: { descriptorId: 'auggie.providerSettings.v1' },
    behavior: { descriptorId: 'auggie.uiBehavior.v1' },
    session: {},
    message: {},
    components: { slots: [] },
    assets: { svgIcon: { assetId: 'auggie' } },
  });
}

function writeKimiUiDescriptorFixture(repoRoot: string): void {
  writeUiDescriptorFixture(repoRoot, 'kimi', 'KIMI_UI_DESCRIPTOR', {
    kind: 'plugin.ui.v1',
    pluginId: 'kimi',
    agentId: 'kimi',
    version: 1,
    display: {
      nameKey: 'agentInput.agent.kimi',
      subtitleKey: 'profiles.aiBackend.kimiSubtitleExperimental',
      permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
      availability: { experimental: true },
      connectedService: { serviceId: null, labelKey: 'agentInput.agent.kimi', connectRoute: null },
      flavorAliases: ['kimi', 'kimi-cli'],
      permissions: { modeGroup: 'codexLike', promptProtocol: 'codexDecision' },
      resume: {
        uiVendorResumeIdLabelKey: 'sessionInfo.kimiSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.kimiSessionIdCopied',
      },
      toolRendering: { hideUnknownToolsByDefault: true },
      picker: {
        iconName: 'code-slash-outline',
        cliGlyphTokenId: 'agentGlyph.kimi',
        cliGlyphScale: 1.0,
        profileCompatibilityGlyphScale: 1.0,
      },
      avatarOverlay: { circleScale: 0.35, iconScaleRatio: 0.22 },
      icon: { assetId: 'kimi' },
    },
    settings: { descriptorId: 'kimi.providerSettings.v1' },
    behavior: {},
    session: {},
    message: {},
    components: { slots: [] },
    assets: { svgIcon: { assetId: 'kimi' } },
  });
}

function writeCodexUiDescriptorFixture(repoRoot: string): void {
  writeUiDescriptorFixture(repoRoot, 'codex', 'CODEX_UI_DESCRIPTOR', {
    kind: 'plugin.ui.v1',
    pluginId: 'codex',
    agentId: 'codex',
    version: 1,
    display: {
      nameKey: 'agentInput.agent.codex',
      subtitleKey: 'profiles.aiBackend.codexSubtitle',
      permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
      availability: { experimental: false },
      connectedService: { serviceId: 'openai', labelKey: 'agentInput.agent.codex', connectRoute: null },
      flavorAliases: ['codex', 'openai', 'gpt'],
      permissions: { modeGroup: 'codexLike', promptProtocol: 'codexDecision' },
      resume: {
        uiVendorResumeIdLabelKey: 'sessionInfo.codexSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.codexSessionIdCopied',
      },
      localControl: true,
      toolRendering: { hideUnknownToolsByDefault: false },
      picker: {
        iconName: 'terminal-outline',
        cliGlyphTokenId: 'agentGlyph.codex',
        cliGlyphScale: 0.92,
        profileCompatibilityGlyphScale: 0.82,
      },
      avatarOverlay: { circleScale: 0.35, iconScaleRatio: 0.22 },
      icon: { assetId: 'codex' },
    },
    settings: {},
    behavior: {},
    session: {},
    message: {},
    components: { slots: [] },
    assets: { svgIcon: { assetId: 'codex' } },
  });
}

function writeOhMyPiUiDescriptorFixture(repoRoot: string, pluginPackageId = 'ohmypi'): void {
  writeUiDescriptorFixture(repoRoot, pluginPackageId, 'OH_MY_PI_UI_DESCRIPTOR', {
    kind: 'plugin.ui.v1',
    pluginId: 'ohmypi',
    agentId: 'ohMyPi',
    version: 1,
    display: {
      nameKey: 'agentInput.agent.ohMyPi',
      subtitleKey: 'profiles.aiBackend.ohMyPiSubtitleExperimental',
      permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
      availability: { experimental: true },
      connectedService: { serviceId: null, labelKey: 'agentInput.agent.ohMyPi', connectRoute: null },
      flavorAliases: ['ohMyPi', 'oh-my-pi', 'omp'],
      permissions: { modeGroup: 'codexLike', promptProtocol: 'codexDecision' },
      resume: { uiVendorResumeIdLabelKey: null, uiVendorResumeIdCopiedKey: null },
      toolRendering: { hideUnknownToolsByDefault: false },
      picker: {
        iconName: 'planet-outline',
        iconScale: 0.9,
        cliGlyphTokenId: 'agentGlyph.ohMyPi',
        cliGlyphScale: 1.0,
        profileCompatibilityGlyphScale: 1.0,
      },
      avatarOverlay: { circleScale: 0.35, iconScaleRatio: 0.22 },
      icon: { assetId: 'ohMyPi' },
    },
    settings: {},
    behavior: {},
    session: {},
    message: {},
    components: { slots: [] },
    assets: { svgIcon: { assetId: 'ohMyPi' } },
  });
}

function writePiContributionPluginFixture(repoRoot: string): void {
  writeJson(resolve(repoRoot, 'packages/plugins/pi/package.json'), {
    name: '@happier-dev/plugins-pi',
    version: '0.0.0',
  });
  mkdirSync(resolve(repoRoot, 'packages/plugins/pi/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/pi/src/manifest.ts'),
    pluginManifestSource({ id: 'happier.agent.pi', capabilities: ['agents'] }),
    'utf8',
  );
  mkdirSync(resolve(repoRoot, 'packages/plugins/pi/src/agent'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/pi/src/agent/definition.ts'),
    [
      'export const AGENT_DEFINITION = Object.freeze({',
      '  id: "pi",',
      '  agentCliRuntime: {',
      '    id: "pi",',
      '    title: "Pi Coding Agent CLI",',
      '    binaryName: "pi",',
      '    sourcePreferenceDefault: "system-first",',
      '    managedInstall: null,',
      '    manualInstallKind: "command",',
      '    manualInstallRecipes: null,',
      '    acceptsJavaScriptFileOverride: false,',
      '  },',
      '  runtimeContributions: {',
      '    sessionControlAdapter: { kind: "runtimeDescriptorResumeId", providerId: "pi", absolutePathField: "sessionFile", fallbackField: "providerSessionId" },',
      '    runtimeDescriptorReader: { kind: "providerSessionId", providerId: "pi", runtimeHandle: "providerSessionId" },',
      '    protocolRuntimeDescriptor: { kind: "providerRuntimeDescriptorV1", providerId: "pi", source: "./protocol/runtimeDescriptorV1", buildFunction: "buildPiAgentRuntimeDescriptorV1", canonicalReader: "readCanonicalPiAgentRuntimeDescriptorV1" },',
      '  },',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  mkdirSync(resolve(repoRoot, 'packages/plugins/pi/src/protocol'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/pi/src/protocol/runtimeDescriptorV1.ts'),
    [
      'export type PiAgentRuntimeDescriptorV1 = Readonly<{ providerId: "pi" }>;',
      'export type CanonicalPiAgentRuntimeDescriptorV1 = Readonly<{ providerId: "pi" }>;',
      'export function buildPiAgentRuntimeDescriptorV1(): PiAgentRuntimeDescriptorV1 { return { providerId: "pi" }; }',
      'export function readCanonicalPiAgentRuntimeDescriptorV1(): CanonicalPiAgentRuntimeDescriptorV1 { return { providerId: "pi" }; }',
      '',
    ].join('\n'),
    'utf8',
  );
  writeUiDescriptorFixture(repoRoot, 'pi', 'PI_UI_DESCRIPTOR', {
    kind: 'plugin.ui.v1',
    pluginId: 'pi',
    agentId: 'pi',
    version: 1,
    display: {
      nameKey: 'agentInput.agent.pi',
      subtitleKey: 'profiles.aiBackend.piSubtitleExperimental',
      permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
      availability: { experimental: true },
      connectedService: { serviceId: null, labelKey: 'agentInput.agent.pi', connectRoute: null },
      flavorAliases: ['pi'],
      permissions: { modeGroup: 'codexLike', promptProtocol: 'codexDecision' },
      runtimeInput: { inFlightSteerSupported: true },
      resume: {
        uiVendorResumeIdLabelKey: 'sessionInfo.piSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.piSessionIdCopied',
      },
      toolRendering: { hideUnknownToolsByDefault: true },
      picker: {
        iconName: 'code-slash-outline',
        iconScale: 0.9,
        cliGlyphTokenId: 'agentGlyph.pi',
        cliGlyphScale: 1.0,
        profileCompatibilityGlyphScale: 1.0,
      },
      avatarOverlay: { circleScale: 0.35, iconScaleRatio: 0.22 },
      icon: { assetId: 'pi' },
    },
    settings: { descriptorId: 'pi.providerSettings.v1' },
    behavior: { descriptorId: 'pi.uiBehavior.v1' },
    session: {},
    message: {},
    components: { slots: [] },
    assets: { svgIcon: { assetId: 'pi' } },
  });
}

function writeRuntimeContributionPluginFixture(
  repoRoot: string,
  pluginPackageId: string,
  agentId: string,
  runtimeContributions: readonly string[],
): void {
  writeJson(resolve(repoRoot, `packages/plugins/${pluginPackageId}/package.json`), {
    name: `@happier-dev/plugins-${pluginPackageId}`,
    version: '0.0.0',
  });
  mkdirSync(resolve(repoRoot, `packages/plugins/${pluginPackageId}/src`), { recursive: true });
  writeFileSync(
    resolve(repoRoot, `packages/plugins/${pluginPackageId}/src/manifest.ts`),
    pluginManifestSource({ id: `happier.agent.${pluginPackageId}`, capabilities: ['agents'] }),
    'utf8',
  );
  mkdirSync(resolve(repoRoot, `packages/plugins/${pluginPackageId}/src/agent`), { recursive: true });
  writeFileSync(
    resolve(repoRoot, `packages/plugins/${pluginPackageId}/src/agent/definition.ts`),
    [
      'export const AGENT_DEFINITION = Object.freeze({',
      `  id: ${JSON.stringify(agentId)},`,
      '  agentCliRuntime: {',
      `    id: ${JSON.stringify(agentId)},`,
      `    title: ${JSON.stringify(`${agentId} CLI`)},`,
      `    binaryName: ${JSON.stringify(agentId)},`,
      '    sourcePreferenceDefault: "system-first",',
      '    managedInstall: null,',
      '    manualInstallKind: "none",',
      '    manualInstallRecipes: null,',
      '    acceptsJavaScriptFileOverride: false,',
      '  },',
      '  runtimeContributions: {',
      ...runtimeContributions.map((line) => `    ${line}`),
      '  },',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  if (runtimeContributions.some((line) => line.includes('protocolRuntimeDescriptor'))) {
    const runtimeDescriptorSourceByAgentId: Record<string, string> = {
      codex: [
        'export type CodexAgentRuntimeDescriptorV1 = Readonly<{ providerId: "codex" }>;',
        'export type CanonicalCodexAgentRuntimeDescriptorV1 = Readonly<{ providerId: "codex" }>;',
        'export function buildCodexAgentRuntimeDescriptorV1(): CodexAgentRuntimeDescriptorV1 { return { providerId: "codex" }; }',
        'export function readCanonicalCodexAgentRuntimeDescriptorV1(): CanonicalCodexAgentRuntimeDescriptorV1 { return { providerId: "codex" }; }',
        '',
      ].join('\n'),
      opencode: [
        'export type OpenCodeAgentRuntimeDescriptorV1 = Readonly<{ providerId: "opencode" }>;',
        'export type CanonicalOpenCodeAgentRuntimeDescriptorV1 = Readonly<{ providerId: "opencode" }>;',
        'export function buildOpenCodeAgentRuntimeDescriptorV1(): OpenCodeAgentRuntimeDescriptorV1 { return { providerId: "opencode" }; }',
        'export function readCanonicalOpenCodeAgentRuntimeDescriptorV1(): CanonicalOpenCodeAgentRuntimeDescriptorV1 { return { providerId: "opencode" }; }',
        '',
      ].join('\n'),
      pi: [
        'export type PiAgentRuntimeDescriptorV1 = Readonly<{ providerId: "pi" }>;',
        'export type CanonicalPiAgentRuntimeDescriptorV1 = Readonly<{ providerId: "pi" }>;',
        'export function buildPiAgentRuntimeDescriptorV1(): PiAgentRuntimeDescriptorV1 { return { providerId: "pi" }; }',
        'export function readCanonicalPiAgentRuntimeDescriptorV1(): CanonicalPiAgentRuntimeDescriptorV1 { return { providerId: "pi" }; }',
        '',
      ].join('\n'),
    };
    const source = runtimeDescriptorSourceByAgentId[agentId];
    if (source) {
      mkdirSync(resolve(repoRoot, `packages/plugins/${pluginPackageId}/src/protocol`), { recursive: true });
      writeFileSync(
        resolve(repoRoot, `packages/plugins/${pluginPackageId}/src/protocol/runtimeDescriptorV1.ts`),
        source,
        'utf8',
      );
    }
  }
}

function writeProtocolProjectionFixture(
  repoRoot: string,
  pluginPackageId: string,
  fileName: string,
  sourceLines: readonly string[],
): void {
  mkdirSync(resolve(repoRoot, `packages/plugins/${pluginPackageId}/src/protocol`), { recursive: true });
  writeFileSync(
    resolve(repoRoot, `packages/plugins/${pluginPackageId}/src/protocol/${fileName}.ts`),
    `${sourceLines.join('\n')}\n`,
    'utf8',
  );
}

test('generateBundledPluginEntries writes deterministic bundled plugin contribution outputs', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-'));

  writeJson(resolve(repoRoot, 'packages/plugins/claude/package.json'), {
    name: '@happier-dev/plugins-claude',
    version: '0.0.0',
  });
  writeJson(resolve(repoRoot, 'packages/plugins/codex/package.json'), {
    name: '@happier-dev/plugins-codex',
    version: '0.0.0',
  });
  writeAgentPluginFixture(repoRoot, 'cursor');
  writeCursorUiDescriptorFixture(repoRoot);
  writeAgentPluginFixture(repoRoot, 'auggie');
  writeAuggieUiDescriptorFixture(repoRoot);
  writeAgentPluginFixture(repoRoot, 'kimi');
  writeKimiUiDescriptorFixture(repoRoot);

  mkdirSync(resolve(repoRoot, 'packages/plugins/claude/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/claude/src/manifest.ts'),
    pluginManifestSource({
      id: 'happier.agent.claude',
      capabilities: ['agents'],
      contributes: `{
    systemTools: [{
      toolId: "claude.macos.security",
      displayName: "macOS Keychain security",
      source: "system",
      lookupNames: ["security"],
      defaultArgs: [],
    }],
  }`,
    }),
    'utf8',
  );
  mkdirSync(resolve(repoRoot, 'packages/plugins/claude/src/agent'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/claude/src/agent/definition.ts'),
    [
      'export const AGENT_DEFINITION = Object.freeze({',
      '  id: "claude",',
      '  agentCliRuntime: {',
      '    id: "claude",',
      '    title: "Claude Code CLI",',
      '    binaryName: "claude",',
      '    sourcePreferenceDefault: "system-first",',
      '    managedInstall: null,',
      '    manualInstallKind: "vendor_recipe",',
      '    manualInstallRecipes: null,',
      '    acceptsJavaScriptFileOverride: true,',
      '  },',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  mkdirSync(resolve(repoRoot, 'packages/plugins/claude/src/agent/contributions'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/claude/src/agent/contributions/runtime.ts'),
    [
      'export const CLAUDE_PROVIDER_RUNTIME_CONTRIBUTION = Object.freeze({',
      '  agentId: "claude",',
      '  connectedServices: { serviceIds: ["claude-subscription"] },',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  writeClaudeUiDescriptorFixture(repoRoot);

  mkdirSync(resolve(repoRoot, 'packages/plugins/codex/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/codex/src/manifest.ts'),
    pluginManifestSource({ id: 'happier.agent.codex', capabilities: ['agents'] }),
    'utf8',
  );
  mkdirSync(resolve(repoRoot, 'packages/plugins/codex/src/agent'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/codex/src/agent/definition.ts'),
    [
      'export const AGENT_DEFINITION = Object.freeze({',
      '  id: "codex",',
      '  agentCliRuntime: {',
      '    id: "codex",',
      '    title: "codex CLI",',
      '    binaryName: "codex",',
      '    sourcePreferenceDefault: "system-first",',
      '    managedInstall: null,',
      '    manualInstallKind: "none",',
      '    manualInstallRecipes: null,',
      '    acceptsJavaScriptFileOverride: false,',
      '  },',
      '  runtimeContributions: {',
      '    providerCatalogEntry: { importName: "CODEX_PROVIDER_RUNTIME_CONTRIBUTION", source: "./agent/contributions/runtime" },',
      '    externalSessionHostAdapters: {',
      '      kind: "providerExternalSessionHostAdaptersV1",',
      '      providerId: "codex",',
      '      candidateHostAdapter: { source: "@/backends/codex/appServer/session/externalCandidates", exportName: "createCodexExternalSessionCandidateHostAdapter" },',
      '      transcriptStoreAdapter: { source: "@/backends/codex/rollout/sessionStore/externalTranscriptAdapter", exportName: "createCodexExternalSessionTranscriptStoreAdapter" },',
      '    },',
      '  },',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  mkdirSync(resolve(repoRoot, 'packages/plugins/codex/src/agent/contributions'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/codex/src/agent/contributions/runtime.ts'),
    'export const CODEX_PROVIDER_RUNTIME_CONTRIBUTION = Object.freeze({ agentId: "codex" });\n',
    'utf8',
  );
  writeCodexUiDescriptorFixture(repoRoot);

  writeGeneratorOutputScaffold(
    repoRoot,
    [
      'export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: readonly string[] = Object.freeze([]);',
      'export const SOME_OTHER_EXPORT = 123;',
      '',
    ].join('\n'),
  );

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const cliOut = readFileSync(
    resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPlugins.ts'),
    'utf8',
  );
  assert.match(cliOut, /BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES/);
  assert.match(cliOut, /BUNDLED_FIRST_PARTY_PROVIDER_CONTRIBUTIONS/);
  assert.match(cliOut, /BUNDLED_FIRST_PARTY_BACKEND_CONTRIBUTIONS/);
  assert.match(cliOut, /BUNDLED_FIRST_PARTY_ACTIVATION_TARGETS/);
  assert.match(cliOut, /import \{ CLAUDE_PROVIDER_RUNTIME_CONTRIBUTION \} from '@happier-dev\/plugins-claude\/agent\/contributions\/runtime';/);
  assert.match(
    cliOut,
    /import \{ createCodexExternalSessionCandidateHostAdapter as CODEX_EXTERNAL_SESSION_CREATE_CANDIDATE_HOST_ADAPTER \} from '@\/backends\/codex\/appServer\/session\/externalCandidates';/,
  );
  assert.match(
    cliOut,
    /import \{ createCodexExternalSessionTranscriptStoreAdapter as CODEX_EXTERNAL_SESSION_CREATE_TRANSCRIPT_STORE_ADAPTER \} from '@\/backends\/codex\/rollout\/sessionStore\/externalTranscriptAdapter';/,
  );
  assert.doesNotMatch(cliOut, /from '@happier-dev\/agents'/);
  assert.doesNotMatch(cliOut, /getAllProviderDefinitionContracts|getAllBackendDefinitions|getProviderDefinition|getProviderCliRuntimeSpec/);
  assert.match(cliOut, /ProviderCliRuntimeDescriptor/);
  assert.match(cliOut, /BUNDLED_FIRST_PARTY_AGENT_CLI_RUNTIME_SPECS_BY_ID/);
  assert.match(cliOut, /codex:\s*Object\.freeze/);
  assert.match(cliOut, /claude:\s*createProviderRuntimeCatalogEntryHooks/);
  assert.match(cliOut, /"title":\s*"codex CLI"/);
  assert.match(cliOut, /runtimeSpec:\s*readBundledFirstPartyAgentCliRuntimeSpec\("codex"\)/);
  assert.doesNotMatch(cliOut, /runtimeSpec:\s*getProviderCliRuntimeSpec/);
  assert.match(
    cliOut,
    /codex:\s*createProviderRuntimeCatalogEntryHooks\(\{[\s\S]*contribution:\s*\{[\s\S]*\.\.\.CODEX_PROVIDER_RUNTIME_CONTRIBUTION,[\s\S]*externalSessions:\s*\{[\s\S]*createCandidateHostAdapter:\s*CODEX_EXTERNAL_SESSION_CREATE_CANDIDATE_HOST_ADAPTER,[\s\S]*createTranscriptStoreAdapter:\s*CODEX_EXTERNAL_SESSION_CREATE_TRANSCRIPT_STORE_ADAPTER,/,
  );
  assert.match(
    cliOut,
    /claude:\s*createProviderRuntimeCatalogEntryHooks\(\{[\s\S]*systemTools:\s*Object\.freeze\(\[[\s\S]*"toolId":\s*"claude\.macos\.security"/,
  );
  assert.match(
    cliOut,
    /BUNDLED_FIRST_PARTY_ACTIVATION_TARGETS[\s\S]{0,220}provenance:\s*'first_party'/,
  );
  assert.match(cliOut, /BUNDLED_FIRST_PARTY_SCM_HOSTING_PROVIDER_CONTRIBUTIONS/);
  assert.match(cliOut, /@happier-dev\/plugins-claude/);
  assert.match(cliOut, /@happier-dev\/plugins-codex/);
  assert.ok(
    cliOut.indexOf('@happier-dev/plugins-claude') < cliOut.indexOf('@happier-dev/plugins-codex'),
    'expected lexical order',
  );

  const uiOut = readFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts'),
    'utf8',
  );
  assert.doesNotMatch(uiOut, /SOME_OTHER_EXPORT/);
  assert.doesNotMatch(uiOut, /maintained in-place/);
  assert.match(uiOut, /This file is emitted by:/);
  assert.match(uiOut, /BUNDLED_CANONICAL_AGENTS_CORE/);
  assertNoExecutableUiProjectionImports(uiOut);
  assert.doesNotMatch(uiOut, /@\/agents\/providers\/auggie\/core/);
  assert.doesNotMatch(uiOut, /@\/agents\/providers\/auggie\/ui/);
  assert.doesNotMatch(uiOut, /@\/agents\/providers\/qwen\/core/);
  assert.doesNotMatch(uiOut, /@\/agents\/providers\/qwen\/ui/);
  assert.doesNotMatch(uiOut, /@\/agents\/providers\/kimi\/core/);
  assert.doesNotMatch(uiOut, /@\/agents\/providers\/kimi\/ui/);
  assert.doesNotMatch(uiOut, /@\/agents\/providers\/cursor\/core/);
  assert.doesNotMatch(uiOut, /@\/agents\/providers\/cursor\/ui/);
  assert.match(uiOut, /const CURSOR_CORE: AgentCoreConfig/);
  assert.match(uiOut, /runtimeInput:\s*\{\s*inFlightSteerSupported:\s*true,\s*\}/);
  assert.match(uiOut, /cursor:\s*CURSOR_CORE/);
  assert.match(uiOut, /cursor:\s*CURSOR_UI/);
  assert.match(uiOut, /const AUGGIE_CORE: AgentCoreConfig/);
  assert.match(uiOut, /auggie:\s*AUGGIE_CORE/);
  assert.match(uiOut, /auggie:\s*AUGGIE_UI/);
  assert.match(uiOut, /const QWEN_CORE: AgentCoreConfig/);
  assert.match(uiOut, /hideUnknownToolsByDefault:\s*true/);
  assert.match(uiOut, /qwen:\s*QWEN_CORE/);
  assert.match(uiOut, /qwen:\s*QWEN_UI/);
  assert.match(uiOut, /const KIMI_CORE: AgentCoreConfig/);
  assert.match(uiOut, /kimi:\s*KIMI_CORE/);
  assert.match(uiOut, /kimi:\s*KIMI_UI/);

  const uiBehaviorOverridesOut = readFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.uiBehaviorOverrides.ts'),
    'utf8',
  );
  assertNoExecutableUiProjectionImports(uiBehaviorOverridesOut);
  assert.match(uiBehaviorOverridesOut, /BUNDLED_CANONICAL_AGENT_UI_BEHAVIOR_OVERRIDES/);
  assert.match(uiBehaviorOverridesOut, /BUNDLED_CANONICAL_AGENT_UI_BEHAVIOR_DESCRIPTORS/);
  assert.match(uiBehaviorOverridesOut, /claude\.uiBehavior\.v1/);
  assert.match(uiBehaviorOverridesOut, /auggie\.uiBehavior\.v1/);

  const sessionProviderBehaviorsOut = readFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.sessionProviderBehaviors.ts'),
    'utf8',
  );
  assertNoExecutableUiProjectionImports(sessionProviderBehaviorsOut);
  assert.match(sessionProviderBehaviorsOut, /BUNDLED_CANONICAL_AGENT_SESSION_PROVIDER_BEHAVIORS/);
  assert.match(sessionProviderBehaviorsOut, /BUNDLED_CANONICAL_AGENT_SESSION_PROVIDER_BEHAVIOR_DESCRIPTORS/);
  assert.match(sessionProviderBehaviorsOut, /claude\.sessionProviderBehavior\.v1/);

  const messageMetaOverridesOut = readFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.messageMetaOverrides.ts'),
    'utf8',
  );
  assertNoExecutableUiProjectionImports(messageMetaOverridesOut);
  assert.match(messageMetaOverridesOut, /BUNDLED_PROVIDER_MESSAGE_META_OVERRIDE_BUILDERS/);
  assert.match(messageMetaOverridesOut, /BUNDLED_PROVIDER_MESSAGE_META_OVERRIDE_DESCRIPTORS/);
  assert.match(messageMetaOverridesOut, /metaOverrides/);
  assert.match(messageMetaOverridesOut, /reasoning_effort/);

  const providerSettingsOut = readFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.providerSettings.ts'),
    'utf8',
  );
  assertNoExecutableUiProjectionImports(providerSettingsOut);
  assert.match(providerSettingsOut, /BUNDLED_PROVIDER_SETTINGS_PLUGINS/);
  assert.match(providerSettingsOut, /BUNDLED_PROVIDER_SETTINGS_DESCRIPTORS/);
  assert.match(providerSettingsOut, /claude\.providerSettings\.v1/);
  assert.match(providerSettingsOut, /auggie\.providerSettings\.v1/);
  assert.match(providerSettingsOut, /kimi\.providerSettings\.v1/);

  const visibleMessageResolversOut = readFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.visibleMessageResolvers.ts'),
    'utf8',
  );
  assertNoExecutableUiProjectionImports(visibleMessageResolversOut);
  assert.match(visibleMessageResolversOut, /BUNDLED_SESSION_SUBAGENT_VISIBLE_MESSAGE_REGISTRY/);
  assert.match(visibleMessageResolversOut, /BUNDLED_SESSION_SUBAGENT_VISIBLE_MESSAGE_DESCRIPTORS/);
  assert.match(visibleMessageResolversOut, /session\.visibleMessages\.v1/);
  assert.match(visibleMessageResolversOut, /idle_notification/);

  const agentsOut = readFileSync(
    resolve(repoRoot, 'packages/agents/src/generated/bundledAgentDefinitions.ts'),
    'utf8',
  );
  assert.match(agentsOut, /BUNDLED_AGENT_DEFINITION_IDS/);
  assert.match(agentsOut, /BUNDLED_AGENT_DEFINITIONS_BY_ID/);
  assert.match(agentsOut, /\bbundledAgentDefinitions\b/);
  assert.match(agentsOut, /"claude":\s*Object\.freeze\(\(\{/);
  assert.match(agentsOut, /\}\) as const\),\n\s+"codex":/);
  assert.match(agentsOut, /"claude":\s*Object\.freeze\(/);
  assert.match(agentsOut, /"codex":\s*Object\.freeze\(/);
  assert.match(agentsOut, /"id":\s*"claude"/);
  assert.match(agentsOut, /"id":\s*"codex"/);
  const claudeBlock = readGeneratedAgentBlock(agentsOut, 'claude', 'codex');
  const codexBlock = readGeneratedAgentBlock(agentsOut, 'codex', 'cursor');
  const cursorBlock = readGeneratedAgentBlock(agentsOut, 'cursor');
  assert.match(claudeBlock, /"agentCliRuntime":/);
  assert.doesNotMatch(claudeBlock, /"providerCliRuntime":/);
  assert.match(codexBlock, /"agentCliRuntime":/);
  assert.doesNotMatch(codexBlock, /"providerCliRuntime":/);
  assert.match(cursorBlock, /"agentCliRuntime":/);
  assert.doesNotMatch(cursorBlock, /"providerCliRuntime":/);

  const agentProviderIdsOut = readGeneratedAgentProviderIdsOutput(repoRoot);
  assert.match(agentProviderIdsOut, /export const AGENT_PROVIDER_IDS/);
  assert.match(agentProviderIdsOut, /export type AgentProviderId/);
  assert.match(agentProviderIdsOut, /export function isAgentProviderId/);
  const agentProviderIds = readGeneratedStringArray(agentProviderIdsOut, 'AGENT_PROVIDER_IDS');
  assert.ok(agentProviderIds.includes('gemini'));
  assert.ok(agentProviderIds.includes('auggie'));
  assert.ok(agentProviderIds.includes('copilot'));
  assert.ok(
    agentProviderIds.indexOf('claude') < agentProviderIds.indexOf('codex')
      && agentProviderIds.indexOf('codex') < agentProviderIds.indexOf('cursor'),
    'expected generated ids to follow canonical runtime order',
  );

  const protocolAgentProviderIdsOut = readGeneratedProtocolAgentProviderIdsOutput(repoRoot);
  assert.match(protocolAgentProviderIdsOut, /GENERATED FILE CONTRACT \(A\.X-agent-ids-codegen\)/);
  assert.match(protocolAgentProviderIdsOut, /export const AGENT_PROVIDER_IDS_V1/);
  assert.match(protocolAgentProviderIdsOut, /export const AgentProviderIdV1Schema/);
  assert.deepEqual(readGeneratedStringArray(protocolAgentProviderIdsOut, 'AGENT_PROVIDER_IDS_V1'), [
    'claude',
    'codex',
    'opencode',
    'pi',
    'ohMyPi',
  ]);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);
});

test('generateBundledPluginEntries check mode rejects generated agent provider id drift', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-agent-ids-check-'));
  writeAgentPluginFixture(repoRoot, 'qwen');
  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const agentProviderIdsOutPath = resolve(repoRoot, 'packages/agents/src/generated/agentProviderIds.ts');
  writeFileSync(agentProviderIdsOutPath, 'export const AGENT_PROVIDER_IDS = Object.freeze([]);\n', 'utf8');

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'check']),
    /generated output differs: .*agentProviderIds\.ts/,
  );
});

test('generateBundledPluginEntries check mode rejects protocol agent provider id drift', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-protocol-agent-ids-check-'));
  writeAgentPluginFixture(repoRoot, 'qwen');
  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const agentProviderIdsOutPath = resolve(repoRoot, 'packages/protocol/src/providers/agentProviderIdsV1.ts');
  writeFileSync(agentProviderIdsOutPath, 'export const AGENT_PROVIDER_IDS_V1 = Object.freeze([] as const);\n', 'utf8');

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'check']),
    /generated output differs: .*agentProviderIdsV1\.ts/,
  );
});

test('generateBundledPluginEntries emits runtime contribution seams into package-local generated artifacts', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-pi-runtime-contributions-'));
  writeRuntimeContributionPluginFixture(repoRoot, 'codex', 'codex', [
    'sessionControlAdapter: { kind: "providerSessionControlAdapter", providerId: "codex", source: "./agent/surfaces/sessions/controls/adapter", exportName: "CODEX_SESSION_CONTROL_ADAPTER" },',
    'runtimeDescriptorReader: { kind: "providerRuntimeDescriptorReader", providerId: "codex", source: "./agent/identity/runtimeDescriptor", exportName: "readCodexSessionMetadataRuntimeDescriptor" },',
    'protocolRuntimeDescriptor: { kind: "providerRuntimeDescriptorV1", providerId: "codex", source: "./protocol/runtimeDescriptorV1", buildFunction: "buildCodexAgentRuntimeDescriptorV1", canonicalReader: "readCanonicalCodexAgentRuntimeDescriptorV1" },',
  ]);
  writeRuntimeContributionPluginFixture(repoRoot, 'opencode', 'opencode', [
    'sessionControlAdapter: { kind: "providerSessionControlAdapter", providerId: "opencode", source: "./agent/surfaces/sessions/controls/adapter", exportName: "OPENCODE_SESSION_CONTROL_ADAPTER" },',
    'runtimeDescriptorReader: { kind: "providerRuntimeDescriptorReader", providerId: "opencode", source: "./agent/identity/runtimeDescriptor", exportName: "readOpenCodeSessionMetadataRuntimeDescriptor" },',
    'protocolRuntimeDescriptor: { kind: "providerRuntimeDescriptorV1", providerId: "opencode", source: "./protocol/runtimeDescriptorV1", buildFunction: "buildOpenCodeAgentRuntimeDescriptorV1", canonicalReader: "readCanonicalOpenCodeAgentRuntimeDescriptorV1" },',
  ]);
  writeCodexUiDescriptorFixture(repoRoot);
  writeOpenCodeUiDescriptorFixture(repoRoot);
  writePiContributionPluginFixture(repoRoot);
  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const sessionControlAdaptersOut = readGeneratedSessionControlAdaptersOutput(repoRoot);
  assert.match(sessionControlAdaptersOut, /GENERATED FILE CONTRACT \(A\.16y\.3-provider-session-control-and-runtime-descriptor-projections\)/);
  assert.doesNotMatch(sessionControlAdaptersOut, /E\.10-pi-runtime-contribution-seam/);
  assert.match(sessionControlAdaptersOut, /GENERATED_PROVIDER_SESSION_CONTROL_ADAPTERS/);
  assert.doesNotMatch(sessionControlAdaptersOut, /@happier-dev\/plugins-/);
  assert.match(sessionControlAdaptersOut, /import \{ CODEX_SESSION_CONTROL_ADAPTER \} from '\.\.\/providers\/codex\/sessionControlAdapter\.js';/);
  assert.match(sessionControlAdaptersOut, /import \{ OPENCODE_SESSION_CONTROL_ADAPTER \} from '\.\.\/providers\/opencode\/sessionControlAdapter\.js';/);
  assert.match(sessionControlAdaptersOut, /codex: CODEX_SESSION_CONTROL_ADAPTER,/);
  assert.match(sessionControlAdaptersOut, /opencode: OPENCODE_SESSION_CONTROL_ADAPTER,/);
  assert.match(sessionControlAdaptersOut, /providerId:\s*'pi'/);
  assert.match(sessionControlAdaptersOut, /absolutePathField:\s*'sessionFile'/);
  assert.doesNotMatch(sessionControlAdaptersOut, /PI_SESSION_CONTROL_ADAPTER/);

  const runtimeDescriptorReadersOut = readGeneratedRuntimeDescriptorReadersOutput(repoRoot);
  assert.match(runtimeDescriptorReadersOut, /GENERATED FILE CONTRACT \(A\.16y\.3-provider-session-control-and-runtime-descriptor-projections\)/);
  assert.doesNotMatch(runtimeDescriptorReadersOut, /E\.10-pi-runtime-contribution-seam/);
  assert.match(runtimeDescriptorReadersOut, /GENERATED_RUNTIME_DESCRIPTOR_READERS/);
  assert.doesNotMatch(runtimeDescriptorReadersOut, /@happier-dev\/plugins-/);
  assert.match(runtimeDescriptorReadersOut, /import \{ readCodexSessionMetadataRuntimeDescriptor \} from '\.\.\/providers\/codex\/readSessionMetadataRuntimeDescriptor\.js';/);
  assert.match(runtimeDescriptorReadersOut, /import \{ readOpenCodeSessionMetadataRuntimeDescriptor \} from '\.\.\/providers\/opencode\/readSessionMetadataRuntimeDescriptor\.js';/);
  assert.match(runtimeDescriptorReadersOut, /codex: readCodexSessionMetadataRuntimeDescriptor,/);
  assert.match(runtimeDescriptorReadersOut, /opencode: readOpenCodeSessionMetadataRuntimeDescriptor,/);
  assert.match(runtimeDescriptorReadersOut, /providerId:\s*'pi'/);
  assert.match(runtimeDescriptorReadersOut, /runtimeHandle:\s*'providerSessionId'/);
  assert.doesNotMatch(runtimeDescriptorReadersOut, /readPiSessionMetadataRuntimeDescriptor/);

  const protocolRuntimeDescriptorContributionsOut = readGeneratedProtocolRuntimeDescriptorContributionsOutput(repoRoot);
  assert.match(protocolRuntimeDescriptorContributionsOut, /GENERATED FILE CONTRACT \(A\.16y\.3-provider-session-control-and-runtime-descriptor-projections\)/);
  assert.match(protocolRuntimeDescriptorContributionsOut, /GENERATED FILE CONTRACT \(A\.16y\.6-runtime-descriptor-protocol-abi-codegen\)/);
  assert.doesNotMatch(protocolRuntimeDescriptorContributionsOut, /E\.10-pi-runtime-contribution-seam/);
  assert.match(protocolRuntimeDescriptorContributionsOut, /GENERATED_RUNTIME_DESCRIPTOR_CONTRIBUTIONS_V1/);
  assert.match(protocolRuntimeDescriptorContributionsOut, /import \{[\s\S]*buildCodexAgentRuntimeDescriptorV1[\s\S]*\} from '\.\/generated\/runtime\/descriptors\/codex\.js';/);
  assert.match(protocolRuntimeDescriptorContributionsOut, /import \{[\s\S]*buildOpenCodeAgentRuntimeDescriptorV1[\s\S]*\} from '\.\/generated\/runtime\/descriptors\/opencode\.js';/);
  assert.match(protocolRuntimeDescriptorContributionsOut, /import \{[\s\S]*buildPiAgentRuntimeDescriptorV1[\s\S]*\} from '\.\/generated\/runtime\/descriptors\/pi\.js';/);
  assert.doesNotMatch(protocolRuntimeDescriptorContributionsOut, /\.\/(?:codex|opencode|pi)\/runtimeDescriptorV1\.js/);
  assert.doesNotMatch(protocolRuntimeDescriptorContributionsOut, /@happier-dev\/plugins-/);
  assert.match(protocolRuntimeDescriptorContributionsOut, /providerId:\s*'pi'/);
  assert.match(protocolRuntimeDescriptorContributionsOut, /readCanonicalPiAgentRuntimeDescriptorV1/);
  assert.doesNotMatch(protocolRuntimeDescriptorContributionsOut, /hardcoded Codex/);

  const codexRuntimeDescriptorOut = readGeneratedProtocolRuntimeDescriptorModuleOutput(repoRoot, 'codex');
  assert.match(codexRuntimeDescriptorOut, /buildCodexAgentRuntimeDescriptorV1/);
  assert.match(codexRuntimeDescriptorOut, /readCanonicalCodexAgentRuntimeDescriptorV1/);
  assert.doesNotMatch(codexRuntimeDescriptorOut, /@happier-dev\/plugins-/);

  const openCodeRuntimeDescriptorOut = readGeneratedProtocolRuntimeDescriptorModuleOutput(repoRoot, 'opencode');
  assert.match(openCodeRuntimeDescriptorOut, /buildOpenCodeAgentRuntimeDescriptorV1/);
  assert.match(openCodeRuntimeDescriptorOut, /readCanonicalOpenCodeAgentRuntimeDescriptorV1/);
  assert.doesNotMatch(openCodeRuntimeDescriptorOut, /@happier-dev\/plugins-/);

  const piRuntimeDescriptorOut = readGeneratedProtocolRuntimeDescriptorModuleOutput(repoRoot, 'pi');
  assert.match(piRuntimeDescriptorOut, /buildPiAgentRuntimeDescriptorV1/);
  assert.match(piRuntimeDescriptorOut, /readCanonicalPiAgentRuntimeDescriptorV1/);
  assert.doesNotMatch(piRuntimeDescriptorOut, /@happier-dev\/plugins-/);

  const promptAssetPluginDescriptorsOut = readGeneratedPromptAssetPluginDescriptorsOutput(repoRoot);
  assert.match(promptAssetPluginDescriptorsOut, /BUNDLED_FIRST_PARTY_PLUGIN_PROMPT_ASSET_DESCRIPTORS/);
  assert.doesNotMatch(promptAssetPluginDescriptorsOut, /@happier-dev\/plugins-claude\/agent';/);
  assert.doesNotMatch(promptAssetPluginDescriptorsOut, /@happier-dev\/plugins-copilot';/);
  assert.doesNotMatch(promptAssetPluginDescriptorsOut, /@\/backends\/gemini\/promptAssets/);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'check']);

  const codexRuntimeDescriptorOutPath = resolve(repoRoot, 'packages/protocol/src/providers/generated/runtime/descriptors/codex.ts');
  writeFileSync(codexRuntimeDescriptorOutPath, 'export const stale = true;\n', 'utf8');
  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'check']),
    /generated output differs: .*generated\/runtime\/descriptors\/codex\.ts/,
  );
});

test('generateBundledPluginEntries emits protocol provider defaults and external-session sources', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-protocol-provider-defaults-'));
  writeRuntimeContributionPluginFixture(repoRoot, 'claude', 'claude', [
    'protocolBuiltInBackendProfiles: { kind: "providerBuiltInBackendProfilesV1", providerId: "claude", source: "./protocol/profiles", exportName: "CLAUDE_BUILT_IN_BACKEND_PROFILES" },',
    'protocolMemoryDefaults: { kind: "providerMemoryDefaultsV1", providerId: "claude", source: "./protocol/memory", exportName: "CLAUDE_MEMORY_DEFAULTS" },',
    'protocolExternalSessionSource: { kind: "providerExternalSessionSourceV1", providerId: "claude", source: "./protocol/externalSession", exportName: "CLAUDE_EXTERNAL_SESSION_SOURCE" },',
  ]);
  writeRuntimeContributionPluginFixture(repoRoot, 'codex', 'codex', [
    'protocolBuiltInBackendProfiles: { kind: "providerBuiltInBackendProfilesV1", providerId: "codex", source: "./protocol/profiles", exportName: "CODEX_BUILT_IN_BACKEND_PROFILES" },',
    'protocolExternalSessionSource: { kind: "providerExternalSessionSourceV1", providerId: "codex", source: "./protocol/externalSession", exportName: "CODEX_EXTERNAL_SESSION_SOURCE" },',
  ]);
  writeProtocolProjectionFixture(repoRoot, 'claude', 'profiles', [
    'export const CLAUDE_BUILT_IN_BACKEND_PROFILES = Object.freeze([',
    '  {',
    '    id: "anthropic",',
    '    name: "Anthropic (Default)",',
    '    authMode: "machineLogin",',
    '    requiresMachineLoginTargetKey: "agent:claude",',
    '    environmentVariables: [],',
    '    envVarRequirements: [],',
    '    defaultPermissionModeByTargetKey: { "agent:claude": "default" },',
    '    defaultPermissionModeByAgent: {},',
    '    defaultPersistenceModeByTargetKey: {},',
    '    defaultPersistenceModeByAgent: {},',
    '    compatibilityByTargetKey: { "agent:claude": true, "agent:codex": false },',
    '    compatibility: {},',
    '    isBuiltIn: true,',
    '    defaultEnabled: true,',
    '    createdAt: 0,',
    '    updatedAt: 0,',
    '    version: "1.0.0",',
    '  },',
    ']);',
  ]);
  writeProtocolProjectionFixture(repoRoot, 'claude', 'memory', [
    'export const CLAUDE_MEMORY_DEFAULTS = Object.freeze({',
    '  summarizerBackendId: "claude",',
    '});',
  ]);
  writeProtocolProjectionFixture(repoRoot, 'claude', 'externalSession', [
    'export const CLAUDE_EXTERNAL_SESSION_SOURCE = Object.freeze({',
    '  providerId: "claude",',
    '  sourceKind: "claudeConfig",',
    '  schema: {',
    '    passthrough: true,',
    '    fields: [',
    '      { name: "kind", kind: "literal", value: "claudeConfig" },',
    '      { name: "configDir", kind: "string", min: 1, max: 10000, nullish: true },',
    '      { name: "projectId", kind: "string", min: 1, max: 2000, nullish: true },',
    '    ],',
    '  },',
    '  key: {',
    '    segments: [',
    '      { kind: "literal", value: "claudeConfig" },',
    '      { kind: "field", field: "configDir" },',
    '      { kind: "field", field: "projectId" },',
    '    ],',
    '  },',
    '});',
  ]);
  writeProtocolProjectionFixture(repoRoot, 'codex', 'profiles', [
    'export const CODEX_BUILT_IN_BACKEND_PROFILES = Object.freeze([',
    '  {',
    '    id: "codex",',
    '    name: "Codex (Default)",',
    '    authMode: "machineLogin",',
    '    requiresMachineLoginTargetKey: "agent:codex",',
    '    environmentVariables: [],',
    '    envVarRequirements: [],',
    '    defaultPermissionModeByTargetKey: { "agent:codex": "default" },',
    '    defaultPermissionModeByAgent: {},',
    '    defaultPersistenceModeByTargetKey: {},',
    '    defaultPersistenceModeByAgent: {},',
    '    compatibilityByTargetKey: { "agent:claude": false, "agent:codex": true },',
    '    compatibility: {},',
    '    isBuiltIn: true,',
    '    defaultEnabled: true,',
    '    createdAt: 0,',
    '    updatedAt: 0,',
    '    version: "1.0.0",',
    '  },',
    ']);',
  ]);
  writeProtocolProjectionFixture(repoRoot, 'codex', 'externalSession', [
    'export const CODEX_EXTERNAL_SESSION_SOURCE = Object.freeze({',
    '  providerId: "codex",',
    '  sourceKind: "codexHome",',
    '  schema: {',
    '    passthrough: true,',
    '    fields: [',
    '      { name: "kind", kind: "literal", value: "codexHome" },',
    '      { name: "home", kind: "enum", values: ["user", "connectedService"] },',
    '      { name: "homePath", kind: "string", min: 1, optional: true },',
    '      { name: "connectedServiceId", kind: "string", min: 1, optional: true },',
    '      { name: "connectedServiceProfileId", kind: "string", min: 1, optional: true },',
    '      { name: "connectedServiceGroupId", kind: "string", min: 1, optional: true },',
    '    ],',
    '    refinements: [',
    '      { kind: "requiresWhenEquals", field: "connectedServiceId", when: { field: "home", equals: "connectedService" } },',
    '      { kind: "forbidsWhenEquals", fields: ["connectedServiceId", "connectedServiceProfileId", "connectedServiceGroupId"], when: { field: "home", equals: "user" } },',
    '    ],',
    '  },',
    '  key: {',
    '    segments: [',
    '      { kind: "literal", value: "codexHome" },',
    '      { kind: "homeMode", field: "home" },',
    '      { kind: "conditionalField", field: "connectedServiceId", when: { field: "home", equals: "connectedService" } },',
    '      { kind: "connectedServiceScope", groupField: "connectedServiceGroupId", profileField: "connectedServiceProfileId", when: { field: "home", equals: "connectedService" } },',
    '      { kind: "field", field: "homePath" },',
    '    ],',
    '  },',
    '});',
  ]);
  writeCodexUiDescriptorFixture(repoRoot);
  writeClaudeUiDescriptorFixture(repoRoot);
  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const profilesOut = readGeneratedProtocolBuiltInBackendProfilesOutput(repoRoot);
  assert.match(profilesOut, /GENERATED FILE CONTRACT \(A\.16y\.7-protocol-provider-default-and-source-projection\)/);
  assert.match(profilesOut, /GENERATED_BUILT_IN_BACKEND_PROFILES/);
  assert.match(profilesOut, /"id":\s*"anthropic"/);
  assert.match(profilesOut, /"id":\s*"codex"/);
  assert.doesNotMatch(profilesOut, /@happier-dev\/plugins-/);
  assert.doesNotMatch(profilesOut, /providers\/(?:claude|codex)\/builtInBackendProfiles/);

  const memoryOut = readGeneratedProtocolMemoryDefaultsOutput(repoRoot);
  assert.match(memoryOut, /GENERATED_MEMORY_SUMMARIZER_BACKEND_ID = 'claude'/);
  assert.doesNotMatch(memoryOut, /@happier-dev\/plugins-/);
  assert.doesNotMatch(memoryOut, /providers\/claude\/memoryDefaults/);

  const externalSessionOut = readGeneratedProtocolExternalSessionSourcesOutput(repoRoot);
  assert.match(externalSessionOut, /GENERATED_EXTERNAL_SESSIONS_SOURCE_DECLARATIONS/);
  assert.match(externalSessionOut, /"sourceKind":\s*"claudeConfig"/);
  assert.match(externalSessionOut, /"sourceKind":\s*"codexHome"/);
  assert.doesNotMatch(externalSessionOut, /from 'zod'/);
  assert.doesNotMatch(externalSessionOut, /function resolve/);
  assert.doesNotMatch(externalSessionOut, /sourceSchema:/);
  assert.doesNotMatch(externalSessionOut, /@happier-dev\/plugins-/);
  assert.doesNotMatch(externalSessionOut, /providers\/(?:claude|codex)\/externalSessions/);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'check']);

  const externalSessionOutPath = resolve(repoRoot, 'packages/protocol/src/providers/generated/externalSession/sources.ts');
  writeFileSync(externalSessionOutPath, 'export const stale = true;\n', 'utf8');
  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'check']),
    /generated output differs: .*generated\/externalSession\/sources\.ts/,
  );
});

test('generateBundledPluginEntries requires first-party protocol runtime descriptor sources', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-require-protocol-runtime-source-'));
  writeRuntimeContributionPluginFixture(repoRoot, 'codex', 'codex', [
    'protocolRuntimeDescriptor: { kind: "providerRuntimeDescriptorV1", providerId: "codex", buildFunction: "buildCodexAgentRuntimeDescriptorV1", canonicalReader: "readCanonicalCodexAgentRuntimeDescriptorV1" },',
  ]);
  writeCodexUiDescriptorFixture(repoRoot);
  writeGeneratorOutputScaffold(repoRoot);

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']),
    /protocolRuntimeDescriptor\.source/,
  );
});

test('generateBundledPluginEntries rejects non-hermetic protocol runtime descriptor imports', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-reject-protocol-runtime-imports-'));
  writeRuntimeContributionPluginFixture(repoRoot, 'codex', 'codex', [
    'protocolRuntimeDescriptor: { kind: "providerRuntimeDescriptorV1", providerId: "codex", source: "./protocol/runtimeDescriptorV1", buildFunction: "buildCodexAgentRuntimeDescriptorV1", canonicalReader: "readCanonicalCodexAgentRuntimeDescriptorV1" },',
  ]);
  writeCodexUiDescriptorFixture(repoRoot);
  writeGeneratorOutputScaffold(repoRoot);

  const descriptorPath = resolve(repoRoot, 'packages/plugins/codex/src/protocol/runtimeDescriptorV1.ts');
  const descriptorBody = [
    'export type CodexAgentRuntimeDescriptorV1 = Readonly<{ providerId: "codex" }>;',
    'export type CanonicalCodexAgentRuntimeDescriptorV1 = Readonly<{ providerId: "codex" }>;',
    'export function buildCodexAgentRuntimeDescriptorV1(): CodexAgentRuntimeDescriptorV1 { return { providerId: "codex" }; }',
    'export function readCanonicalCodexAgentRuntimeDescriptorV1(): CanonicalCodexAgentRuntimeDescriptorV1 { return { providerId: "codex" }; }',
    '',
  ].join('\n');

  writeFileSync(descriptorPath, `import './shared.js';\n${descriptorBody}`, 'utf8');
  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']),
    /generated protocol modules cannot preserve relative imports/,
  );

  writeFileSync(
    descriptorPath,
    `const pluginDescriptorImport = import('@happier-dev/plugins-codex/protocol/runtimeDescriptorV1');\n${descriptorBody}`,
    'utf8',
  );
  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']),
    /generated protocol module would import forbidden @happier-dev\/plugins-codex\/protocol\/runtimeDescriptorV1/,
  );
});

test('generateBundledPluginEntries rejects first-party providerCliRuntime source contracts', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-reject-provider-cli-runtime-'));
  writeAgentPluginFixture(repoRoot, 'codex');
  writeCodexUiDescriptorFixture(repoRoot);
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/codex/src/agent/definition.ts'),
    [
      'export const AGENT_DEFINITION = Object.freeze({',
      '  id: "codex",',
      '  providerCliRuntime: {',
      '    id: "codex",',
      '    title: "codex CLI",',
      '    binaryName: "codex",',
      '    sourcePreferenceDefault: "system-first",',
      '    managedInstall: null,',
      '    manualInstallKind: "none",',
      '    manualInstallRecipes: null,',
      '    acceptsJavaScriptFileOverride: false,',
      '  },',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  writeGeneratorOutputScaffold(repoRoot);

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']),
    /AGENT_DEFINITION\.providerCliRuntime.*agentCliRuntime/i,
  );
});

test('generateBundledPluginEntries emits narrow plugin prompt asset descriptors and checks drift', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-prompt-assets-check-'));
  writeAgentPluginFixture(repoRoot, 'claude');
  writeClaudeUiDescriptorFixture(repoRoot);
  mkdirSync(resolve(repoRoot, 'packages/plugins/claude/src/agent/promptAssets'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/claude/src/agent/promptAssets/index.ts'),
    [
      'export const PLUGIN_PROMPT_ASSET_DESCRIPTORS = Object.freeze([',
      '  {',
      '    adapterKind: "skillMd",',
      '    assetTypeId: "claude.skill",',
      '    providerId: "claude",',
      '    title: "Claude skills",',
      '    description: "Claude skill bundles.",',
      '    projectRootPath: [".claude", "skills"],',
      '    projectRootDisplayPath: ".claude/skills",',
      '    userRootPath: [".claude", "skills"],',
      '    userRootDisplayPath: "~/.claude/skills",',
      '  },',
      ']);',
      '',
    ].join('\n'),
    'utf8',
  );
  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const promptAssetDescriptorsOut = readGeneratedPromptAssetPluginDescriptorsOutput(repoRoot);
  assert.match(promptAssetDescriptorsOut, /BUNDLED_FIRST_PARTY_PLUGIN_PROMPT_ASSET_DESCRIPTORS/);
  assert.match(
    promptAssetDescriptorsOut,
    /from '@happier-dev\/plugins-claude\/agent\/promptAssets';/,
  );
  assert.doesNotMatch(promptAssetDescriptorsOut, /@happier-dev\/plugins-claude\/agent';/);

  const promptAssetDescriptorsOutPath = resolve(repoRoot, 'apps/cli/src/prompts/assets/generated/pluginDescriptors.ts');
  writeFileSync(promptAssetDescriptorsOutPath, 'export const BUNDLED_FIRST_PARTY_PLUGIN_PROMPT_ASSET_DESCRIPTORS = Object.freeze([]);\n', 'utf8');

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'check']),
    /generated output differs: .*pluginDescriptors\.ts/,
  );
});

test('generateBundledPluginEntries check mode rejects UI generated entry drift', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-ui-check-'));
  writeAgentPluginFixture(repoRoot, 'qwen');
  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const uiOutPath = resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts');
  writeFileSync(uiOutPath, `${readFileSync(uiOutPath, 'utf8')}// drift\n`, 'utf8');

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'check']),
    /generated output differs: .*generatedBundledPluginEntries\.ts/,
  );
});

test('generateBundledPluginEntries check mode rejects UI behavior override drift', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-ui-overrides-check-'));
  writeAgentPluginFixture(repoRoot, 'qwen');
  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const uiOverridesOutPath = resolve(
    repoRoot,
    'apps/ui/sources/agents/registry/generatedBundledPluginEntries.uiBehaviorOverrides.ts',
  );
  writeFileSync(uiOverridesOutPath, `${readFileSync(uiOverridesOutPath, 'utf8')}// drift\n`, 'utf8');

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'check']),
    /generated output differs: .*generatedBundledPluginEntries\.uiBehaviorOverrides\.ts/,
  );
});

test('generateBundledPluginEntries check mode rejects session provider behavior drift', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-session-provider-behaviors-check-'));
  writeAgentPluginFixture(repoRoot, 'qwen');
  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const sessionProviderBehaviorsOutPath = resolve(
    repoRoot,
    'apps/ui/sources/agents/registry/generatedBundledPluginEntries.sessionProviderBehaviors.ts',
  );
  writeFileSync(sessionProviderBehaviorsOutPath, `${readFileSync(sessionProviderBehaviorsOutPath, 'utf8')}// drift\n`, 'utf8');

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'check']),
    /generated output differs: .*generatedBundledPluginEntries\.sessionProviderBehaviors\.ts/,
  );
});

test('generateBundledPluginEntries check mode rejects message meta override drift', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-message-meta-check-'));
  writeAgentPluginFixture(repoRoot, 'qwen');
  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const messageMetaOutPath = resolve(
    repoRoot,
    'apps/ui/sources/agents/registry/generatedBundledPluginEntries.messageMetaOverrides.ts',
  );
  writeFileSync(messageMetaOutPath, `${readFileSync(messageMetaOutPath, 'utf8')}// drift\n`, 'utf8');

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'check']),
    /generated output differs: .*generatedBundledPluginEntries\.messageMetaOverrides\.ts/,
  );
});

test('generateBundledPluginEntries check mode rejects provider settings drift', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-provider-settings-check-'));
  writeAgentPluginFixture(repoRoot, 'qwen');
  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const providerSettingsOutPath = resolve(
    repoRoot,
    'apps/ui/sources/agents/registry/generatedBundledPluginEntries.providerSettings.ts',
  );
  writeFileSync(providerSettingsOutPath, `${readFileSync(providerSettingsOutPath, 'utf8')}// drift\n`, 'utf8');

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'check']),
    /generated output differs: .*generatedBundledPluginEntries\.providerSettings\.ts/,
  );
});

test('generateBundledPluginEntries check mode rejects visible message resolver drift', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-visible-messages-check-'));
  writeAgentPluginFixture(repoRoot, 'qwen');
  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const visibleResolversOutPath = resolve(
    repoRoot,
    'apps/ui/sources/agents/registry/generatedBundledPluginEntries.visibleMessageResolvers.ts',
  );
  writeFileSync(visibleResolversOutPath, `${readFileSync(visibleResolversOutPath, 'utf8')}// drift\n`, 'utf8');

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'check']),
    /generated output differs: .*generatedBundledPluginEntries\.visibleMessageResolvers\.ts/,
  );
});

test('generateBundledPluginEntries renders Cursor UI projection from the plugin descriptor', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-ui-descriptor-'));
  writeAgentPluginFixture(repoRoot, 'cursor');
  writeCursorUiDescriptorFixture(repoRoot);
  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const uiOut = readFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts'),
    'utf8',
  );

  assert.match(uiOut, /displayNameKey:\s*'test\.cursor\.descriptorName'/);
  assert.match(uiOut, /subtitleKey:\s*'test\.cursor\.descriptorSubtitle'/);
  assert.match(uiOut, /uiConnectedService:\s*\{ serviceId: null, label: 'test\.cursor\.descriptorName', connectRoute: null \}/);
  assert.match(uiOut, /flavorAliases:\s*\['descriptor-cursor'\]/);
  assert.match(uiOut, /hideUnknownToolsByDefault:\s*false/);
  assert.match(uiOut, /agentPickerIconName:\s*'descriptor-icon'/);
  assert.match(uiOut, /pickerIconScale:\s*0\.7/);
  assert.match(uiOut, /cliGlyph:\s*'CU'/);
});

test('generateBundledPluginEntries prefers extracted plugin UI descriptors over legacy provider imports', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-ui-descriptor-legacy-'));
  writeAgentPluginFixture(repoRoot, 'claude');
  writeClaudeUiDescriptorFixture(repoRoot);
  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const uiOut = readFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts'),
    'utf8',
  );

  assert.doesNotMatch(uiOut, /@\/agents\/providers\/claude\/core/);
  assert.doesNotMatch(uiOut, /@\/agents\/providers\/claude\/ui/);
  assert.match(uiOut, /const CLAUDE_CORE: AgentCoreConfig/);
  assert.match(
    uiOut,
    /uiConnectedService:\s*\{ serviceId: 'anthropic', label: 'Claude Code', connectRoute: '\/\(app\)\/settings\/connect\/claude' \}/,
  );
  assert.match(uiOut, /staticOptions:\s*\[/);
  assert.match(uiOut, /id:\s*'plan'/);
  assert.match(uiOut, /descriptionKey:\s*'agentInput\.mode\.planDescription'/);
  assert.match(uiOut, /claude:\s*CLAUDE_CORE/);
  assert.match(uiOut, /claude:\s*CLAUDE_UI/);
});

test('generateBundledPluginEntries rejects missing OpenCode plugin UI descriptor instead of falling back to legacy provider imports', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-opencode-ui-no-legacy-'));
  writeAgentPluginFixture(repoRoot, 'opencode');
  writeGeneratorOutputScaffold(repoRoot);

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']),
    /Missing UI core projection source for opencode/,
  );
});

test('generateBundledPluginEntries rejects missing Pi plugin UI descriptor instead of falling back to legacy provider imports', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-pi-ui-no-legacy-'));
  writeAgentPluginFixture(repoRoot, 'pi');
  writeGeneratorOutputScaffold(repoRoot);

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']),
    /Missing UI core projection source for pi/,
  );
});

test('generateBundledPluginEntries rejects executable UI projection import descriptors', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-ui-import-source-reject-'));
  writeAgentPluginFixture(repoRoot, 'opencode');
  mkdirSync(resolve(repoRoot, 'packages/plugins/opencode/src/ui'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/opencode/src/ui/descriptor.ts'),
    [
      'export const OPENCODE_UI_DESCRIPTOR = Object.freeze({',
      '  agentId: "opencode",',
      '  core: {',
      '    displayNameKey: "agentInput.agent.opencode",',
      '    subtitleKey: "profiles.aiBackend.opencodeSubtitle",',
      '    permissionModeI18nPrefix: "agentInput.codexPermissionMode",',
      '    availability: { experimental: false },',
      '    uiConnectedService: { serviceId: null, label: "OpenCode", connectRoute: null },',
      '    flavorAliases: ["opencode"],',
      '    permissions: { modeGroup: "codexLike", promptProtocol: "codexDecision" },',
      '    resume: { uiVendorResumeIdLabelKey: null, uiVendorResumeIdCopiedKey: null },',
      '    toolRendering: { hideUnknownToolsByDefault: false },',
      '    ui: { agentPickerIconName: "code-slash-outline", cliGlyphScale: 1.0, profileCompatibilityGlyphScale: 1.0 },',
      '  },',
      '  ui: {',
      '    svgIconKey: "opencode",',
      '    avatarOverlay: { circleScale: 0.35, iconScaleRatio: 0.22 },',
      '    cliGlyph: "</>",',
      '  },',
      '  projection: {',
      '    providerSettings: { importName: "OPENCODE_PROVIDER_SETTINGS_PLUGIN", source: "./settings" },',
      '  },',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  writeGeneratorOutputScaffold(repoRoot);

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']),
    /projection import descriptors are not allowed/i,
  );
});

test('generateBundledPluginEntries keeps OpenCode UI projections on exported/package surfaces', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-opencode-ui-projection-'));
  writeOpenCodeAgentPluginFixture(repoRoot);
  writeOpenCodeUiDescriptorFixture(repoRoot);
  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const cliOut = readFileSync(
    resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPlugins.ts'),
    'utf8',
  );
  assert.match(cliOut, /import \{ OPENCODE_PROVIDER_RUNTIME_CONTRIBUTION \} from '@happier-dev\/plugins-opencode\/agent\/contributions\/runtime';/);
  assert.doesNotMatch(cliOut, /from '@happier-dev\/plugins-opencode';/);
  assert.match(cliOut, /BUNDLED_FIRST_PARTY_PROVIDER_CATALOG_ENTRY_HOOKS/);
  assert.match(cliOut, /opencode:\s*createProviderRuntimeCatalogEntryHooks/);
  assert.match(cliOut, /contribution:\s*OPENCODE_PROVIDER_RUNTIME_CONTRIBUTION/);
  assert.match(cliOut, /rootHelpLabel:\s*"happier opencode"/);
  assert.match(cliOut, /rootHelpDescription:\s*"Start OpenCode mode"/);
  assert.match(cliOut, /allowTmux:\s*true/);
  assert.doesNotMatch(cliOut, /\.\/bundled\/opencode/);

  const uiBehaviorOverridesOut = readFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.uiBehaviorOverrides.ts'),
    'utf8',
  );
  assertNoExecutableUiProjectionImports(uiBehaviorOverridesOut);
  assert.match(uiBehaviorOverridesOut, /BUNDLED_CANONICAL_AGENT_UI_BEHAVIOR_DESCRIPTORS/);
  assert.match(uiBehaviorOverridesOut, /opencode\.uiBehavior\.v1/);
  assert.match(uiBehaviorOverridesOut, /HAPPIER_OPENCODE_SERVER_URL/);
  assert.match(uiBehaviorOverridesOut, /opencodeServerBaseUrlByServerIdV1/);

  const uiOut = readFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts'),
    'utf8',
  );
  assertNoExecutableUiProjectionImports(uiOut);
  assert.match(uiOut, /import type \{ AgentIconSvgXmlResolver, AgentUiConfig \} from '\.\/registryUi';/);
  assert.match(uiOut, /const OPENCODE_SVG_ICON_XML: AgentIconSvgXmlResolver = \(theme\): string => createGeneratedSvgIconXml\(/);
  assert.match(uiOut, /fill="\$\{theme\.colors\.text\.primary\}"/);
  assert.match(uiOut, /svgIconXml:\s*OPENCODE_SVG_ICON_XML,/);
  assert.doesNotMatch(uiOut, /PROVIDER_LOGO_SVG_XML\.opencode/);

  const providerSettingsOut = readFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.providerSettings.ts'),
    'utf8',
  );
  assertNoExecutableUiProjectionImports(providerSettingsOut);
  assert.match(providerSettingsOut, /BUNDLED_PROVIDER_SETTINGS_DESCRIPTORS/);
  assert.match(providerSettingsOut, /"kind": "providerSettings\.v1"/);
  assert.match(providerSettingsOut, /opencode\.providerSettings\.v1/);
  assert.match(providerSettingsOut, /opencodeBackendMode/);
  assert.match(providerSettingsOut, /opencodeServerBaseUrlByServerIdV1/);
  assert.doesNotMatch(providerSettingsOut, /OPENCODE_PROVIDER_SETTINGS_PLUGIN/);
});

test('generateBundledPluginEntries rejects first-party runtime contribution package root sources', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-runtime-root-source-'));
  writeAgentPluginFixture(repoRoot, 'opencode');
  writeOpenCodeUiDescriptorFixture(repoRoot);
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/opencode/src/agent/definition.ts'),
    [
      'export const AGENT_DEFINITION = Object.freeze({',
      '  id: "opencode",',
      '  agentCliRuntime: {',
      '    id: "opencode",',
      '    title: "opencode CLI",',
      '    binaryName: "opencode",',
      '    sourcePreferenceDefault: "system-first",',
      '    managedInstall: null,',
      '    manualInstallKind: "none",',
      '    manualInstallRecipes: null,',
      '    acceptsJavaScriptFileOverride: false,',
      '  },',
      '  runtimeContributions: {',
      '    providerCatalogEntry: { importName: "OPENCODE_PROVIDER_RUNTIME_CONTRIBUTION", source: "." },',
      '  },',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/opencode/src/index.ts'),
    'export const OPENCODE_PROVIDER_RUNTIME_CONTRIBUTION = Object.freeze({ agentId: "opencode" });\n',
    'utf8',
  );
  writeGeneratorOutputScaffold(repoRoot);

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']),
    /runtime projection source.*must use a narrow .\/agent\/contributions\/runtime entrypoint/i,
  );
});

test('generateBundledPluginEntries rejects short bundled plugin owner ids', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-short-id-'));

  writeJson(resolve(repoRoot, 'packages/plugins/codex/package.json'), {
    name: '@happier-dev/plugins-codex',
    version: '0.0.0',
  });

  mkdirSync(resolve(repoRoot, 'packages/plugins/codex/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/codex/src/manifest.ts'),
    pluginManifestSource({ id: 'codex', capabilities: ['agents'] }),
    'utf8',
  );
  mkdirSync(resolve(repoRoot, 'packages/plugins/codex/src/agent'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/codex/src/agent/definition.ts'),
    'export const AGENT_DEFINITION = Object.freeze({ id: \"codex\" });\n',
    'utf8',
  );

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']),
    /canonical first-party plugin owner id/i,
  );
});

test('generateBundledPluginEntries skips reservation-only plugin packages', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-skip-'));

  writeJson(resolve(repoRoot, 'packages/plugins/claude/package.json'), {
    name: '@happier-dev/plugins-claude',
    version: '0.0.0',
  });
  writeJson(resolve(repoRoot, 'packages/plugins/placeholder/package.json'), {
    name: '@happier-dev/plugins-placeholder',
    version: '0.0.0',
    happier: {
      extensionScaffold: {
        shipping: 'reservation_only',
        plannedStage: 'E.99',
      },
    },
  });

  mkdirSync(resolve(repoRoot, 'packages/plugins/claude/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/claude/src/manifest.ts'),
    pluginManifestSource({ id: 'happier.agent.claude', capabilities: ['agents'] }),
    'utf8',
  );
  mkdirSync(resolve(repoRoot, 'packages/plugins/claude/src/agent'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/claude/src/agent/definition.ts'),
    'export const AGENT_DEFINITION = Object.freeze({ id: \"claude\" });\n',
    'utf8',
  );
  writeClaudeUiDescriptorFixture(repoRoot);

  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const cliOut = readFileSync(
    resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPlugins.ts'),
    'utf8',
  );
  assert.match(cliOut, /@happier-dev\/plugins-claude/);
  assert.doesNotMatch(cliOut, /@happier-dev\/plugins-placeholder/);

  const agentsOut = readFileSync(
    resolve(repoRoot, 'packages/agents/src/generated/bundledAgentDefinitions.ts'),
    'utf8',
  );
  assert.match(agentsOut, /"claude":\s*Object\.freeze\(/);
  assert.doesNotMatch(agentsOut, /placeholder/);

  const agentProviderIdsOut = readGeneratedAgentProviderIdsOutput(repoRoot);
  assert.match(agentProviderIdsOut, /'claude'/);
  assert.doesNotMatch(agentProviderIdsOut, /placeholder/);
});

test('generateBundledPluginEntries projects non-agent plugin packages without agent definitions', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-non-agent-'));

  writeJson(resolve(repoRoot, 'packages/plugins/scm-github/package.json'), {
    name: '@happier-dev/plugins-scm-github',
    version: '0.0.0',
  });

  mkdirSync(resolve(repoRoot, 'packages/plugins/scm-github/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/scm-github/src/manifest.ts'),
    pluginManifestSource({
      id: 'happier.scm.hosting.github',
      capabilities: ['scmHostingProviders'],
      contributes: '{ scmHostingProviders: [{ id: "github", kind: "github", displayName: "GitHub", baseUrl: "https://github.com" }] }',
    }),
    'utf8',
  );

  mkdirSync(resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'apps/ui/sources/agents/registry'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/agents/src/generated'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/agents/src/definitions'), { recursive: true });

  writeFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts'),
    'export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: readonly string[] = Object.freeze([]);\n',
    'utf8',
  );
  writeFileSync(
    resolve(repoRoot, 'packages/agents/src/definitions/agentDefinition.ts'),
    'export type AgentDefinition = Readonly<{ id: string } & Record<string, unknown>>;\n',
    'utf8',
  );

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const cliOut = readFileSync(
    resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPlugins.ts'),
    'utf8',
  );
  assert.match(cliOut, /@happier-dev\/plugins-scm-github/);
  assert.match(cliOut, /"pluginId":\s*"happier\.scm\.hosting\.github"/);
  assert.match(cliOut, /BUNDLED_FIRST_PARTY_SCM_HOSTING_PROVIDER_CONTRIBUTIONS/);
  assert.match(cliOut, /id:\s*"github"/);
  assert.match(cliOut, /definition:\s*Object\.freeze\(\{/);
  assert.match(cliOut, /"kind":\s*"github"/);
  assert.doesNotMatch(cliOut, /"agentId":\s*"scm-github"/);

  const agentsOut = readFileSync(
    resolve(repoRoot, 'packages/agents/src/generated/bundledAgentDefinitions.ts'),
    'utf8',
  );
  assert.doesNotMatch(agentsOut, /scm-github/);

  const agentProviderIdsOut = readGeneratedAgentProviderIdsOutput(repoRoot);
  assert.doesNotMatch(agentProviderIdsOut, /scm-github/);
});

test('generateBundledPluginEntries projects review-only backend contributions without agent definitions', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-review-backend-'));

  writeJson(resolve(repoRoot, 'packages/plugins/review-coderabbit/package.json'), {
    name: '@happier-dev/plugins-review-coderabbit',
    version: '0.0.0',
  });

  mkdirSync(resolve(repoRoot, 'packages/plugins/review-coderabbit/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/review-coderabbit/src/manifest.ts'),
    pluginManifestSource({
      id: 'happier.review.coderabbit',
      capabilities: ['backends', 'executionRunProfiles'],
      contributes: [
        '{',
        '  backends: [{',
        '    kindVersion: 1,',
        '    id: "coderabbit",',
        '    agentId: "coderabbit",',
        '    engine: { kind: "custom" },',
        '    capabilities: {',
        '      session: { supported: false },',
        '      executionRun: {',
        '        supported: true,',
        '        review: {',
        '          intents: ["review"],',
        '          modes: ["change_scoped_review"],',
        '          directCommentWrite: false,',
        '        },',
        '      },',
        '    },',
        '    surfaceHandlers: [],',
        '  }],',
        '  executionRunProfiles: [{',
        '    id: "coderabbit.review",',
        '    kind: "executionRun.profile",',
        '    version: "1",',
        '    intent: "review",',
        '    displayKey: "plugins.coderabbit.executionRuns.review.label",',
        '  }],',
        '}',
      ].join('\n'),
    }),
    'utf8',
  );

  writeGeneratorOutputScaffold(repoRoot);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const cliOut = readFileSync(
    resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPlugins.ts'),
    'utf8',
  );
  assert.match(cliOut, /@happier-dev\/plugins-review-coderabbit/);
  assert.match(cliOut, /BUNDLED_FIRST_PARTY_PLUGIN_BACKEND_CONTRIBUTIONS/);
  assert.match(cliOut, /pluginId:\s*"happier\.review\.coderabbit"/);
  assert.match(cliOut, /id:\s*"coderabbit"/);
  assert.match(cliOut, /directCommentWrite":\s*false/);
  assert.match(cliOut, /BUNDLED_FIRST_PARTY_EXECUTION_RUN_PROFILE_CONTRIBUTIONS/);
  assert.match(cliOut, /"id":\s*"coderabbit\.review"/);
  assert.doesNotMatch(cliOut, /"agentId":\s*"review-coderabbit"/);

  const agentsOut = readFileSync(
    resolve(repoRoot, 'packages/agents/src/generated/bundledAgentDefinitions.ts'),
    'utf8',
  );
  assert.doesNotMatch(agentsOut, /coderabbit/);

  const agentProviderIdsOut = readGeneratedAgentProviderIdsOutput(repoRoot);
  assert.doesNotMatch(agentProviderIdsOut, /coderabbit/);
});

test('generateBundledPluginEntries rejects duplicate AGENT_DEFINITION ids', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-agent-id-duplicate-'));
  writeAgentPluginFixture(repoRoot, 'left', 'sharedAgent');
  writeAgentPluginFixture(repoRoot, 'right', 'sharedAgent');
  writeGeneratorOutputScaffold(repoRoot);

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']),
    /Duplicate bundled agent provider id 'sharedAgent'/,
  );
});

test('generateBundledPluginEntries projects bundled SCM backend and installable contributions', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-scm-backend-'));

  writeJson(resolve(repoRoot, 'packages/plugins/scm-sapling/package.json'), {
    name: '@happier-dev/plugins-scm-sapling',
    version: '0.0.0',
  });

  mkdirSync(resolve(repoRoot, 'packages/plugins/scm-sapling/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/scm-sapling/src/manifest.ts'),
    [
      'const supported = Object.freeze({ support: "supported" });',
      'const unsupported = Object.freeze({ support: "unsupported", reason: "not_implemented" });',
      'export const PLUGIN_MANIFEST = Object.freeze({',
      '  schemaVersion: 2,',
      '  id: "happier.scm.backend.sapling",',
      '  version: "0.0.0",',
      '  displayName: "Sapling SCM backend",',
      '  description: "Sapling SCM backend.",',
      '  engines: { happier: "^0.0.0" },',
      '  runtime: { apiVersion: 1, capabilities: ["scmBackends"] },',
      '  targets: {},',
      '  capabilities: { permissions: [] },',
      '  contributes: {',
      '    installables: [{',
      '      id: "sapling",',
      '      key: "sapling",',
      '      kind: "dep",',
      '      version: "1",',
      '      capabilityId: "dep.sapling",',
      '      display: { name: "Sapling" },',
      '      description: "Sapling source control CLI.",',
      '      source: { kind: "manual_only", setupUrl: "https://sapling-scm.com/docs/introduction/installation" },',
      '      binary: { commands: ["sl"], systemFirst: true, managedFallback: false },',
      '      defaultPolicy: { autoInstallWhenNeeded: false, autoUpdateMode: "notify" },',
      '      consent: { install: "required", update: "required" },',
      '    }],',
      '    scmBackends: [{',
      '      id: "sapling",',
      '      displayName: "Sapling",',
      '      description: "Sapling local source control backend.",',
      '      repoModes: [".sl", ".git"],',
      '      detection: { rootMarkers: [".sl"] },',
      '      installableDependencies: ["dep.sapling"],',
      '      tooling: { commands: [{ installableKey: "dep.sapling", command: "sl" }], systemFirst: true, managedFallback: false },',
      '      safetyConstraints: { mutatesWorkingTree: true, requiresUserConfirmationForDestructiveWrites: true },',
      '      capabilities: {',
      '        detection: { repository: supported, repoIdentity: supported, ignoredPath: supported, repoMode: supported, executable: supported },',
      '        read: { status: supported, diffFile: supported, diffCommit: supported, log: supported, branches: unsupported, stash: unsupported, defaultBranch: unsupported, hostingProvider: unsupported, pullRequestStatus: unsupported },',
      '        changeSet: { model: "working-copy", diffAreas: ["pending", "both"], include: unsupported, exclude: unsupported, discard: supported },',
      '        commit: { create: supported, pathSelection: supported, lineSelection: unsupported, backout: supported },',
      '        remote: { read: supported, add: unsupported, setUrl: unsupported, remove: unsupported, fetch: unsupported, pull: unsupported, push: unsupported, publish: unsupported },',
      '        branch: { list: unsupported, create: unsupported, checkout: unsupported, merge: unsupported, rebase: unsupported, operationControl: unsupported },',
      '        worktree: { create: unsupported, remove: unsupported, prune: unsupported, prepare: unsupported },',
      '        lifecycle: { init: unsupported, clone: unsupported, publish: unsupported, identityRediscovery: supported, removeIndexLock: unsupported },',
      '        hosting: { providerDetection: unsupported, repositoryPublishTargets: unsupported, repositoryPublish: unsupported, pullRequestRead: unsupported, pullRequestStatus: unsupported, pullRequestCreate: unsupported, pullRequestReuse: unsupported, pullRequestCheckout: unsupported, pullRequestPrepareWorktree: unsupported, pullRequestRunStacked: unsupported },',
      '        checkpoints: { capture: unsupported, aliasFinalize: unsupported, diff: unsupported, cleanup: unsupported, backup: unsupported, rollbackApply: unsupported },',
      '        workspaceIntegration: { inspectLocation: unsupported, checkoutMaterialization: unsupported, workspaceTransfer: unsupported, exportPortability: unsupported, portablePathClassification: unsupported },',
      '        tooling: { systemCliResolution: supported, managedCliResolution: unsupported, binarySafe: supported },',
      '        freshness: { observed: supported, expiry: supported },',
      '      },',
      '    }],',
      '  },',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );

  mkdirSync(resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'apps/ui/sources/agents/registry'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/agents/src/generated'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/agents/src/definitions'), { recursive: true });

  writeFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts'),
    'export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: readonly string[] = Object.freeze([]);\n',
    'utf8',
  );
  writeFileSync(
    resolve(repoRoot, 'packages/agents/src/definitions/agentDefinition.ts'),
    'export type AgentDefinition = Readonly<{ id: string } & Record<string, unknown>>;\n',
    'utf8',
  );

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const cliOut = readFileSync(
    resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPlugins.ts'),
    'utf8',
  );
  assert.match(cliOut, /BUNDLED_FIRST_PARTY_SCM_BACKEND_CONTRIBUTIONS/);
  assert.match(cliOut, /BUNDLED_FIRST_PARTY_INSTALLABLE_CONTRIBUTIONS/);
  assert.match(cliOut, /pluginId:\s*"happier\.scm\.backend\.sapling"/);
  assert.match(cliOut, /id:\s*"sapling"/);
  assert.match(cliOut, /capabilityId":\s*"dep\.sapling"/);
  assert.match(cliOut, /autoInstallWhenNeeded":\s*false/);
});

test('generateBundledPluginEntries rejects malformed bundled SCM provider contributions', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-invalid-scm-'));

  writeJson(resolve(repoRoot, 'packages/plugins/scm-github/package.json'), {
    name: '@happier-dev/plugins-scm-github',
    version: '0.0.0',
  });

  mkdirSync(resolve(repoRoot, 'packages/plugins/scm-github/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/scm-github/src/manifest.ts'),
    [
      'export const PLUGIN_MANIFEST = Object.freeze({',
      '  schemaVersion: 2,',
      '  id: "happier.scm.hosting.github",',
      '  version: "0.0.0",',
      '  displayName: "GitHub SCM hosting provider",',
      '  description: "Detects GitHub remotes.",',
      '  engines: { happier: "^0.0.0" },',
      '  runtime: { apiVersion: 1, capabilities: ["scmHostingProviders"] },',
      '  targets: {},',
      '  capabilities: { permissions: [] },',
      '  contributes: { scmHostingProviders: [{ id: "scm.github", kind: "github", displayName: "GitHub", baseUrl: "not-a-url" }] },',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );

  mkdirSync(resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'apps/ui/sources/agents/registry'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/agents/src/generated'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/agents/src/definitions'), { recursive: true });

  writeFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts'),
    'export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: readonly string[] = Object.freeze([]);\n',
    'utf8',
  );
  writeFileSync(
    resolve(repoRoot, 'packages/agents/src/definitions/agentDefinition.ts'),
    'export type AgentDefinition = Readonly<{ id: string } & Record<string, unknown>>;\n',
    'utf8',
  );

  await assert.rejects(
    () => generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']),
    /Invalid PLUGIN_MANIFEST/,
  );
});

test('generateBundledPluginEntries fails for agent-capable plugin packages without agent definitions', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-missing-definition-'));

  writeJson(resolve(repoRoot, 'packages/plugins/placeholder/package.json'), {
    name: '@happier-dev/plugins-placeholder',
    version: '0.0.0',
  });
  mkdirSync(resolve(repoRoot, 'packages/plugins/placeholder/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/placeholder/src/manifest.ts'),
    pluginManifestSource({ id: 'happier.agent.placeholder', capabilities: ['agents'] }),
    'utf8',
  );

  mkdirSync(resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'apps/ui/sources/agents/registry'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/agents/src/generated'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/agents/src/definitions'), { recursive: true });

  writeFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts'),
    'export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: readonly string[] = Object.freeze([]);\n',
    'utf8',
  );
  writeFileSync(
    resolve(repoRoot, 'packages/agents/src/definitions/agentDefinition.ts'),
    'export type AgentDefinition = Readonly<{ id: string } & Record<string, unknown>>;\n',
    'utf8',
  );

  await assert.rejects(
    () => generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']),
    /Missing required agent definition/,
  );
});

test('generateBundledPluginEntries uses AGENT_DEFINITION.id as the runtime agent id', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-runtime-id-'));

  writeJson(resolve(repoRoot, 'packages/plugins/ohmypi/package.json'), {
    name: '@happier-dev/plugins-ohmypi',
    version: '0.0.0',
  });

  mkdirSync(resolve(repoRoot, 'packages/plugins/ohmypi/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/ohmypi/src/manifest.ts'),
    pluginManifestSource({ id: 'happier.agent.ohmypi', capabilities: ['agents'] }),
    'utf8',
  );
  mkdirSync(resolve(repoRoot, 'packages/plugins/ohmypi/src/agent'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/ohmypi/src/agent/definition.ts'),
    'export const AGENT_DEFINITION = Object.freeze({ id: \"ohMyPi\" });\n',
    'utf8',
  );
  writeOhMyPiUiDescriptorFixture(repoRoot);

  mkdirSync(resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'apps/ui/sources/agents/registry'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/agents/src/generated'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/agents/src/definitions'), { recursive: true });

  writeFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts'),
    'export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: readonly string[] = Object.freeze([]);\n',
    'utf8',
  );
  writeFileSync(
    resolve(repoRoot, 'packages/agents/src/definitions/agentDefinition.ts'),
    'export type AgentDefinition = Readonly<{ id: string } & Record<string, unknown>>;\n',
    'utf8',
  );

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const agentsOut = readFileSync(
    resolve(repoRoot, 'packages/agents/src/generated/bundledAgentDefinitions.ts'),
    'utf8',
  );
  assert.match(agentsOut, /"ohMyPi":\s*Object\.freeze\(/);
  assert.match(agentsOut, /"id":\s*"ohMyPi"/);
  assert.doesNotMatch(agentsOut, /"ohmypi":\s*Object\.freeze\(/);

  const agentProviderIdsOut = readGeneratedAgentProviderIdsOutput(repoRoot);
  assert.match(agentProviderIdsOut, /'ohMyPi'/);
  assert.doesNotMatch(agentProviderIdsOut, /'ohmypi'/);
});
