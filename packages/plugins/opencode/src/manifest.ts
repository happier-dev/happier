import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';
import type {
  McpDiscoveredEndpoint as PluginMcpDiscoveredEndpoint,
} from '@happier-dev/plugin-sdk/mcp';

import { AGENT_DEFINITION } from './agent/definition.js';
import { detectOpenCodeCliAuthStatus } from './agent/cli/auth.js';
import { OPENCODE_PREFLIGHT_SESSION_CONTROLS } from './agent/preflight/models.js';
import { readOpenCodeMcpConfigServers } from './agent/mcp/discovery.js';
import {
  OPEN_CODE_ANTHROPIC_API_KEY_PURPOSE_ID,
  OPEN_CODE_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID,
  OPEN_CODE_OPENAI_API_KEY_PURPOSE_ID,
  OPEN_CODE_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID,
} from './agent/auth/services/purposes.js';
import {
  OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV,
} from './agent/auth/services/requestAuth/env.js';
import { OPEN_CODE_AUTH_SERVICE_SHARING_DESCRIPTOR } from './agent/auth/services/stateSharing.js';
import {
  OPENCODE_PROVIDER_BINDING_ADAPTER_V1,
  OPENCODE_PROVIDER_OWNED_ENV_KEYS,
} from './agent/providerBinding/adapter.js';
import { resolveOpenCodeSessionRuntimePreferences } from './agent/preferences/session.js';
import { createOpenCodeAgentRuntime } from './agent/runtime/nativeRuntime.js';
import {
  buildOpenCodeAttachHealthUrl,
  createOpenCodeAttachArgs,
  resolveOpenCodeAttachTarget,
} from './agent/surfaces/sessions/attach/descriptor.js';
import { openCodeExternalSessionsContribution } from './agent/surfaces/sessions/external/contribution.js';
import { openCodeExternalSessionObservationContribution } from './agent/surfaces/sessions/external/observation.js';
import { openCodeExternalSessionTakeoverContribution } from './agent/surfaces/sessions/external/provider.js';
import { OPEN_CODE_SYSTEM_TOOL_ID } from './agent/systemTool.js';
import { OPENCODE_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';

function normalizeOpenCodeMcpServerIdSegment(name: string): string | null {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '');
  return normalized.length > 0 ? normalized : null;
}

function toOpenCodeMcpEndpoint(server: Awaited<ReturnType<typeof readOpenCodeMcpConfigServers>>['servers'][number]): PluginMcpDiscoveredEndpoint | null {
  if (server.enabled === false) return null;
  const idSegment = normalizeOpenCodeMcpServerIdSegment(server.name);
  if (!idSegment) return null;
  const id = `opencode.config.${idSegment}`;
  if ((server.transport === 'http' || server.transport === 'sse') && server.remote?.url) {
    return {
      id,
      name: server.name,
      kind: server.transport,
      url: server.remote.url,
    };
  }
  return null;
}

const {
  id: OPENCODE_AGENT_SETTINGS_CONTRIBUTION_ID,
  ...OPENCODE_AGENT_SETTINGS_DECLARATION
} = OPENCODE_AGENT_SETTINGS_CONTRIBUTION;

