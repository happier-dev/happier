import { projectAgentCapabilitiesV2FromDefinition, type PluginHostOwnedAgentDeclaration } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { AGENT_DEFINITION } from './agent/definition.js';
import { CODEBUDDY_ACP_COMMAND } from './agent/acp/preflight.js';
import { CODEBUDDY_ACP_RUNTIME_DECLARATION } from './agent/acp/runtimeDeclaration.js';
import { createCodeBuddyAgentRuntime } from './agent/runtime/factory.js';
import { CODEBUDDY_CODEX_PURPOSE } from './agent/runtime/connectedAccounts.js';
import { CODEBUDDY_CONNECTED_ACCOUNT_LAUNCH } from './agent/runtime/continuity.js';
import { CODEBUDDY_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';

import { codeBuddyExternalSessionsContribution } from './agent/externalSessions/contribution.js';

const { id: settingsId, ...settingsDeclaration } = CODEBUDDY_AGENT_SETTINGS_CONTRIBUTION;

export const CODEBUDDY_PLUGIN = definePlugin({
  id: 'happier.agent.codebuddy', version: '0.0.0', displayName: 'CodeBuddy',
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: { required: [{
    id: 'codebuddy-process', capability: 'process', reason: 'Run the declared CodeBuddy CLI executable.',
    scope: { envKeys: ['CODEBUDDY_API_KEY', 'CODEBUDDY_AUTH_TOKEN', 'CODEBUDDY_BASE_URL', 'CODEBUDDY_CUSTOM_HEADERS',
      'ACC_PRODUCT_CONFIG_V3', 'ACC_PRODUCT_CONFIG_PATH', 'CODEBUDDY_DISABLE_CUSTOM_MODELS_FILE',
      'CODEBUDDY_RESPONSES_STORE_ENABLED', 'CODEBUDDY_CODE_MAX_OUTPUT_TOKENS', 'CODEBUDDY_DISABLE_PRODUCT_CACHE'], executables: [{ kind: 'systemTool', id: 'codebuddy-cli' }] },
  }], optional: [] },
  agents: { codebuddy: {
    declaration: {
      title: { key: 'agentInput.agent.codebuddy', fallback: 'CodeBuddy' },
      description: { key: 'profiles.aiBackend.codebuddySubtitleExperimental', fallback: 'CodeBuddy Code CLI (experimental)' },
      runtime: { kind: 'custom', permissionModeMapping: CODEBUDDY_ACP_RUNTIME_DECLARATION.definition.permissionModeMapping },
      connectedAccounts: [{ purpose: CODEBUDDY_CODEX_PURPOSE,
        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
        materializationKinds: ['httpHeaders'], credentialKinds: ['oauth'] }],
      cli: {
        displayName: 'CodeBuddy Code CLI',
        executable: { binaryName: 'codebuddy', sourcePreference: 'system-first', systemCommandResolutionStrategy: 'path-first' },
        install: {
          managed: { kind: 'managed_package', packageName: '@tencent-ai/codebuddy-code', binaryName: 'codebuddy' },
          manual: { kind: 'command' },
          guideUrl: 'https://www.codebuddy.ai/docs/cli/quickstart',
          docsUrl: 'https://www.codebuddy.ai/docs/cli/acp',
        },
        auth: {
          support: 'login_terminal',
          environmentVariables: ['CODEBUDDY_API_KEY'],
          missingCredentialState: 'unknown',
          loginLaunches: [{ kind: 'primary', args: [], initialInput: '/login\r' }],
        },
      },
      primary: 'sessions',
      catalog: { agentCliSystemTool: { toolId: 'codebuddy-cli' }, acpRegistryIds: [...AGENT_DEFINITION.acpRegistryIds], vendorResume: { support: AGENT_DEFINITION.core.resume.vendorResume } },
      capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
        surfaces: ['externalSessions'],
        skills: { delivery: 'session_dir', nativeDisable: 'unsupported', liveReload: 'unsupported',
          nativeRoots: { user: [['.codebuddy', 'skills']], project: [['.codebuddy', 'skills']] } },
        sessions: {
          open: ['create', 'resume'], delivery: ['newTurn', 'followUp'], cancel: true,
          configuration: true, executionRunContext: { versions: [1] },
        },
      }),
      surfaces: { externalSession: {
        externalLinkedTakeover: { writerSafety: 'unsupported' },
        sources: [{ sourceKind: 'codebuddyHome', contentSearch: true,
          schema: { fields: [
            { kind: 'literal', name: 'kind', value: 'codebuddyHome' },
            { kind: 'string', name: 'homeDir', min: 1, max: 10_000, nullish: true },
            { kind: 'string', name: 'sessionFile', min: 1, max: 10_000, nullish: true },
          ] },
          key: { segments: [{ kind: 'literal', value: 'codebuddyHome' }, { kind: 'field', field: 'homeDir' }] },
          instances: [{ kind: 'default', constants: {} }],
        }],
      } },
    } satisfies PluginHostOwnedAgentDeclaration,
    factory: createCodeBuddyAgentRuntime,
    sessionRunnerFactory: { module: './agent/runtime/factory', export: 'createCodeBuddyAgentRuntime', runtimeApiVersion: 1, externalSessionsExport: 'codeBuddyExternalSessionsContribution' },
    preflightSessionControls: { catalogs: { kind: 'acp', command: CODEBUDDY_ACP_COMMAND } },
    connectedAccountLaunch: CODEBUDDY_CONNECTED_ACCOUNT_LAUNCH,
    externalSessions: codeBuddyExternalSessionsContribution,
  } },
  systemTools: { 'codebuddy-cli': { title: 'CodeBuddy Code CLI', executableNames: ['codebuddy'] } },
  settings: { [settingsId]: settingsDeclaration },
  ui: { translations: [
    { locale: "en", resourceId: "i18n-en" },
    { locale: "de", resourceId: "i18n-de" },
    { locale: "ru", resourceId: "i18n-ru" },
    { locale: "pl", resourceId: "i18n-pl" },
    { locale: "es", resourceId: "i18n-es" },
    { locale: "fr", resourceId: "i18n-fr" },
    { locale: "it", resourceId: "i18n-it" },
    { locale: "pt", resourceId: "i18n-pt" },
    { locale: "ca", resourceId: "i18n-ca" },
    { locale: "zh-Hans", resourceId: "i18n-zh-hans" },
    { locale: "ja", resourceId: "i18n-ja" },
    { locale: "zh-Hant", resourceId: "i18n-zh-hant" },
  ] },
  resources: {
    "i18n-en": { kind: 'asset', path: "assets/i18n/en.json", contentType: 'application/json' },
    "i18n-de": { kind: 'asset', path: "assets/i18n/de.json", contentType: 'application/json' },
    "i18n-ru": { kind: 'asset', path: "assets/i18n/ru.json", contentType: 'application/json' },
    "i18n-pl": { kind: 'asset', path: "assets/i18n/pl.json", contentType: 'application/json' },
    "i18n-es": { kind: 'asset', path: "assets/i18n/es.json", contentType: 'application/json' },
    "i18n-fr": { kind: 'asset', path: "assets/i18n/fr.json", contentType: 'application/json' },
    "i18n-it": { kind: 'asset', path: "assets/i18n/it.json", contentType: 'application/json' },
    "i18n-pt": { kind: 'asset', path: "assets/i18n/pt.json", contentType: 'application/json' },
    "i18n-ca": { kind: 'asset', path: "assets/i18n/ca.json", contentType: 'application/json' },
    "i18n-zh-hans": { kind: 'asset', path: "assets/i18n/zh-Hans.json", contentType: 'application/json' },
    "i18n-ja": { kind: 'asset', path: "assets/i18n/ja.json", contentType: 'application/json' },
    "i18n-zh-hant": { kind: 'asset', path: "assets/i18n/zh-Hant.json", contentType: 'application/json' },
  },
});
export const PLUGIN_MANIFEST = CODEBUDDY_PLUGIN.manifest;
