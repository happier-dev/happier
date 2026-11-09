import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';

import { detectDevinCliAuthStatus } from './agent/auth/status.js';
import { DEVIN_ACP_RUNTIME_DECLARATION } from './agent/acp/runtimeDeclaration.js';
import { AGENT_DEFINITION } from './agent/definition.js';
import { DEVIN_TERMINAL_SURFACE } from './agent/terminal/contribution.js';
import { DEVIN_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';

import { devinExternalSessionsContribution } from './agent/externalSessions/contribution.js';

const {
  id: DEVIN_AGENT_SETTINGS_CONTRIBUTION_ID,
  ...DEVIN_AGENT_SETTINGS_DECLARATION
} = DEVIN_AGENT_SETTINGS_CONTRIBUTION;

export const DEVIN_PLUGIN = definePlugin({
  id: 'happier.agent.devin',
  version: '0.0.0',
  displayName: 'Devin',
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [{
      id: 'devin-process',
      capability: 'process',
      reason: 'Run the declared Devin CLI executable.',
      scope: {
        executables: [{ kind: 'systemTool', id: 'devin-cli' }],
        envKeys: ['XDG_CONFIG_HOME', 'APPDATA'],
      },
    }, {
      id: 'devin-native-history',
      capability: 'filesystem',
      reason: 'Read native Devin history as bytes and query a private disposable copy.',
      scope: { locations: [{ root: 'workspace' }], access: ['read'] },
    }],
    optional: [],
  },
  agents: {
    devin: {
      declaration: {
        title: { key: 'agentInput.agent.devin', fallback: 'Devin' },
        description: {
          key: 'profiles.aiBackend.devinSubtitleExperimental',
          fallback: 'Devin CLI (experimental)',
        },
        runtime: DEVIN_ACP_RUNTIME_DECLARATION,
        cli: {
          displayName: 'Devin CLI',
          executable: {
            binaryName: 'devin',
            knownUserBinDirSuffixes: ['.local/bin'],
            sourcePreference: 'system-first',
            systemCommandResolutionStrategy: 'path-first',
          },
          install: {
            managed: null,
            manual: { kind: 'command' },
            guideUrl: 'https://docs.devin.ai/work-with-devin/devin-cli',
            docsUrl: 'https://docs.devin.ai/work-with-devin/devin-cli',
          },
          auth: {
            support: 'login_terminal',
            nonInteractiveStatusProbe: true,
            loginLaunches: [{ kind: 'primary', args: ['auth', 'login'] }],
          },
        },
        primary: 'sessions',
        catalog: {
          agentCliSystemTool: { toolId: 'devin-cli' },
          acpRegistryIds: [...AGENT_DEFINITION.acpRegistryIds],
          vendorResume: { support: AGENT_DEFINITION.core.resume.vendorResume },
        },
        capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
          surfaces: ['externalSessions'],
          skills: { delivery: 'session_dir', nativeDisable: 'unsupported', liveReload: 'unsupported',
            nativeRoots: { user: [['.config', 'devin', 'skills'], ['.config', 'cognition', 'skills'], ['.agents', 'skills']], project: [['.devin', 'skills'], ['.cognition', 'skills'], ['.agents', 'skills'], ['.windsurf', 'skills']] } },
          sessions: {
            open: ['create', 'resume'],
            delivery: ['newTurn', 'followUp'],
            cancel: true,
            configuration: true,
            executionRunContext: { versions: [1] },
          },
        }),
        surfaces: {
          externalSession: {
            externalLinkedTakeover: { writerSafety: 'unsupported' },
            sources: [{
              sourceKind: 'devinHome',
              contentSearch: true,
              schema: { fields: [
                { kind: 'literal', name: 'kind', value: 'devinHome' },
                { kind: 'string', name: 'devinHome', min: 1, nullish: true },
              ] },
              key: { segments: [{ kind: 'literal', value: 'devinHome' }, { kind: 'field', field: 'devinHome' }] },
              instances: [{ kind: 'default', constants: {} }],
            }],
          },
        },
      },
      externalSessions: devinExternalSessionsContribution,
      cliAuth: {
        detectAuthStatus: async ({ runDeclaredSystemToolCommand }) =>
          await detectDevinCliAuthStatus({
            runCommand: async (args, options) => await runDeclaredSystemToolCommand({
              toolId: 'devin-cli',
              args,
              ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
            }),
          }),
      },
      terminal: DEVIN_TERMINAL_SURFACE,
    },
  },
  systemTools: {
    'devin-cli': { title: 'Devin CLI', executableNames: ['devin'] },
  },
  settings: {
    [DEVIN_AGENT_SETTINGS_CONTRIBUTION_ID]: DEVIN_AGENT_SETTINGS_DECLARATION,
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

export const PLUGIN_MANIFEST = DEVIN_PLUGIN.manifest;
