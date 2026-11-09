import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';

import { AGENT_DEFINITION } from './agent/definition.js';
import { GROK_PREFLIGHT_SESSION_CONTROLS } from './agent/preflight/models.js';
import { createGrokAgentRuntime } from './agent/runtime/factory.js';
import { grokExternalSessionsContribution } from './agent/externalSessions/contribution.js';


const installScript = 'curl -fsSL https://x.ai/cli/install.sh | bash';

export const { manifest: PLUGIN_MANIFEST, activate } = definePlugin({
  id: 'happier.agent.grok',
  version: '0.0.0',
  displayName: 'Grok',
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [{
      id: 'grok-process',
      capability: 'process',
      reason: 'Run the declared Grok CLI executable with its declared xAI API-key environment.',
      scope: {
        executables: [{ kind: 'systemTool', id: 'grok-cli' }],
        envKeys: ['XAI_API_KEY'],
      },
    }],
    optional: [],
  },
  agents: {
    grok: {
      declaration: {
        title: { key: 'agentInput.agent.grok', fallback: 'Grok' },
        description: {
          key: 'profiles.aiBackend.grokSubtitleExperimental',
          fallback: 'Grok Build CLI (experimental)',
        },
        runtime: { kind: 'custom' },
        primary: 'sessions',
        catalog: {
          agentCliSystemTool: { toolId: 'grok-cli' },
          acpRegistryIds: [...AGENT_DEFINITION.acpRegistryIds],
          vendorResume: { support: AGENT_DEFINITION.core.resume.vendorResume },
        },
        surfaces: {
          externalSession: {
            sources: [{
              sourceKind: 'grokHome', contentSearch: true,
              schema: { fields: [{ kind: 'literal', name: 'kind', value: 'grokHome' }] },
              key: { segments: [{ kind: 'literal', value: 'grokHome' }] },
              instances: [{ kind: 'default', constants: {} }],
            }],
          },
        },
        capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
          surfaces: ['externalSessions'],
          skills: {
            delivery: 'session_dir', nativeDisable: 'unsupported', liveReload: 'unsupported',
            nativeRoots: {
              user: [['.grok', 'skills'], ['.claude', 'skills'], ['.cursor', 'skills']],
              project: [['.grok', 'skills'], ['.agents', 'skills'], ['.claude', 'skills'], ['.cursor', 'skills']],
            },
          },
          sessions: {
            open: ['create', 'resume'],
            delivery: ['newTurn', 'steer', 'followUp'],
            cancel: true,
            configuration: true,
            executionRunContext: { versions: [1] },
            // Grok is a plain ACP stdio Agent: neither its runtime nor the
            // shared ACP protocol emits `runtime-activity-snapshot`, so
            // claiming the capability would pin `runtime.activity` at
            // `unknown` for the whole Session instead of settling at `idle`.
            workStateSources: [{ id: 'goals', itemKinds: ['goal'] }],
          },
        }),
        cli: {
          executable: {
            binaryName: 'grok',
            knownUserBinDirSuffixes: ['.grok/bin', '.local/bin'],
            sourcePreference: 'system-first',
            systemCommandResolutionStrategy: 'path-first',
          },
          install: {
            managed: null,
            manual: {
              kind: 'vendor_recipe',
              recipes: {
                darwin: [{ cmd: 'bash', args: ['-lc', installScript] }],
                linux: [{ cmd: 'bash', args: ['-lc', installScript] }],
                win32: [{
                  cmd: 'powershell.exe',
                  args: [
                    '-NoProfile',
                    '-ExecutionPolicy',
                    'Bypass',
                    '-Command',
                    'irm https://x.ai/cli/install.ps1 | iex',
                  ],
                }],
              },
            },
            guideUrl: 'https://x.ai/cli',
            docsUrl: 'https://x.ai',
          },
          auth: {
            support: 'login_terminal',
            environmentVariables: ['XAI_API_KEY'],
            missingCredentialState: 'unknown',
            loginLaunches: [
              { kind: 'primary', args: ['login'] },
              { kind: 'device_code', args: ['login', '--device-auth'] },
            ],
          },
        },
      },
      factory: createGrokAgentRuntime,
      externalSessions: grokExternalSessionsContribution,
      preflightSessionControls: GROK_PREFLIGHT_SESSION_CONTROLS,
      sessionRunnerFactory: {
        module: './agent/runtime/factory',
        export: 'createGrokAgentRuntime',
        externalSessionsExport: 'grokExternalSessionsContribution',
        runtimeApiVersion: 1,
      },
    },
  },
  systemTools: {
    'grok-cli': {
      title: 'Grok Build CLI',
      executableNames: ['grok'],
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
});
