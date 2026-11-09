import { createKimiAgentRuntime } from './agent/runtime/factory.js';
import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';

import { AGENT_DEFINITION } from './agent/definition.js';
import { KIMI_ACP_COMMAND, KIMI_PREFLIGHT_SESSION_CONTROLS } from './agent/acp/preflight.js';
import { KIMI_SYSTEM_TOOL_READINESS } from './agent/readiness/declaration.js';
import { kimiExternalSessionsContribution } from './agent/externalSessions/contribution.js';
import { KIMI_CONNECTED_ACCOUNT_LAUNCH } from './agent/connectedAccount.js';
import { createKimiNativeConnectedAccountRuntime } from './connectedAccounts/nativeRuntime.js';
import { kimiPortableAccountRuntime } from './connectedAccounts/runtime.js';

const regionConfiguration = {
  scope: 'account', changeBehavior: 'reconnect', fields: [{
    id: 'region', title: 'Kimi region', secret: false, required: true, default: 'cn',
    schema: { type: 'string', enum: ['cn', 'global'] },
  }],
} as const;


export const KIMI_PLUGIN = definePlugin({
  id: 'happier.agent.kimi',
  version: '0.0.0',
  displayName: 'Kimi', entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [{
      id: 'kimi-native-history',
      capability: 'filesystem',
      reason: 'Read native Kimi Code conversation history.',
      scope: { locations: [{ root: 'workspace' }], access: ['read'] },
    }, {
      id: 'kimi-process',
      capability: 'process',
      reason: 'Run the declared Kimi CLI executable.',
      scope: {
        executables: [{ kind: 'systemTool', id: KIMI_ACP_COMMAND.toolId }],
        envKeys: ['KIMI_CODE_HOME', 'HAPPIER_KIMI_ACCESS_TOKEN', ...KIMI_CONNECTED_ACCOUNT_LAUNCH.environmentUnsetUses.map(use => use.environmentKey)],
      },
    }, {
      id: 'kimi-account-network', capability: 'network',
      reason: 'Connect the selected Kimi account and read its models, identity and usage.',
      scope: { targets: [
        { kind: 'fixedOrigin', origin: 'https://auth.kimi.com' },
        { kind: 'fixedOrigin', origin: 'https://auth.kimi.ai' },
        { kind: 'fixedOrigin', origin: 'https://api.kimi.com' },
        { kind: 'fixedOrigin', origin: 'https://api.kimi.ai' },
        { kind: 'fixedOrigin', origin: 'https://api.moonshot.cn' },
        { kind: 'fixedOrigin', origin: 'https://api.moonshot.ai' },
      ], methods: ['GET', 'POST'] },
    }],
  },
  connectedAccountDescriptors: {
    'kimi-code': {
      declaration: {
        title: 'Kimi Code',
        authentication: {
          account: { artifactId: 'connected-account-authentication', exportName: 'activate' },
          native: { systemTool: KIMI_ACP_COMMAND.toolId },
          defaultModeId: 'device',
          modes: [{
            id: 'device', kind: 'oauthDeviceCode', title: 'Kimi Code subscription',
            browserReachability: 'unreachable', outcomeReconciliation: 'none', scopes: [],
            configuration: regionConfiguration,
          }, {
            id: 'api-key', kind: 'manual', apiKey: true, title: 'Kimi API key', outcomeReconciliation: 'none',
            credentialOrigin: 'authentication',
            fields: [{ id: 'token', title: 'API key', secret: true, schema: { type: 'string', minLength: 1 } }],
            configuration: { ...regionConfiguration, fields: [...regionConfiguration.fields, {
              id: 'apiKind', title: 'API', secret: false, required: true, default: 'code',
              schema: { type: 'string', enum: ['code', 'platform'] },
            }] },
          }, {
            id: 'native-import', kind: 'manual', title: 'Import Node Kimi login',
            browserReachability: 'unreachable', credentialOrigin: 'native_import', outcomeReconciliation: 'none',
            fields: [{ id: 'source', title: 'Source', secret: false, default: 'native', schema: { type: 'string', enum: ['native'] } }],
          }],
        },
      },
      runtime: createKimiNativeConnectedAccountRuntime(),
      accountRuntime: kimiPortableAccountRuntime,
    },
  },
  agents: {
    kimi: {
      declaration: {
        title: { key: 'agentInput.agent.kimi', fallback: 'Kimi' },
        description: { key: 'profiles.aiBackend.kimiSubtitleExperimental', fallback: 'Kimi coding agent (experimental)' },
        runtime: { kind: 'custom' },
        cli: {
          displayName: 'Kimi Code CLI',
          executable: {
            binaryName: 'kimi',
            knownUserBinDirSuffixes: ['.local/bin'],
            sourcePreference: 'system-first',
            systemCommandResolutionStrategy: 'path-first',
          },
          install: {
            managed: null,
            manual: {
              kind: 'vendor_recipe',
              recipes: {
                darwin: [{ cmd: 'bash', args: ['-lc', 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash'] }],
                linux: [{ cmd: 'bash', args: ['-lc', 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash'] }],
                win32: [{
                  cmd: 'powershell.exe',
                  args: [
                    '-NoProfile',
                    '-ExecutionPolicy',
                    'Bypass',
                    '-Command',
                    'Invoke-RestMethod https://code.kimi.com/kimi-code/install.ps1 | Invoke-Expression',
                  ],
                }],
              },
            },
            guideUrl: 'https://moonshotai.github.io/kimi-code/docs/en/reference/kimi-command.html',
            docsUrl: 'https://moonshotai.github.io/kimi-code/',
          },
          auth: {
            support: 'login_terminal',
            loginLaunches: [{ kind: 'primary', args: ['login'] }],
          },
        },
        sessionModeDescriptor: AGENT_DEFINITION.sessionModeDescriptor,
        primary: 'sessions',
        connectedAccounts: [{ purpose: 'primary', service: 'kimi-code', required: false,
          materializationKinds: ['files', 'environment'], credentialKinds: ['oauth', 'token'] }],
        catalog: {
          agentCliSystemTool: { toolId: KIMI_ACP_COMMAND.toolId },
          acpRegistryIds: [...AGENT_DEFINITION.acpRegistryIds],
          vendorResume: { support: AGENT_DEFINITION.core.resume.vendorResume },
        },
        surfaces: {
          externalSession: {
            externalLinkedTakeover: { writerSafety: 'unsupported' },
            sources: [{
              sourceKind: 'kimiCodeHome',
              contentSearch: true,
              schema: { fields: [
                { kind: 'literal', name: 'kind', value: 'kimiCodeHome' },
                { kind: 'string', name: 'homeDir', nullish: true },
              ] },
              key: { segments: [{ kind: 'literal', value: 'kimiCodeHome' }] },
              instances: [{ kind: 'default', constants: {} }],
            }],
          },
        },
        capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
          skills: { delivery: 'none', nativeDisable: 'unsupported', liveReload: 'unsupported',
            nativeRoots: { user: [['.config', 'agents', 'skills'], ['.agents', 'skills'], ['.kimi', 'skills'], ['.claude', 'skills'], ['.codex', 'skills']], project: [['.agents', 'skills'], ['.kimi', 'skills'], ['.claude', 'skills'], ['.codex', 'skills']] } },
          surfaces: ['externalSessions'],
          sessions: {
            open: ['create', 'resume'],
            delivery: ['newTurn', 'followUp'],
            cancel: true,
            configuration: true,
            executionRunContext: { versions: [1] },
          },
        }),
      },
      factory: createKimiAgentRuntime,
      connectedAccountLaunch: KIMI_CONNECTED_ACCOUNT_LAUNCH,
      preflightSessionControls: KIMI_PREFLIGHT_SESSION_CONTROLS,
      externalSessions: kimiExternalSessionsContribution,
      sessionRunnerFactory: {
        module: './agent/runtime/factory', export: 'createKimiAgentRuntime',
        externalSessionsExport: 'kimiExternalSessionsContribution', runtimeApiVersion: 1,
      },
    },
  },
  systemTools: {
    // Kimi Code installs one executable, `kimi`. The superseded Python
    // `kimi-cli` binary name is deliberately not resolvable: launching it would give
    // a runtime that negotiates neither the session controls nor the MCP
    // transport this Agent declares, and the host would then fail one operation
    // at a time instead of the install being visibly wrong. `kimi-cli` survives
    // only as a session `flavorAlias`, so existing Sessions still resolve.
    //
    // Selection is by observed command behavior, never by version output:
    // retired `kimi-cli` releases sort above current Kimi Code releases, and a
    // legacy install may even own the `kimi` name while answering `kimi acp`
    // without the `migrate` command surface. The host probes every runnable
    // `kimi` candidate with an ACP initialize fingerprint plus `migrate --help`,
    // selects the first current fingerprint, and otherwise fails with the
    // provider-owned guidance below. `kimi-cli` names only inform the legacy
    // diagnostic; they are never granted or launched. The declaration lives in
    // `agent/readiness/declaration.ts` so it stays independently testable.
    [KIMI_ACP_COMMAND.toolId]: {
      title: 'Kimi Code CLI',
      executableNames: ['kimi'],
      readiness: KIMI_SYSTEM_TOOL_READINESS,
    },
  },
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

export const PLUGIN_MANIFEST = KIMI_PLUGIN.manifest;
