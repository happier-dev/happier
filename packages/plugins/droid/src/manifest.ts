import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';

import { AGENT_DEFINITION } from './agent/definition.js';
import { DROID_ACP_COMMAND } from './agent/preflight.js';
import { droidExternalSessionsContribution } from './agent/externalSessions/contribution.js';
import { DROID_PROVIDER_BINDING_ADAPTER, DROID_PROVIDER_OWNED_ENV_KEYS } from './agent/providerBinding/adapter.js';
import { createDroidAgentRuntime } from './agent/runtime/factory.js';
import { DROID_CONNECTED_ACCOUNT_PURPOSES, DROID_CONNECTED_ACCOUNT_LAUNCH, prepareDroidConnectedAccount } from './agent/runtime/connectedAccount.js';


export const DROID_PLUGIN = definePlugin({
  id: 'happier.agent.droid', version: '0.0.0', displayName: 'Factory Droid',
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: { required: [{
    id: 'droid-process', capability: 'process', reason: 'Run the declared Factory Droid CLI executable.',
    scope: { envKeys: ['FACTORY_API_KEY'], executables: [{ kind: 'systemTool', id: DROID_ACP_COMMAND.toolId }] },
  }], optional: [] },
  agents: { droid: {
    declaration: {
      title: { key: 'agentInput.agent.droid', fallback: 'Factory Droid' },
      description: { key: 'profiles.aiBackend.droidSubtitleExperimental', fallback: 'Factory Droid (experimental)' },
      runtime: { kind: 'custom' },
      connectedAccounts: DROID_CONNECTED_ACCOUNT_PURPOSES.map(row => ({ ...row, credentialKinds: [...row.credentialKinds], materializationKinds: [...row.materializationKinds] })),
      providerRequirements: {
        acceptsProtocols: ['openai-chat', 'openai-responses', 'anthropic'], required: { streaming: true, toolRoundTrips: true },
        credentialSupport: { supportsNoAuth: true, apiKeyTransports: [
          { protocol: 'openai-chat', destination: { kind: 'httpHeader', names: ['authorization'], formats: ['bearer'] } },
          { protocol: 'openai-responses', destination: { kind: 'httpHeader', names: ['authorization'], formats: ['bearer'] } },
          { protocol: 'anthropic', destination: { kind: 'httpHeader', names: ['x-api-key'], formats: ['raw'] } },
          { protocol: 'anthropic', destination: { kind: 'httpHeader', names: ['authorization'], formats: ['bearer'] } },
        ] },
        authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: [...DROID_PROVIDER_OWNED_ENV_KEYS] },
        materialization: 'configFile', applyPolicy: 'restart_session', supportsFreeformModelIds: true,
      },
      cli: {
        displayName: 'Factory Droid CLI', executable: { binaryName: 'droid', knownUserBinDirSuffixes: ['.local/bin'], sourcePreference: 'system-first', systemCommandResolutionStrategy: 'path-first' },
        install: {
          managed: null,
          manual: {
            kind: 'vendor_recipe',
            // Factory publishes a POSIX shell installer and a separate Windows
            // PowerShell installer; both are vendor-owned, so Happier runs no
            // package manager of its own.
            recipes: {
              darwin: [{ cmd: 'bash', args: ['-lc', 'curl -fsSL https://app.factory.ai/cli | sh'] }],
              linux: [{ cmd: 'bash', args: ['-lc', 'curl -fsSL https://app.factory.ai/cli | sh'] }],
              win32: [{
                cmd: 'powershell.exe',
                args: [
                  '-NoProfile',
                  '-ExecutionPolicy',
                  'Bypass',
                  '-Command',
                  'Invoke-RestMethod https://app.factory.ai/cli/windows | Invoke-Expression',
                ],
              }],
            },
          },
          guideUrl: 'https://docs.factory.ai/droid-cli/overview',
          docsUrl: 'https://docs.factory.ai/droid-cli/cli-reference',
        },
        auth: { support: 'login_terminal', environmentVariables: ['FACTORY_API_KEY'], missingCredentialState: 'unknown', loginLaunches: [{ kind: 'primary', args: [], initialInput: '/login' }] },
      },
      sessionModeDescriptor: AGENT_DEFINITION.sessionModeDescriptor,
      primary: 'sessions',
      catalog: { agentCliSystemTool: { toolId: DROID_ACP_COMMAND.toolId }, acpRegistryIds: [...AGENT_DEFINITION.acpRegistryIds], vendorResume: { support: AGENT_DEFINITION.core.resume.vendorResume } },
      // The host keeps Session V1 canonical and exposes the separately
      // versioned detached Run context through the same declarative ACP core.
      capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
        surfaces: ['externalSessions'],
        skills: { delivery: 'none', nativeDisable: 'unsupported', liveReload: 'unsupported',
          nativeRoots: { user: [['.factory', 'skills'], ['.agents', 'skills'], ['.agent', 'skills']], project: [['.factory', 'skills'], ['.agents', 'skills'], ['.agent', 'skills']] } },
        sessions: {
          open: ['create', 'resume'],
          delivery: ['newTurn', 'followUp'],
          cancel: true,
          configuration: true,
          executionRunContext: { versions: [1] },
        },
      }),
      surfaces: { externalSession: {
        externalLinkedTakeover: { writerSafety: 'unsupported' },
        sources: [{ sourceKind: 'droidFactoryDir', contentSearch: true,
          schema: { fields: [
            { kind: 'literal', name: 'kind', value: 'droidFactoryDir' },
            { kind: 'string', name: 'factoryDir', min: 1, max: 10_000, nullish: true },
            { kind: 'string', name: 'sessionFilePath', min: 1, max: 10_000, nullish: true },
          ] },
          key: { segments: [{ kind: 'literal', value: 'droidFactoryDir' }, { kind: 'field', field: 'factoryDir' }] },
          instances: [{ kind: 'default', constants: {} }],
        }],
      } },
    },
    factory: createDroidAgentRuntime,
    connectedAccountLaunch: DROID_CONNECTED_ACCOUNT_LAUNCH,
    providerBinding: DROID_PROVIDER_BINDING_ADAPTER,
    sessionRunnerFactory: { module: './agent/runtime/factory', export: 'createDroidAgentRuntime', runtimeApiVersion: 1, externalSessionsExport: 'droidExternalSessionsContribution' },
    preflightSessionControls: {
      async prepareLaunchEnvironment({ environment, connectedAccounts, signal, modelId }) {
        const prepared = await prepareDroidConnectedAccount({ launchEnvironment: { values: environment, unset: [] } },
          { services: { connectedAccounts }, signal }, modelId);
        return { environment: prepared.request.launchEnvironment.values, unset: prepared.request.launchEnvironment.unset,
          commandArgsSuffix: prepared.customModel?.commandArgsSuffix,
          catalogConfidence: prepared.customModel?.catalogConfidence, dispose: prepared.dispose };
      },
      catalogs: { kind: 'acp', command: DROID_ACP_COMMAND },
    },
    externalSessions: droidExternalSessionsContribution,
  } },
  systemTools: { 'droid-cli': { title: 'Factory Droid CLI', executableNames: ['droid'] } },
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

export const PLUGIN_MANIFEST = DROID_PLUGIN.manifest;
