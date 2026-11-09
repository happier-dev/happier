import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { devinNativeConnectedAccountRuntime } from './connectedAccounts/nativeRuntime.js';
import { DEVIN_CONNECTED_ACCOUNT_LAUNCH, DEVIN_NATIVE_PURPOSE } from './agent/connectedAccount.js';
import { devinAccountAuthentication } from './connectedAccounts/account.js';

import { detectDevinCliAuthStatus } from './agent/auth/status.js';
import { DEVIN_ACP_RUNTIME_DECLARATION } from './agent/acp/runtimeDeclaration.js';
import { DEVIN_ACP_COMMAND } from './agent/acp/preflight.js';
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
      id: 'devin-oauth',
      capability: 'network',
      reason: 'Exchange a Devin browser authorization code and read optional account identity.',
      scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://api.devin.ai' }], methods: ['GET', 'POST'] },
    }, {
      id: 'devin-process',
      capability: 'process',
      reason: 'Run the declared Devin CLI executable.',
      scope: {
        executables: [{ kind: 'systemTool', id: DEVIN_ACP_COMMAND.toolId }],
        envKeys: ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'APPDATA', 'WINDSURF_API_KEY', 'HAPPIER_DEVIN_NATIVE_DATA_HOME'],
      },
    }, {
      id: 'devin-native-history',
      capability: 'filesystem',
      reason: 'Read native Devin history as bytes and query a private disposable copy.',
      scope: { locations: [{ root: 'workspace' }], access: ['read'] },
    }],
    optional: [],
  },
  connectedAccountDescriptors: {
    'devin-account': {
      declaration: {
        title: 'Devin',
        authentication: {
          account: { artifactId: 'connected-account-authentication', exportName: 'activate' },
          native: { systemTool: DEVIN_ACP_COMMAND.toolId },
          defaultModeId: 'browser-session',
          modes: [{
            id: 'browser-session', kind: 'oauthAuthorizationCode', title: 'Sign in with Devin',
            callbackUrl: 'https://app.happier.dev/oauth/mcp/callback',
            scopes: [], pkce: 'required', allowRawAuthorizationCode: true, outcomeReconciliation: 'none',
          }, {
            id: 'enterprise-seat', kind: 'manual', title: 'Enterprise seat credential', outcomeReconciliation: 'none',
            setup: {
              url: 'https://docs.devin.ai/cli/enterprise/devin-auth',
              checklist: ['Your enterprise administrator must grant the Use Devin CLI role.', 'Use the native enterprise seat credential and its matching API server.'],
              createKeyTitle: 'Read enterprise sign-in instructions',
            },
            fields: [
              { id: 'seatToken', title: 'Enterprise seat credential', secret: true, schema: { type: 'string', minLength: 1 } },
              { id: 'apiServerUrl', title: 'API server URL', secret: false, schema: { type: 'string', minLength: 1 } },
            ],
          }, {
            id: 'native-import', kind: 'manual', title: 'Import native login', credentialOrigin: 'native_import',
            browserReachability: 'unreachable', outcomeReconciliation: 'none',
            fields: [{ id: 'source', title: 'Source', secret: false, default: 'native',
              schema: { type: 'string', enum: ['native'] } }],
          }],
        },
      },
      runtime: devinNativeConnectedAccountRuntime,
      accountRuntime: devinAccountAuthentication,
    },
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
        sessionModeDescriptor: AGENT_DEFINITION.sessionModeDescriptor,
        primary: 'sessions',
        connectedAccounts: [{ purpose: DEVIN_NATIVE_PURPOSE, service: 'devin-account',
          materializationKinds: ['files'], credentialKinds: ['oauth', 'token'], required: false }],
        catalog: {
          agentCliSystemTool: { toolId: DEVIN_ACP_COMMAND.toolId },
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
      connectedAccountLaunch: DEVIN_CONNECTED_ACCOUNT_LAUNCH,
      externalSessions: devinExternalSessionsContribution,
      cliAuth: {
        detectAuthStatus: async ({ runDeclaredSystemToolCommand }) =>
          await detectDevinCliAuthStatus({
            runCommand: async (args, options) => await runDeclaredSystemToolCommand({
              toolId: DEVIN_ACP_COMMAND.toolId,
              args,
              ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
            }),
          }),
      },
      terminal: DEVIN_TERMINAL_SURFACE,
    },
  },
  systemTools: {
    [DEVIN_ACP_COMMAND.toolId]: { title: 'Devin CLI', executableNames: ['devin'] },
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
