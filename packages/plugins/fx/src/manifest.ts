import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';

import { AGENT_DEFINITION } from './agent/definition.js';
import { FX_ACP_COMMAND } from './agent/preflight.js';
import { fxExternalSessionsContribution } from './agent/externalSessions/contribution.js';
import { FX_CLI_AUTH } from './agent/auth/status.js';
import { FX_PROVIDER_BINDING_ADAPTER, FX_PROVIDER_OWNED_ENV_KEYS } from './agent/providerBinding/adapter.js';
import { createFxAgentRuntime } from './agent/runtime/factory.js';
import { FX_CODEX_PURPOSE, FX_CODEX_SERVICE, FX_NATIVE_AUTH_CODEC, FX_REQUEST_AUTH_USE, FX_RUNTIME_AUTH_ADAPTER, FX_STATE_SHARING, verifyFxResumeReachable } from './agent/auth/connectedAccount.js';


export const FX_PLUGIN = definePlugin({
  id: 'happier.agent.fx', version: '0.0.0', displayName: 'FX',
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: { required: [{
    id: 'fx-process', capability: 'process', reason: 'Run the declared FX CLI executable.',
    scope: { executables: [{ kind: 'systemTool', id: FX_ACP_COMMAND.toolId }], envKeys: ['HOME', 'FX_PROVIDER', 'FX_AUTH_MODE', 'FX_HOME'] },
  }], optional: [] },
  agents: { fx: {
    declaration: {
      title: { key: 'agentInput.agent.fx', fallback: 'FX' },
      description: { key: 'profiles.aiBackend.fxSubtitleExperimental', fallback: 'FX coding agent (experimental)' },
      runtime: { kind: 'custom' },
      providerRequirements: {
        acceptsProtocols: ['openai-chat'], required: { streaming: true, toolRoundTrips: true },
        credentialSupport: { supportsNoAuth: false, apiKeyTransports: [
          { protocol: 'openai-chat', destination: { kind: 'httpHeader', names: ['authorization'], formats: ['bearer'] } },
        ] },
        authIsolation: { suppressConnectedServiceIds: [FX_CODEX_SERVICE.localId], ownedEnvKeys: [...FX_PROVIDER_OWNED_ENV_KEYS] },
        materialization: 'spawnEnv', applyPolicy: 'restart_session', supportsFreeformModelIds: true,
      },
      cli: {
        displayName: 'FX CLI', executable: { binaryName: 'fx', knownUserBinDirSuffixes: ['.local/bin'], sourcePreference: 'system-first', systemCommandResolutionStrategy: 'path-first' },
        install: { managed: null, manual: { kind: 'vendor_recipe', recipes: { darwin: [{ cmd: 'bash', args: ['-lc', 'curl -fsSL https://fx.sh/setup.sh | bash'] }], linux: [{ cmd: 'bash', args: ['-lc', 'curl -fsSL https://fx.sh/setup.sh | bash'] }] } }, guideUrl: 'https://github.com/vercel-labs/fx', docsUrl: 'https://github.com/vercel-labs/fx' },
        auth: { support: 'login_terminal', nonInteractiveStatusProbe: true, loginLaunches: [{ kind: 'primary', args: ['login'] }] },
      },
      primary: 'sessions',
      connectedAccounts: [{ purpose: FX_CODEX_PURPOSE, service: FX_CODEX_SERVICE, required: false, materializationKinds: ['httpHeaders'], credentialKinds: ['oauth'] }],
      catalog: { agentCliSystemTool: { toolId: FX_ACP_COMMAND.toolId }, vendorResume: { support: AGENT_DEFINITION.core.resume.vendorResume } },
      surfaces: {
        externalSession: {
          sources: [{
            sourceKind: 'fxHome',
            contentSearch: true,
            schema: { fields: [{ kind: 'literal', name: 'kind', value: 'fxHome' }] },
            key: { segments: [{ kind: 'literal', value: 'fxHome' }] },
            instances: [{ kind: 'default', constants: {} }],
          }],
        },
      },
      // The host keeps Session V1 canonical and exposes the separately
      // versioned detached Run context through the same shared ACP composer.
      capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
        skills: { delivery: 'none', nativeDisable: 'unsupported', liveReload: 'unsupported',
          nativeRoots: { user: [['.fx', 'skills'], ['.config', 'opencode', 'skills'], ['.codex', 'skills'], ['.claude', 'skills'], ['.agents', 'skills'], ['.claw', 'skills']], project: [['.fx', 'skills'], ['skills'], ['.opencode', 'skills'], ['.codex', 'skills'], ['.claude', 'skills'], ['.agents', 'skills'], ['.claw', 'skills']] } },
        surfaces: ['externalSessions'],
        sessions: {
          open: ['create', 'resume'],
          delivery: ['newTurn', 'followUp', 'steer'],
          cancel: true,
          configuration: true,
          executionRunContext: { versions: [1] },
        },
      }),
    },
    factory: createFxAgentRuntime,
    connectedAccountLaunch: {
      requestAuthUses: [FX_REQUEST_AUTH_USE],
      stateSharingDescriptor: FX_STATE_SHARING,
      switchContinuity: { continuityMode: 'restart_shared_state_required' },
      continuity: { generationApplicationScope: 'per_session_runtime', nativeAuthCodec: FX_NATIVE_AUTH_CODEC, runtimeAuthAdapter: FX_RUNTIME_AUTH_ADAPTER, verifyResumeReachable: verifyFxResumeReachable },
    },
    providerBinding: FX_PROVIDER_BINDING_ADAPTER,
    cliAuth: FX_CLI_AUTH,
    sessionRunnerFactory: { module: './agent/runtime/factory', export: 'createFxAgentRuntime', runtimeApiVersion: 1, externalSessionsExport: 'fxExternalSessionsContribution' },
    preflightSessionControls: { catalogs: { kind: 'acp', command: FX_ACP_COMMAND } },
    externalSessions: fxExternalSessionsContribution,
  } },
  systemTools: { 'fx-cli': { title: 'FX CLI', executableNames: ['fx'] } },
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
    { locale: "zh-Hant", resourceId: "i18n-zh-hant" },
    { locale: "ja", resourceId: "i18n-ja" },
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
    "i18n-zh-hant": { kind: 'asset', path: "assets/i18n/zh-Hant.json", contentType: 'application/json' },
    "i18n-ja": { kind: 'asset', path: "assets/i18n/ja.json", contentType: 'application/json' },
  },
});

export const PLUGIN_MANIFEST = FX_PLUGIN.manifest;
