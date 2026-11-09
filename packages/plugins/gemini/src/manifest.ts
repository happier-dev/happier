import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';
import type { HookHandler } from '@happier-dev/plugin-sdk/hooks';

import { AGENT_DEFINITION } from './agent/definition.js';
import { GEMINI_PREFLIGHT_SESSION_CONTROLS } from './agent/preflight/catalogs.js';
import { geminiConnectedServiceStateSharingDescriptor } from './agent/connectedServices/descriptor.js';
import { createGeminiConnectedServiceRuntimeAuthAdapter } from './agent/connectedServices/runtimeAuthAdapter.js';
import { resolveGeminiDaemonSpawnPrerequisites } from './agent/lifecycle/spawnHooks.js';
import { createGeminiAgentRuntime } from './agent/runtime/factory.js';
import { geminiConnectedAccountRuntime } from './connectedAccounts/runtime.js';
import { geminiPortableAuthentication } from './connectedAccounts/portableAuthentication.js';
import { GEMINI_PROVIDER_BINDING_ADAPTER_V1, GEMINI_PROVIDER_OWNED_ENV_KEYS } from './agent/providerBinding.js';

import { geminiExternalSessionsContribution } from './agent/surfaces/sessions/external/contribution.js';

const resolveGeminiDaemonSpawnPrerequisitesHook: HookHandler =
  (event, context) =>
    resolveGeminiDaemonSpawnPrerequisites(event, context);

