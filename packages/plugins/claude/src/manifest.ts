import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';
import {
  HAPPIER_CLAUDE_CONFIG_DIR_ENV,
  HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON_ENV,
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON_ENV,
} from '@happier-dev/plugin-sdk/experimental/envConstants';

import { CLAUDE_PROVIDER_OWNED_ENV_KEYS } from './agent/providerBinding/adapter.js';
import { CLAUDE_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';
import { CLAUDE_UI_TRANSLATIONS } from './ui/translations.js';
import { ANTHROPIC_PROVIDER_CONTRIBUTION } from './provider/contribution.js';

export const PLUGIN_MANIFEST = {
  schemaVersion: 2,
  id: 'happier.agent.claude',
  version: '0.0.0',
  displayName: 'Claude',
  description: 'Claude Code coding agent.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './dist/index.js' },
  hostAccess: {
    required: [
      {
        id: 'claude-workspace',
        capability: 'filesystem',
        reason: 'Use the admitted Agent workspace as the Claude process working directory.',
        scope: {
          locations: [{ root: 'workspace' }],
          access: ['read'],
        },
      },
      {
        id: 'claude-process',
        capability: 'process',
        reason: 'Run the declared Claude Code executable and its macOS keychain boundary.',
        scope: { executables: [
          { kind: 'systemTool', id: 'claude-cli' },
          { kind: 'systemTool', id: 'macos-security' },
        ], envKeys: [
          ...CLAUDE_PROVIDER_OWNED_ENV_KEYS,
          'CLAUDE_CONFIG_DIR',
          'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
          'CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH',
          HAPPIER_CLAUDE_CONFIG_DIR_ENV,
          HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON_ENV,
          HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON_ENV,
          'USER',
        ] },
      },
      {
        id: 'claude-terminal-control',
        capability: 'terminal',
        reason: 'Run Claude through the host-owned terminal session substrate.',
        scope: { operations: ['open', 'send', 'resize', 'close'] },
      },
      {
        id: 'claude-session-runtime-control',
        capability: 'sessions',
        reason: 'Read Claude lifecycle events and control authenticated hooks for the current Agent session.',
        scope: { access: ['read', 'control'] },
      },
      {
        id: 'claude-subscription-oauth',
        capability: 'network',
        reason: 'Exchange and refresh Claude OAuth credentials for the exact Connected Account.',
        scope: {
          targets: [
            { kind: 'fixedOrigin', origin: 'https://platform.claude.com' },
            { kind: 'connectedAccountOrigin', service: 'claude-subscription' },
          ],
          methods: ['POST'],
        },
      },
      {
        id: 'claude-subscription-quota',
        capability: 'network',
        reason: 'Read quota for the exact Claude Subscription Connected Account.',
        scope: {
          targets: [
            { kind: 'fixedOrigin', origin: 'https://api.anthropic.com' },
            { kind: 'connectedAccountOrigin', service: 'claude-subscription' },
          ],
          methods: ['GET'],
        },
      },
    ],
    optional: [],
  },
  contributes: {
    providers: [ANTHROPIC_PROVIDER_CONTRIBUTION],
    connectedAccountDescriptors: [{
      id: 'claude-subscription',
      title: 'Claude',
      authentication: {
        defaultModeId: 'setup-token',
        modes: [{
          id: 'setup-token',
          kind: 'manual',
          title: 'Setup token',
          outcomeReconciliation: 'none',
          fields: [{
            id: 'token',
            title: 'Claude setup token',
            schema: { type: 'string', minLength: 1 },
            secret: true,
          }],
        }, {
          id: 'oauth',
          kind: 'oauthAuthorizationCode',
          scopes: [
            'user:inference',
            'user:profile',
            'user:sessions:claude_code',
            'user:mcp_servers',
            'user:file_upload',
          ],
          pkce: 'required',
          outcomeReconciliation: 'none',
        }],
      },
    }, {
      id: 'anthropic',
      title: 'Anthropic API key',
      authentication: {
        defaultModeId: 'api-key',
        modes: [{
          id: 'api-key',
          kind: 'manual',
          outcomeReconciliation: 'none',
          fields: [{
            id: 'token',
            title: 'Anthropic API key',
            schema: { type: 'string', minLength: 1 },
            secret: true,
          }],
        }],
      },
    }],
    agents: [{
      id: 'claude',
      title: 'Claude',
      runtime: { kind: 'custom' },
      cli: {
        displayName: 'Claude Code CLI',
        executable: {
          binaryName: 'claude',
          knownUserBinDirSuffixes: ['.local/bin'],
          sourcePreference: 'system-first',
          acceptsJavaScriptFileOverride: true,
          systemCommandResolutionStrategy: 'known-user-first-runnable',
        },
        install: {
          managed: null,
          manual: {
            kind: 'vendor_recipe',
            recipes: {
              darwin: [{ cmd: 'bash', args: ['-lc', 'curl -fsSL https://claude.ai/install.sh | bash'] }],
              linux: [{ cmd: 'bash', args: ['-lc', 'curl -fsSL https://claude.ai/install.sh | bash'] }],
              win32: [{
                cmd: 'powershell',
                args: [
                  '-NoProfile',
                  '-ExecutionPolicy',
                  'Bypass',
                  '-Command',
                  'irm https://claude.ai/install.ps1 | iex',
                ],
              }],
            },
          },
          recommendationOrder: 10,
          guideUrl: 'https://code.claude.com/docs/en/setup',
          docsUrl: 'https://claude.ai',
        },
        auth: {
          support: 'login_terminal',
          machineLoginKey: 'claude-code',
          probe: {
            parser: 'claudeCredentialsFile',
            backgroundChecks: 'safe',
            statusArgs: null,
            envVars: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
            credentialPaths: ['~/.claude/.credentials.json', '~/.claude/.claude.json'],
          },
          loginLaunches: [{ kind: 'primary', args: [], initialInput: '/login\r' }],
        },
      },
      primary: 'sessions',
      connectedAccounts: [{
        purpose: 'model_upstream',
        service: 'claude-subscription',
        required: false,
        materializationKinds: ['environment', 'files', 'httpHeaders'],
      }, {
        purpose: 'model_upstream_api_key',
        service: 'anthropic',
        required: false,
        materializationKinds: ['environment'],
      }],
      capabilities: {
        surfaces: ['terminal', 'externalSessions'],
        sessions: {
          open: ['create', 'resume'],
          delivery: ['newTurn', 'steer', 'followUp'],
          cancel: true,
          configuration: true,
          goals: {
            active: {
              clear: true,
              set: { fields: ['objective'] },
            },
            inactive: {
              get: true,
              clear: true,
              set: { fields: ['objective'] },
            },
            source: 'goals',
          },
          runtimeActivitySnapshots: true,
          workStateSources: [{ id: 'goals', itemKinds: ['goal'] }],
        },
        executionRuns: { open: ['create'], checkpoint: true, stop: true },
      },
      providerRequirements: {
        acceptsProtocols: ['anthropic'],
        required: { streaming: true, toolRoundTrips: true },
        credentialSupport: {
          supportsNoAuth: true,
          apiKeyTransports: [
            {
              protocol: 'anthropic',
              destination: { kind: 'httpHeader', names: ['authorization'], formats: ['bearer'] },
            },
            {
              protocol: 'anthropic',
              destination: { kind: 'httpHeader', names: ['x-api-key'], formats: ['raw'] },
            },
          ],
        },
        authIsolation: {
          suppressConnectedServiceIds: ['claude-subscription', 'anthropic'],
          ownedEnvKeys: [
            'ANTHROPIC_BASE_URL',
            'ANTHROPIC_CUSTOM_HEADERS',
            'ANTHROPIC_API_KEY',
            'ANTHROPIC_AUTH_TOKEN',
            'ANTHROPIC_OAUTH_TOKEN',
            'CLAUDE_CODE_OAUTH_TOKEN',
            'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
            'CLAUDE_CODE_OAUTH_SCOPES',
            'CLAUDE_CODE_SETUP_TOKEN',
            'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
          ],
        },
        materialization: 'spawnEnv',
        applyPolicy: 'live',
        supportsFreeformModelIds: true,
      },
      surfaces: { externalSession: {
        externalLinkedTakeover: { writerSafety: 'unsupported' },
        sources: [{
        sourceKind: 'claudeConfig',
        schema: { passthrough: true, fields: [
          { name: 'kind', kind: 'literal', value: 'claudeConfig' },
          { name: 'configDir', kind: 'string', min: 1, max: 10_000, nullish: true },
          { name: 'projectId', kind: 'string', min: 1, max: 2_000, nullish: true },
        ] },
        key: { segments: [
          { kind: 'literal', value: 'claudeConfig' },
          { kind: 'field', field: 'configDir' },
          { kind: 'field', field: 'projectId' },
        ] },
        instances: [{ kind: 'default', constants: {} }],
      }],
      } },
    }],
    systemTools: [
      { id: 'claude-cli', title: 'Claude Code CLI', executableNames: ['claude'] },
      { id: 'macos-security', title: 'macOS Keychain security', executableNames: ['security'] },
    ],
    hooks: [
      {
        id: 'resolve-prerequisites',
        on: 'agent.resolvePrerequisites',
        category: 'decision',
        scope: 'agent',
        filters: { agentId: 'claude' },
        executionKind: 'decide',
      },
      {
        id: 'augment-spawn-env',
        on: 'agent.spawnEnv.augment',
        category: 'augmentation',
        scope: 'daemon',
        filters: { agentId: 'claude' },
        executionKind: 'augment',
      },
    ],
    mcp: {
      servers: [],
      discoveryProviders: [{
        id: 'config',
        title: 'Claude MCP configuration',
        metadata: { agentId: 'claude' },
      }],
    },
    ui: {
      translations: [{ locale: 'en', messages: CLAUDE_UI_TRANSLATIONS.en }],
    },
    settings: [CLAUDE_AGENT_SETTINGS_CONTRIBUTION],
  },
} satisfies PluginManifest;
