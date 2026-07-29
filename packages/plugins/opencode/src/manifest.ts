import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';

import { OPENCODE_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';
import {
  OPEN_CODE_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID,
  OPEN_CODE_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID,
} from './agent/auth/services/requestAuth/purposes.js';
import {
  OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV,
} from './agent/auth/services/requestAuth/env.js';
import { OPENCODE_PROVIDER_OWNED_ENV_KEYS } from './agent/providerBinding/adapter.js';
import { OPEN_CODE_SYSTEM_TOOL_ID } from './agent/systemTool.js';

export const PLUGIN_MANIFEST = {
  schemaVersion: 2, id: 'happier.agent.opencode', version: '0.0.0', displayName: 'OpenCode',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './dist/index.js' },
  hostAccess: {
    required: [{
      id: 'opencode-workspace',
      capability: 'filesystem',
      reason: 'Use the admitted Agent workspace as the OpenCode process working directory.',
      scope: {
        locations: [{ root: 'workspace' }],
        access: ['read'],
      },
    }, {
      id: 'opencode-process',
      capability: 'process',
      reason: 'Run the declared OpenCode CLI executable.',
      scope: {
        executables: [{ kind: 'systemTool', id: OPEN_CODE_SYSTEM_TOOL_ID }],
        envKeys: [
          ...OPENCODE_PROVIDER_OWNED_ENV_KEYS,
          'XDG_CONFIG_HOME',
          OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV,
          'OPENCODE_PERMISSION',
          'OPENCODE_SERVER_PASSWORD',
        ],
      },
    }],
    optional: [],
  },
  contributes: {
    agents: [{
      id: 'opencode',
      title: 'OpenCode',
      runtime: { kind: 'custom' },
      cli: {
        displayName: 'OpenCode CLI',
        executable: {
          binaryName: 'opencode',
          knownUserBinDirSuffixes: ['.opencode/bin', 'AppData/Roaming/npm'],
          sourcePreference: 'system-first',
        },
        install: {
          managed: {
            kind: 'managed_package',
            packageName: 'opencode-ai',
            binaryName: 'opencode',
            packageBinarySetup: { kind: 'opencode_platform_binary' },
          },
          manual: { kind: 'command' },
          recommendationOrder: 40,
          guideUrl: 'https://opencode.ai/docs',
          docsUrl: 'https://opencode.ai',
        },
        auth: {
          support: 'login_terminal',
          probe: {
            parser: 'opencodeAuthList',
            backgroundChecks: 'safe',
            statusArgs: ['auth', 'list'],
          },
          loginLaunches: [{ kind: 'primary', args: ['auth', 'login'] }],
        },
      },
      primary: 'sessions',
      connectedAccounts: [{
        purpose: OPEN_CODE_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID,
        service: {
          pluginId: 'happier.agent.claude',
          localId: 'claude-subscription',
        },
      }, {
        purpose: OPEN_CODE_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID,
        service: {
          pluginId: 'happier.agent.codex',
          localId: 'openai-codex',
        },
      }],
      capabilities: {
        surfaces: ['externalSessions'],
        sessions: {
          open: ['create', 'resume', 'fork'],
          delivery: ['newTurn', 'steer', 'followUp'],
          cancel: true,
          configuration: true,
          compaction: { events: true, manual: true },
          catalog: { active: ['skills'] },
          usageLimitRecovery: {
            active: ['checkNow'],
            inactive: ['checkNow'],
          },
        },
        executionRuns: { open: ['create'], checkpoint: true, stop: true },
      },
      providerRequirements: {
        acceptsProtocols: ['openai-responses', 'openai-chat'],
        required: { streaming: true, toolRoundTrips: true },
        credentialSupport: {
          supportsNoAuth: true,
          apiKeyTransports: [
            {
              protocol: 'openai-responses',
              destination: { kind: 'httpHeader', names: 'anyValidated', formats: ['raw', 'bearer'] },
            },
            {
              protocol: 'openai-chat',
              destination: { kind: 'httpHeader', names: 'anyValidated', formats: ['raw', 'bearer'] },
            },
          ],
        },
        authIsolation: {
          suppressConnectedServiceIds: ['openai-codex', 'openai', 'claude-subscription', 'anthropic'],
          ownedEnvKeys: [...OPENCODE_PROVIDER_OWNED_ENV_KEYS],
        },
        materialization: 'configFile',
        applyPolicy: 'restart_session',
        supportsFreeformModelIds: true,
      },
      surfaces: { externalSession: {
        externalLinkedTakeover: { writerSafety: 'unsupported' },
        sources: [{
        sourceKind: 'opencodeServer',
        schema: { passthrough: true, fields: [
          { name: 'kind', kind: 'literal', value: 'opencodeServer' },
          { name: 'baseUrl', kind: 'unknown', optional: true },
          { name: 'directory', kind: 'unknown', optional: true },
        ] },
        key: { segments: [
          { kind: 'literal', value: 'opencodeServer' },
          { kind: 'field', field: 'baseUrl' },
          { kind: 'field', field: 'directory' },
        ] },
        instances: [{ kind: 'default', constants: {} }],
      }],
      } },
    }],
    mcp: { servers: [], discoveryProviders: [{ id: 'config', title: 'OpenCode MCP configuration', metadata: { agentId: 'opencode' } }] },
    systemTools: [{
      id: OPEN_CODE_SYSTEM_TOOL_ID,
      title: 'OpenCode CLI',
      executableNames: ['opencode'],
    }],
    settings: [OPENCODE_AGENT_SETTINGS_CONTRIBUTION],
  },
} satisfies PluginManifest;
