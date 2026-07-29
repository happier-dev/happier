import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';

import { GEMINI_UI_TRANSLATIONS } from './ui/translations.js';

export const PLUGIN_MANIFEST = {
  schemaVersion: 2,
  id: 'happier.agent.gemini',
  version: '0.0.0',
  displayName: 'Gemini',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './dist/index.js' },
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
  contributes: {
    connectedAccountDescriptors: [{
      id: 'gemini-account',
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
    }],
    agents: [{
      id: 'gemini',
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
          probe: {
            parser: 'envOnly',
            backgroundChecks: 'safe',
            statusArgs: null,
            envVars: [
              'GEMINI_API_KEY',
              'GOOGLE_API_KEY',
              'GOOGLE_GENAI_USE_VERTEXAI',
              'GOOGLE_CLOUD_PROJECT',
              'GOOGLE_CLOUD_LOCATION',
            ],
          },
          loginLaunches: [],
        },
      },
      primary: 'sessions',
      connectedAccounts: [{
        purpose: 'model_upstream',
        service: 'gemini-account',
        required: false,
        materializationKinds: ['files', 'environment'],
      }],
      capabilities: { sessions: { open: ['create', 'resume'], delivery: ['newTurn', 'steer', 'followUp'], cancel: true }, executionRuns: { open: ['create'], checkpoint: true, stop: true } },
    }],
    systemTools: [{ id: 'gemini-cli', title: 'Google Gemini CLI', executableNames: ['gemini'] }],
    hooks: [{ id: 'resolve-prerequisites', on: 'agent.resolvePrerequisites', category: 'decision', scope: 'agent', filters: { agentId: 'gemini' }, executionKind: 'decide' }],
    ui: {
      translations: [{ locale: 'en', messages: GEMINI_UI_TRANSLATIONS.en }],
    },
  },
} satisfies PluginManifest;