export const GEMINI_PLUGIN = definePlugin({
  id: 'happier.agent.gemini',
  version: '0.0.0',
  displayName: 'Gemini',
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [{
      id: 'gemini-native-history', capability: 'filesystem', reason: 'Read native Gemini conversation history.',
      scope: { locations: [{ root: 'workspace' }], access: ['read'] },
    }, {
      id: 'gemini-process',
      capability: 'process',
      reason: 'Run the declared Gemini CLI executable.',
      scope: {
        executables: [{ kind: 'systemTool', id: 'gemini-cli' }],
        envKeys: [
          'GEMINI_API_KEY',
          'GOOGLE_API_KEY',
          'GOOGLE_GENAI_USE_VERTEXAI',
          'GOOGLE_CLOUD_PROJECT',
          'GOOGLE_CLOUD_LOCATION',
          'GOOGLE_APPLICATION_CREDENTIALS',
          'HAPPIER_GEMINI_ACP_AUTH_METHOD',
          'HAPPIER_GEMINI_ACP_AUTH_META',
          'GEMINI_CLI_HOME',
          'HOME',
          'XDG_CONFIG_HOME',
        ],
      },
    }],
    optional: [],
  },
  connectedAccountDescriptors: {
    'gemini-account': {
      declaration: {
        title: 'Gemini',
        ui: { iconResourceId: 'agent-mark', setup: { order: 2, firstRun: true, catalogDescription: { key: 'connectedServicesSettings.catalogGemini', fallback: 'API key or a Google Cloud service account.' } } },
        authentication: {
          account: { artifactId: 'connected-account-authentication', exportName: 'activate' },
          defaultModeId: 'api-key',
          modes: [{
            id: 'api-key',
            kind: 'manual',
            apiKey: true,
            setup: {
              url: 'https://aistudio.google.com/apikey',
              checklist: ['Create a Gemini API key in Google AI Studio for the project you want to use.', 'Copy the key and paste it here.'],
              createKeyTitle: 'Open Google AI Studio API keys',
            },
            accountDirectSave: { fieldKeys: { token: 'apiKey' } },
            directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
            outcomeReconciliation: 'none',
            fields: [{
              id: 'token',
              title: 'Gemini API key',
              schema: { type: 'string', minLength: 1 },
              secret: true,
            }],
          }, {
            id: 'service-account',
            kind: 'manual',
            setup: {
              url: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
              checklist: ['Select your Google Cloud project and a service account with the Vertex AI access you need.', 'Open its Keys tab, choose Add key > Create new key, and select JSON.', 'Paste the full downloaded JSON file here.'],
              createKeyTitle: 'Open Google Cloud service accounts',
            },
            directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
            title: 'Google service account',
            outcomeReconciliation: 'none',
            fields: [{
              id: 'credentialsJson',
              title: 'Service-account JSON',
              schema: { type: 'string', minLength: 1 },
              secret: true,
            }],
          }],
        },
      },
      runtime: geminiConnectedAccountRuntime,
      accountRuntime: geminiPortableAuthentication,
    },
  },
  agents: {
    gemini: {
      declaration: {
        title: 'Gemini',
        runtime: { kind: 'custom' },
        providerRequirements: {
          acceptsProtocols: ['gemini'],
          required: { streaming: true, toolRoundTrips: true },
          credentialSupport: { supportsNoAuth: false, apiKeyTransports: [{ protocol: 'gemini',
            destination: { kind: 'httpHeader', names: ['x-goog-api-key'], formats: ['raw'] } }] },
          authIsolation: { suppressConnectedServiceIds: ['gemini'], ownedEnvKeys: [...GEMINI_PROVIDER_OWNED_ENV_KEYS] },
          materialization: 'spawnEnv', applyPolicy: 'restart_session', supportsFreeformModelIds: true,
        },
        cli: {
          displayName: 'Google Gemini CLI',
          executable: {
            binaryName: 'gemini',
            knownUserBinDirSuffixes: null,
            sourcePreference: 'system-first',
          },
          install: {
            managed: {
              kind: 'managed_package',
              packageName: '@google/gemini-cli',
              binaryName: 'gemini',
            },
            manual: { kind: 'command' },
            recommendationOrder: 30,
            guideUrl: null,
            docsUrl: 'https://goo.gle/gemini-cli-auth-docs',
          },
          auth: {
            support: 'unsupported',
            environmentVariables: [
                'GEMINI_API_KEY',
                'GOOGLE_API_KEY',
                'GOOGLE_GENAI_USE_VERTEXAI',
                'GOOGLE_CLOUD_PROJECT',
                'GOOGLE_CLOUD_LOCATION',
            ],
            loginLaunches: [],
          },
        },
        sessionModeDescriptor: AGENT_DEFINITION.sessionModeDescriptor,
        primary: 'sessions',
        catalog: {
          agentCliSystemTool: { toolId: 'gemini-cli' },
          acpRegistryIds: [...AGENT_DEFINITION.acpRegistryIds],
          vendorResume: { support: AGENT_DEFINITION.core.resume.vendorResume },
        },
        connectedAccounts: [{
          purpose: 'model_upstream',
          service: 'gemini-account',
          required: false,
          materializationKinds: ['files', 'environment'],
          credentialKinds: ['token'],
        }],
        surfaces: {
          externalSession: {
            externalLinkedTakeover: { writerSafety: 'unsupported' },
            sources: [{
              sourceKind: 'geminiConfigDir',
              contentSearch: true,
              schema: { fields: [{ kind: 'literal', name: 'kind', value: 'geminiConfigDir' },
                { kind: 'string', name: 'configDir', min: 1, max: 10_000, nullish: true }] },
              key: { segments: [{ kind: 'literal', value: 'geminiConfigDir' }, { kind: 'field', field: 'configDir' }] },
              instances: [{ kind: 'default', constants: {} }],
            }],
          },
        },
        capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
          surfaces: ['externalSessions'],
          skills: {
            delivery: 'session_dir', nativeDisable: 'supported', liveReload: 'unsupported',
            nativeRoots: {
              user: [['.gemini', 'skills'], ['.agents', 'skills']],
              project: [['.gemini', 'skills'], ['.agents', 'skills']],
            },
          },
          sessions: {
            open: ['create', 'resume'],
            delivery: ['newTurn', 'followUp'],
            cancel: true,
            executionRunContext: { versions: [1] },
          },
        }),
      },
      externalSessions: geminiExternalSessionsContribution,
      factory: createGeminiAgentRuntime,
      providerBinding: GEMINI_PROVIDER_BINDING_ADAPTER_V1,
      preflightSessionControls: GEMINI_PREFLIGHT_SESSION_CONTROLS,
      connectedAccountLaunch: {
        switchContinuity: {
          continuityMode: 'restart_same_home',
          supportedTransitions: ['native_to_connected', 'connected_to_connected', 'same_connected_group'],
        },
        fileEnvironmentUses: [{
          purpose: 'model_upstream',
          fileId: 'google-service-account.json',
          environmentKey: 'GOOGLE_APPLICATION_CREDENTIALS',
        }],
        environmentUses: [
          { purpose: 'model_upstream', environmentKey: 'GEMINI_API_KEY' },
          { purpose: 'model_upstream', environmentKey: 'GOOGLE_API_KEY' },
          { purpose: 'model_upstream', environmentKey: 'GOOGLE_GENAI_USE_VERTEXAI' },
          { purpose: 'model_upstream', environmentKey: 'GOOGLE_CLOUD_PROJECT' },
          { purpose: 'model_upstream', environmentKey: 'GOOGLE_CLOUD_LOCATION' },
        ],
        stateSharingDescriptor: geminiConnectedServiceStateSharingDescriptor,
        continuity: {
          generationApplicationScope: 'per_session_runtime',
          runtimeAuthAdapter: createGeminiConnectedServiceRuntimeAuthAdapter(),
        },
      },
      cliSessionCommand: {
        sessionRuntimeId: 'gemini',
        accountSettingsAgentId: 'gemini',
      },
      sessionRunnerFactory: {
        module: './agent/runtime/factory',
        export: 'createGeminiAgentRuntime',
        externalSessionsExport: 'geminiExternalSessionsContribution',
        runtimeApiVersion: 1,
      },
    },
  },
  systemTools: {
    'gemini-cli': { title: 'Google Gemini CLI', executableNames: ['gemini'] },
  },
  hooks: {
    'resolve-prerequisites': {
      declaration: {
        on: 'agent.resolvePrerequisites',
        filters: { agentId: 'gemini' },
      },
      handler: resolveGeminiDaemonSpawnPrerequisitesHook,
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
    'agent-mark': { kind: 'asset', path: 'assets/agent-mark.svg', contentType: 'image/svg+xml' },
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

export const PLUGIN_MANIFEST = GEMINI_PLUGIN.manifest;
