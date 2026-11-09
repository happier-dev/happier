import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';

import { AGENT_DEFINITION } from './agent/definition.js';
import { createCopilotAgentRuntime } from './agent/runtime/factory.js';
import { COPILOT_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';

import { COPILOT_PREFLIGHT_SESSION_CONTROLS } from './agent/acp/preflight.js';
import { copilotExternalSessionsContribution } from './agent/externalSessions/contribution.js';
import { COPILOT_PROVIDER_BINDING_ADAPTER_V1, COPILOT_PROVIDER_OWNED_ENV_KEYS } from './agent/providerBinding.js';
import { COPILOT_CONNECTED_ACCOUNT_PURPOSES } from './agent/auth/services/accountPurposes.js';
import { COPILOT_CONNECTED_ACCOUNT_LAUNCH } from './agent/auth/services/continuity.js';
import { COPILOT_AUTH_ENV_VARS } from './agent/auth/services/copilotAuth.js';

const {
  id: COPILOT_AGENT_SETTINGS_CONTRIBUTION_ID,
  ...COPILOT_AGENT_SETTINGS_DECLARATION
} = COPILOT_AGENT_SETTINGS_CONTRIBUTION;

export const COPILOT_PLUGIN = definePlugin({
  id: 'happier.agent.copilot',
  version: '0.0.0',
  displayName: 'GitHub Copilot',
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [{
      id: 'copilot-process',
      capability: 'process',
      reason: 'Run the declared GitHub Copilot CLI executable.',
      scope: {
        executables: [
          { kind: 'systemTool', id: 'copilot-cli' },
        ],
        envKeys: [...COPILOT_AUTH_ENV_VARS, ...COPILOT_PROVIDER_OWNED_ENV_KEYS],
      },
    }],
    optional: [],
  },
  agents: {
    copilot: {
      declaration: {
        title: 'GitHub Copilot',
        connectedAccounts: COPILOT_CONNECTED_ACCOUNT_PURPOSES.map(declaration => ({
          ...declaration, service: { ...declaration.service },
          credentialKinds: [...declaration.credentialKinds], materializationKinds: [...declaration.materializationKinds],
        })),
        providerRequirements: {
          acceptsProtocols: ['openai-chat', 'anthropic'],
          required: { streaming: true, toolRoundTrips: true },
          credentialSupport: {
            supportsNoAuth: true,
            apiKeyTransports: [
              { protocol: 'openai-chat', destination: { kind: 'httpHeader', names: ['authorization'], formats: ['bearer'] } },
              { protocol: 'anthropic', destination: { kind: 'httpHeader', names: ['authorization'], formats: ['bearer'] } },
              { protocol: 'anthropic', destination: { kind: 'httpHeader', names: ['x-api-key'], formats: ['raw'] } },
            ],
          },
          authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: [...COPILOT_PROVIDER_OWNED_ENV_KEYS] },
          materialization: 'spawnEnv', applyPolicy: 'restart_session', supportsFreeformModelIds: true,
        },
        runtime: { kind: 'custom' },
        cli: {
          displayName: 'GitHub Copilot CLI',
          executable: {
            binaryName: 'copilot',
            knownUserBinDirSuffixes: null,
            sourcePreference: 'system-first',
          },
          install: {
            managed: {
              kind: 'managed_package',
              packageName: '@github/copilot',
              binaryName: 'copilot',
            },
            manual: { kind: 'command' },
            guideUrl: null,
            docsUrl: 'https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli',
          },
          auth: {
            support: 'login_terminal',
            environmentVariables: [...COPILOT_AUTH_ENV_VARS],
            credentialPaths: ['~/.copilot/config.json'],
            missingCredentialState: 'unknown',
            loginLaunches: [{ kind: 'primary', args: ['login'] }],
          },
        },
        sessionModeDescriptor: AGENT_DEFINITION.sessionModeDescriptor,
        primary: 'sessions',
        catalog: {
          agentCliSystemTool: { toolId: 'copilot-cli' },
          acpRegistryIds: [...AGENT_DEFINITION.acpRegistryIds],
          vendorResume: { support: AGENT_DEFINITION.core.resume.vendorResume },
        },
        capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
          surfaces: ['externalSessions'],
          skills: { delivery: 'session_dir', nativeDisable: 'unsupported', liveReload: 'unsupported',
            nativeRoots: { user: [['.copilot', 'skills'], ['.agents', 'skills']], project: [['.github', 'skills'], ['.agents', 'skills'], ['.claude', 'skills']] } },
          sessions: {
            open: ['create', 'resume'],
            delivery: ['newTurn', 'followUp'],
            cancel: true,
            executionRunContext: { versions: [1] },
          },
        }),
        surfaces: { externalSession: {
          externalLinkedTakeover: { writerSafety: 'unsupported' },
          sources: [{ sourceKind: 'copilotHome', contentSearch: true,
            schema: { fields: [
              { kind: 'literal', name: 'kind', value: 'copilotHome' },
              { kind: 'string', name: 'homeDir', min: 1, max: 10_000, nullish: true },
            ] },
            key: { segments: [{ kind: 'literal', value: 'copilotHome' }, { kind: 'field', field: 'homeDir' }] },
            instances: [{ kind: 'default', constants: {} }],
          }],
        } },
      },
      factory: createCopilotAgentRuntime,
      providerBinding: COPILOT_PROVIDER_BINDING_ADAPTER_V1,
      connectedAccountLaunch: COPILOT_CONNECTED_ACCOUNT_LAUNCH,
      externalSessions: copilotExternalSessionsContribution,
      preflightSessionControls: COPILOT_PREFLIGHT_SESSION_CONTROLS,
      sessionRunnerFactory: {
        module: './agent/runtime/factory',
        export: 'createCopilotAgentRuntime',
        runtimeApiVersion: 1,
        externalSessionsExport: 'copilotExternalSessionsContribution',
      },
    },
  },
  systemTools: {
    'copilot-cli': {
      title: 'GitHub Copilot CLI',
      executableNames: ['copilot'],
    },
  },
  ui: {
    translations: [
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
    ],
  },
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
  settings: {
    [COPILOT_AGENT_SETTINGS_CONTRIBUTION_ID]: COPILOT_AGENT_SETTINGS_DECLARATION,
  },
});

export const PLUGIN_MANIFEST = COPILOT_PLUGIN.manifest;