export const OPENCODE_PLUGIN = definePlugin({
  id: 'happier.agent.opencode',
  version: '0.0.0',
  displayName: 'OpenCode',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './.happier-plugin/daemon.js' },
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
  agents: {
    opencode: {
      declaration: {
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
            nonInteractiveStatusProbe: true,
            loginLaunches: [{ kind: 'primary', args: ['auth', 'login'] }],
          },
        },
        primary: 'sessions',
        catalog: {
          vendorResume: { support: AGENT_DEFINITION.core.resume.vendorResume },
          agentCliSystemTool: { toolId: OPEN_CODE_SYSTEM_TOOL_ID },
        },
        connectedAccounts: [{
          purpose: OPEN_CODE_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID,
          service: {
            pluginId: 'happier.agent.claude',
            localId: 'claude-subscription',
          },
          materializationKinds: ['environment', 'httpHeaders'],
        }, {
          purpose: OPEN_CODE_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID,
          service: {
            pluginId: 'happier.agent.codex',
            localId: 'openai-codex',
          },
          materializationKinds: ['httpHeaders'],
        }, {
          purpose: OPEN_CODE_OPENAI_API_KEY_PURPOSE_ID,
          service: {
            pluginId: 'happier.voice.openai',
            localId: 'openai',
          },
          materializationKinds: ['environment'],
        }, {
          purpose: OPEN_CODE_ANTHROPIC_API_KEY_PURPOSE_ID,
          service: {
            pluginId: 'happier.agent.claude',
            localId: 'anthropic',
          },
          materializationKinds: ['environment'],
        }],
        capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
          surfaces: ['externalSessions'],
          sessions: {
            open: ['create', 'resume'],
            delivery: ['newTurn', 'steer', 'followUp'],
            cancel: true,
            configuration: true,
            compaction: { events: true, manual: true },
            catalog: { active: ['skills'] },
          },
          executionRuns: { open: ['create'], checkpoint: true, stop: true },
        }),
        providerRequirements: {
          acceptsProtocols: ['openai-responses', 'openai-chat'],
          required: { streaming: true, toolRoundTrips: true },
          credentialSupport: {
            supportsNoAuth: true,
            // The Responses driver (`@ai-sdk/openai`) always renders an
            // Authorization header from its configured key, so OpenCode can only
            // honour a credential-free Provider over Chat Completions
            // (`@ai-sdk/openai-compatible`, which omits the header entirely).
            noAuthProtocols: ['openai-chat'],
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
            schema: { fields: [
              { name: 'kind', kind: 'literal', value: 'opencodeServer' },
              { name: 'baseUrl', kind: 'unknown', optional: true },
              { name: 'directory', kind: 'unknown', optional: true },
              { name: 'managedEndpoint', kind: 'unknown', optional: true },
            ] },
            key: { segments: [
              { kind: 'literal', value: 'opencodeServer' },
              { kind: 'field', field: 'baseUrl' },
              { kind: 'field', field: 'directory' },
            ] },
            instances: [
              { kind: 'default', constants: { managedEndpoint: true } },
              {
                // OVERRIDE, not an addition: every configured source becomes a
                // supervised attach target, so an admitted operator-configured
                // server must REPLACE the managed default rather than run
                // beside it. The shared materializer keeps the default whenever
                // the setting is absent, blank, or rejected.
                kind: 'agentSettingOverride',
                settingId: 'opencodeServerBaseUrl',
                byServerIdSettingId: 'opencodeServerBaseUrlByServerIdV1',
                field: 'baseUrl',
                normalization: 'httpOrigin',
              },
            ],
          }],
        } },
      },
      factory: createOpenCodeAgentRuntime,
      connectedAccountLaunch: {
        switchContinuity: {
          continuityMode: 'restart_same_home',
          supportedTransitions: ['native_to_connected', 'connected_to_native', 'connected_to_connected'],
        },
        requestAuthUses: [{
          purpose: OPEN_CODE_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID,
          materialization: {
            kind: 'httpHeaders',
            origin: 'https://api.anthropic.com',
            headerNames: ['authorization'],
          },
        }, {
          purpose: OPEN_CODE_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID,
          materialization: {
            kind: 'httpHeaders',
            origin: 'https://chatgpt.com',
            headerNames: ['authorization', 'chatgpt-account-id'],
          },
        }],
        stateSharingDescriptor: OPEN_CODE_AUTH_SERVICE_SHARING_DESCRIPTOR,
      },
      preflightSessionControls: OPENCODE_PREFLIGHT_SESSION_CONTROLS,
      cliAuth: {
        detectAuthStatus: async ({ runDeclaredSystemToolCommand }) =>
          await detectOpenCodeCliAuthStatus({
            runAuthList: async () => await runDeclaredSystemToolCommand({
              toolId: OPEN_CODE_SYSTEM_TOOL_ID,
              args: ['auth', 'list'],
              timeoutMs: 6_000,
            }),
          }),
      },
      cliSessionCommand: {
        sessionRuntimeId: 'opencode',
        accountSettingsAgentId: 'opencode',
        infoCommandPrefixes: [['providers', 'list']],
        buildSessionOptions: (input) => ({
          ok: true,
          options: resolveOpenCodeSessionRuntimePreferences({
            settings: input.settings,
            environment: input.environment,
          }),
        }),
      },
      providerBinding: OPENCODE_PROVIDER_BINDING_ADAPTER_V1,
      providerCliAttach: {
        resolveTarget: resolveOpenCodeAttachTarget,
        createArgs: createOpenCodeAttachArgs,
        buildHealthUrl: buildOpenCodeAttachHealthUrl,
      },
      sessionRunnerFactory: {
        module: './agent/runtime/nativeRuntime',
        export: 'createOpenCodeAgentRuntime',
        runtimeApiVersion: 1,
        externalSessionsExport: 'openCodeExternalSessionsContribution',
      },
      externalSessions: openCodeExternalSessionsContribution,
      externalSessionTakeover: openCodeExternalSessionTakeoverContribution,
      externalSessionObservation: openCodeExternalSessionObservationContribution,
    },
  },
  mcp: {
    servers: {},
    discoverySources: {
      config: {
        declaration: { title: 'OpenCode MCP configuration', metadata: { agentId: 'opencode' } },
        discover: async (input) => {
          const detected = await readOpenCodeMcpConfigServers({
            directory: input?.directory ?? null,
          });
          const endpoints = detected.servers
            .map(toOpenCodeMcpEndpoint)
            .filter((endpoint): endpoint is PluginMcpDiscoveredEndpoint => endpoint !== null);
          const countsById = new Map<string, number>();
          for (const endpoint of endpoints) {
            countsById.set(endpoint.id, (countsById.get(endpoint.id) ?? 0) + 1);
          }
          return {
            items: [],
            endpoints: endpoints.filter((endpoint) => countsById.get(endpoint.id) === 1),
            warnings: detected.warnings,
          };
        },
      },
    },
  },
  systemTools: {
    [OPEN_CODE_SYSTEM_TOOL_ID]: {
      title: 'OpenCode CLI',
      executableNames: ['opencode'],
    },
  },
  settings: {
    [OPENCODE_AGENT_SETTINGS_CONTRIBUTION_ID]: OPENCODE_AGENT_SETTINGS_DECLARATION,
  },
});

export const PLUGIN_MANIFEST = OPENCODE_PLUGIN.manifest;
