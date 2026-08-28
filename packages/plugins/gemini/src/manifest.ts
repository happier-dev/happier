import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';
import type { HookHandler } from '@happier-dev/plugin-sdk/hooks';

import { AGENT_DEFINITION } from './agent/definition.js';
import { geminiConnectedServiceStateSharingDescriptor } from './agent/connectedServices/descriptor.js';
import { createGeminiConnectedServiceRuntimeAuthAdapter } from './agent/connectedServices/runtimeAuthAdapter.js';
import { resolveGeminiDaemonSpawnPrerequisites } from './agent/lifecycle/spawnHooks.js';
import { createGeminiAgentRuntime } from './agent/runtime/factory.js';
import { geminiConnectedAccountRuntime } from './connectedAccounts/runtime.js';
import { GEMINI_UI_TRANSLATION_BUNDLES } from './ui/translations.js';

const resolveGeminiDaemonSpawnPrerequisitesHook: HookHandler =
  (event, context) =>
    resolveGeminiDaemonSpawnPrerequisites(event, context);

export const GEMINI_PLUGIN = definePlugin({
  id: 'happier.agent.gemini',
  version: '0.0.0',
  displayName: 'Gemini',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [{
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
        authentication: {
          defaultModeId: 'api-key',
          modes: [{
            id: 'api-key',
            kind: 'manual',
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
    },
  },
  agents: {
    gemini: {
      declaration: {
        title: 'Gemini',
        runtime: { kind: 'custom' },
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
        primary: 'sessions',
        catalog: {
          vendorResume: { support: AGENT_DEFINITION.core.resume.vendorResume },
        },
        connectedAccounts: [{
          purpose: 'model_upstream',
          service: 'gemini-account',
          required: false,
          materializationKinds: ['files', 'environment'],
          credentialKinds: ['token'],
        }],
        capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
          sessions: { open: ['create', 'resume'], delivery: ['newTurn', 'steer', 'followUp'], cancel: true },
          executionRuns: { open: ['create'], checkpoint: true, stop: true },
        }),
      },
      factory: createGeminiAgentRuntime,
      connectedAccountLaunch: {
        switchContinuity: {
          continuityMode: 'restart_same_home',
          supportedTransitions: ['native_to_connected', 'connected_to_connected'],
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
        hookApiVersion: 1,
        category: 'decision',
        scope: 'agent',
        filters: { agentId: 'gemini' },
        executionKind: 'decide',
      },
      handler: resolveGeminiDaemonSpawnPrerequisitesHook,
    },
  },
  ui: {
    translations: GEMINI_UI_TRANSLATION_BUNDLES,
  },
});

export const PLUGIN_MANIFEST = GEMINI_PLUGIN.manifest;
