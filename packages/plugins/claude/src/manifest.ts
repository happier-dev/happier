import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
  HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON_ENV,
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON_ENV,
} from '@happier-dev/plugin-sdk/connected-accounts';
import { CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1 } from '@happier-dev/plugin-sdk/first-party/connected-accounts';
import type { HookHandler } from '@happier-dev/plugin-sdk/hooks';
import type {
  McpDiscoveredEndpoint as PluginMcpDiscoveredEndpoint,
} from '@happier-dev/plugin-sdk/mcp';
import { CLAUDE_SUBSCRIPTION_OAUTH_PROFILE } from './connectedAccounts/claudeSubscriptionProfile.js';

import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPES } from './agent/auth/services/native/scopes.js';
import {
  createClaudeConnectedAccountNativeAuthCodec,
  createClaudeConnectedServiceRuntimeAuthAdapter,
} from './agent/auth/services/runtime/failure.js';
import { AGENT_DEFINITION, AGENT_STATE_SHARING_DESCRIPTOR } from './agent/definition.js';
import {
  claudeCliSessionCommandConfig,
  resolveClaudeCliSessionOptions,
} from './agent/cli/command.js';
import { resolveClaudeSessionRuntimePreferences } from './agent/preferences/session.js';
import { HAPPIER_CLAUDE_CONFIG_DIR_ENV } from './agent/environment.js';
import {
  augmentClaudeDaemonSpawnEnv,
  resolveClaudeDaemonSpawnPrerequisites,
} from './agent/lifecycle/spawnHooks.js';
import { shouldUseClaudeDeferredBootstrap } from './agent/lifecycle/deferredStartup.js';
import { readClaudeMcpConfigServers } from './agent/mcp/configServers.js';
import {
  CLAUDE_PROVIDER_BINDING_ADAPTER_V1,
  CLAUDE_PROVIDER_OWNED_ENV_KEYS,
  CLAUDE_PROVIDER_HELPER_ENV_KEYS,
} from './agent/providerBinding/adapter.js';
import { CLAUDE_PREFLIGHT_CATALOGS } from './agent/preflight/catalogs.js';
import { createClaudeAgentRuntime } from './agent/runtime/nativeRuntime.js';
import { createClaudePromptSubmitVerificationPolicy } from './agent/runtime/terminal/unified/promptSubmitVerification.js';
import { claudeExternalSessionsContribution } from './agent/surfaces/sessions/external/contribution.js';
import { claudeExternalSessionHooksContribution } from './agent/surfaces/sessions/external/hooks.js';
import { claudeExternalSessionObservationContribution } from './agent/surfaces/sessions/external/observation.js';
import { claudeExternalSessionTakeoverContribution } from './agent/surfaces/sessions/external/takeover.js';
import { CLAUDE_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';
import { anthropicConnectedAccountRuntime, ANTHROPIC_API_KEY_INPUT_SCHEMA } from './connectedAccounts/anthropicRuntime.js';
import {
  claudeSubscriptionConnectedAccountRuntime,
} from './connectedAccounts/claudeSubscriptionRuntime.js';
import { CLAUDE_UI_TRANSLATION_BUNDLES } from './ui/translations.js';
import { ANTHROPIC_PROVIDER_CONTRIBUTION } from './provider/contribution.js';

const resolveClaudeDaemonSpawnPrerequisitesHook: HookHandler = (event, context) =>
  resolveClaudeDaemonSpawnPrerequisites(event, context);

const augmentClaudeDaemonSpawnEnvHook: HookHandler = (event) =>
  augmentClaudeDaemonSpawnEnv(event);

function readActionString(input: unknown, key: string): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  const value = (input as Readonly<Record<string, unknown>>)[key];
  return typeof value === 'string' ? value.trim() : '';
}

async function launchClaudeTeam(input: unknown, context: PluginInvocationContext) {
  const current = context.services.sessions.current;
  const teamId = readActionString(input, 'teamId');
  if (!current || !teamId) throw new TypeError('claude_subagent_team_launch_input_invalid');
  return await current.send({
    kind: 'sessionSubagentLaunch',
    launch: {
      kind: 'agent_team_create',
      teamId,
      ...(readActionString(input, 'description') ? { description: readActionString(input, 'description') } : {}),
    },
    idempotencyKey: `team:${teamId}`,
  });
}

async function launchClaudeTeammate(input: unknown, context: PluginInvocationContext) {
  const current = context.services.sessions.current;
  const teamId = readActionString(input, 'teamId');
  const memberLabel = readActionString(input, 'memberLabel');
  const instructions = readActionString(input, 'instructions');
  if (!current || !teamId || !memberLabel || !instructions) {
    throw new TypeError('claude_subagent_member_launch_input_invalid');
  }
  return await current.send({
    kind: 'sessionSubagentLaunch',
    launch: {
      kind: 'agent_team_member_create',
      teamId,
      memberLabel,
      instructions,
      runInBackground: true,
    },
    idempotencyKey: `member:${teamId}:${memberLabel}`,
  });
}

function toClaudeMcpEndpoint(
  server: Awaited<ReturnType<typeof readClaudeMcpConfigServers>>['servers'][number],
): PluginMcpDiscoveredEndpoint | null {
  if ((server.transport === 'http' || server.transport === 'sse') && server.remote) {
    return {
      id: `claude.config.${server.name}`,
      name: server.name,
      kind: server.transport,
      url: server.remote.url,
    };
  }
  return null;
}

const {
  id: ANTHROPIC_PROVIDER_CONTRIBUTION_ID,
  managedRuntime: _anthropicProviderManagedRuntime,
  ...ANTHROPIC_PROVIDER_DECLARATION
} = ANTHROPIC_PROVIDER_CONTRIBUTION;
const {
  id: CLAUDE_AGENT_SETTINGS_CONTRIBUTION_ID,
  ...CLAUDE_AGENT_SETTINGS_DECLARATION
} = CLAUDE_AGENT_SETTINGS_CONTRIBUTION;

export const CLAUDE_PLUGIN = definePlugin({
  id: 'happier.agent.claude',
  version: '0.0.0',
  displayName: 'Claude',
  description: 'Claude Code coding agent.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
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
        reason: 'Run the declared Claude Code executable.',
        scope: { executables: [
          { kind: 'systemTool', id: 'claude-cli' },
        ], envKeys: [
          ...CLAUDE_PROVIDER_OWNED_ENV_KEYS,
          ...CLAUDE_PROVIDER_HELPER_ENV_KEYS,
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
        scope: { access: ['read', 'write', 'control'] },
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
      {
        id: 'anthropic-key-verification',
        capability: 'network',
        reason: 'Verify an Anthropic API key before connecting the account.',
        scope: {
          targets: [
            { kind: 'fixedOrigin', origin: 'https://api.anthropic.com' },
            { kind: 'connectedAccountOrigin', service: 'anthropic' },
          ],
          methods: ['GET'],
        },
      },
    ],
    optional: [],
  },
  providers: {
    [ANTHROPIC_PROVIDER_CONTRIBUTION_ID]: {
      declaration: ANTHROPIC_PROVIDER_DECLARATION,
    },
  },
  connectedAccountDescriptors: {
    'claude-subscription': {
      declaration: {
        title: 'Claude',
        // Claude Pro/Max web billing, not the separate Anthropic API account.
        billingUrl: 'https://claude.ai/settings/billing',
        authentication: {
          defaultModeId: CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1
            .setupToken.authenticationModeId,
          modes: [{
            id: CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1.setupToken.authenticationModeId,
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
            id: CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1.oauth.authenticationModeId,
            kind: 'oauthAuthorizationCode',
            callbackUrl: CLAUDE_SUBSCRIPTION_OAUTH_PROFILE.callbackUrl,
            scopes: [...CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPES],
            pkce: 'required',
            outcomeReconciliation: 'none',
          }],
        },
      },
      runtime: claudeSubscriptionConnectedAccountRuntime,
    },
    anthropic: {
      declaration: {
        title: 'Anthropic API key',
        billingUrl: 'https://platform.claude.com/settings/billing',
        authentication: {
          defaultModeId: 'api-key',
          modes: [{
            id: 'api-key',
            kind: 'manual',
            outcomeReconciliation: 'none',
            fields: [{
              id: 'token',
              title: 'Anthropic API key',
              schema: ANTHROPIC_API_KEY_INPUT_SCHEMA,
              secret: true,
            }],
          }],
        },
      },
      runtime: anthropicConnectedAccountRuntime,
    },
  },
  agents: {
    claude: {
      declaration: {
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
            npmPackageName: '@anthropic-ai/claude-code',
            // https://code.claude.com/docs/en/setup ("Update manually": `claude update`). The native
            // installer links ~/.local/bin/claude into ~/.local/share/claude/versions/ and, on
            // Windows, installs %USERPROFILE%\.local\bin\claude.exe beside ~/.local/share/claude.
            nativeUpdate: {
              args: ['update'],
              installPaths: ['.local/share/claude', '.local/bin/claude.exe'],
            },
          },
          auth: {
            support: 'login_terminal',
            machineLoginKey: 'claude-code',
            nonInteractiveStatusProbe: true,
            environmentVariables: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
            credentialPaths: ['~/.claude/.credentials.json', '~/.claude/.claude.json'],
            loginLaunches: [{ kind: 'primary', args: [], initialInput: '/login\r' }],
          },
        },
        primary: 'sessions',
        catalog: {
          vendorResume: { support: AGENT_DEFINITION.core.resume.vendorResume },
          // Binds Claude's own CLI to the declared `claude-cli` system tool so
          // `exec.systemTools.resolve` reaches the canonical Agent CLI launch
          // resolution. This is the public declaration every Agent uses; the
          // host projects it through the one catalog-entry hook owner.
          agentCliSystemTool: { toolId: 'claude-cli' },
          codingPromptBehavior: {
            blocks: [{
              id: 'provider.claude.ask_user_question_isolation',
              text: [
                'RELIABILITY RULES (IMPORTANT):',
                "- Tool-use sequencing is strict. If you use \"AskUserQuestion\", do NOT include any other tool_use in the same assistant turn. Wait for the user's answer before calling other tools.",
              ].join('\n'),
            }, {
              id: 'provider.claude.disable_todos',
              when: 'disableTodos',
              text: 'Do not create TODO items, TODO lists, or task lists in your output. If you would normally create TODOs, instead proceed with the work directly or ask the user for clarification.',
            }],
          },
        },
        connectedAccounts: [{
          purpose: 'model_upstream',
          service: 'claude-subscription',
          required: false,
          materializationKinds: ['environment', 'files', 'httpHeaders'],
          credentialKinds: ['oauth', 'token'],
        }, {
          purpose: 'model_upstream_api_key',
          service: 'anthropic',
          required: false,
          materializationKinds: ['environment'],
          credentialKinds: ['token'],
        }],
        capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
          surfaces: ['externalSessions'],
          sessions: {
            open: ['create', 'resume'],
            startupInstructions: { versions: [1], revisionChanges: 'resume' },
            executionRunContext: { versions: [1] },
            delivery: ['newTurn', 'steer', 'followUp'],
            cancel: true,
            configuration: true,
            workspaceWrites: 'deny',
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
        }),
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
            ownedEnvKeys: [...CLAUDE_PROVIDER_OWNED_ENV_KEYS],
            optionalOwnedEnvKeys: [...CLAUDE_PROVIDER_HELPER_ENV_KEYS],
          },
          materialization: 'spawnEnv',
          applyPolicy: 'live',
          supportsFreeformModelIds: true,
        },
        surfaces: { externalSession: {
          externalLinkedTakeover: { writerSafety: 'unsupported' },
          sources: [{
            sourceKind: 'claudeConfig',
            contentSearch: true,
            schema: { fields: [
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
      },
      factory: createClaudeAgentRuntime,
      preflightSessionControls: { catalogs: CLAUDE_PREFLIGHT_CATALOGS },
      cliAuth: {
        async detectAuthStatus({ runDeclaredSystemToolCommand }) {
          // Claude Code 2.1.292 observes CLAUDE_CONFIG_DIR and native credential
          // custody through this noninteractive command. Use the host probe budget.
          const result = await runDeclaredSystemToolCommand({
            toolId: 'claude-cli', args: ['auth', 'status', '--json'],
          });
          if (result.exitCode !== 0 && result.exitCode !== 1) {
            return { state: 'unknown', reason: 'probe_failed', source: 'command' };
          }
          try {
            const status: unknown = JSON.parse(result.stdout);
            if (!status || typeof status !== 'object' || Array.isArray(status)) {
              return { state: 'unknown', reason: 'probe_failed', source: 'command' };
            }
            const loggedIn = Reflect.get(status, 'loggedIn');
            if (loggedIn === true && result.ok && result.exitCode === 0) {
              return { state: 'logged_in', source: 'command' };
            }
            if (loggedIn === false) {
              return { state: 'logged_out', reason: 'missing_credentials', source: 'command' };
            }
          } catch {
            // Unavailable or malformed probe evidence is not a sign-out.
          }
          return { state: 'unknown', reason: 'probe_failed', source: 'command' };
        },
      },
      connectedAccountLaunch: {
        switchContinuity: {
          continuityMode: 'restart_same_home',
          supportedTransitions: ['same_connected_group'],
          providerStateSharingRequired: {
            serviceIds: ['claude-subscription', 'anthropic'],
            supportedTransitions: ['native_to_connected', 'connected_to_native', 'connected_to_connected'],
          },
        },
        requestAuthUses: [{
          purpose: 'model_upstream',
          materialization: {
            kind: 'httpHeaders',
            origin: 'https://api.anthropic.com',
            headerNames: ['authorization'],
          },
        }],
        environmentUses: [{
          purpose: 'model_upstream_api_key',
          environmentKey: 'ANTHROPIC_API_KEY',
        }],
        stateSharingDescriptor: AGENT_STATE_SHARING_DESCRIPTOR,
        continuity: {
          generationApplicationScope: 'shared_group_auth_surface',
          nativeAuthCodec: createClaudeConnectedAccountNativeAuthCodec(),
          runtimeAuthAdapter: createClaudeConnectedServiceRuntimeAuthAdapter(),
        },
      },
      cliSessionCommand: {
        ...claudeCliSessionCommandConfig,
        buildSessionOptions: (input) => {
          const command = resolveClaudeCliSessionOptions(input);
          if (!command.ok) return command;
          return {
            ok: true,
            options: {
              ...command.options,
              ...resolveClaudeSessionRuntimePreferences({ settings: input.pluginSettings.account ?? {} }),
            },
          };
        },
      },
      terminalPromptSubmitVerification: createClaudePromptSubmitVerificationPolicy(),
      sessionStartup: {
        shouldUseDeferredBootstrap: shouldUseClaudeDeferredBootstrap,
      },
      providerBinding: CLAUDE_PROVIDER_BINDING_ADAPTER_V1,
      sessionRunnerFactory: {
        module: './agent/runtime/nativeRuntime',
        export: 'createClaudeAgentRuntime',
        runtimeApiVersion: 1,
        externalSessionsExport: 'claudeExternalSessionsContribution',
      },
      externalSessions: claudeExternalSessionsContribution,
      externalSessionTakeover: claudeExternalSessionTakeoverContribution,
      externalSessionHooks: claudeExternalSessionHooksContribution,
      externalSessionObservation: claudeExternalSessionObservationContribution,
    },
  },
  systemTools: {
    'claude-cli': { title: 'Claude Code CLI', executableNames: ['claude'] },
  },
  hooks: {
    'resolve-prerequisites': {
      declaration: {
        on: 'agent.resolvePrerequisites',
        hookApiVersion: 1,
        category: 'decision',
        scope: 'agent',
        filters: { agentId: 'claude' },
        executionKind: 'decide',
      },
      handler: resolveClaudeDaemonSpawnPrerequisitesHook,
    },
    'augment-spawn-env': {
      declaration: {
        on: 'agent.spawnEnv.augment',
        hookApiVersion: 1,
        category: 'augmentation',
        scope: 'daemon',
        filters: { agentId: 'claude' },
        executionKind: 'augment',
      },
      handler: augmentClaudeDaemonSpawnEnvHook,
    },
  },
  mcp: {
    servers: {},
    discoverySources: {
      config: {
        declaration: {
          title: 'Claude MCP configuration',
          metadata: { agentId: 'claude' },
        },
        discover: async (input) => {
          const detected = await readClaudeMcpConfigServers({
            directory: input?.directory ?? null,
          });
          return {
            items: [],
            endpoints: detected.servers
              .map(toClaudeMcpEndpoint)
              .filter((endpoint): endpoint is PluginMcpDiscoveredEndpoint => endpoint !== null),
            warnings: detected.warnings,
          };
        },
      },
    },
  },
  actions: {
    'subagent-team-launch': {
      title: 'Create agent team',
      description: 'Creates one Claude agent team in the current Session.',
      scopes: ['session'],
      surfaces: ['ui', 'agent'],
      placementBindings: ['primary'],
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          teamId: { type: 'string', minLength: 1, maxLength: 80 },
          description: { type: 'string', minLength: 1, maxLength: 2000 },
        },
        required: ['teamId'],
      },
      run: launchClaudeTeam,
    },
    'subagent-member-launch': {
      title: 'Launch teammate',
      description: 'Launches one Claude teammate in the current Session.',
      scopes: ['session'],
      surfaces: ['ui', 'agent'],
      placementBindings: ['primary'],
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          teamId: { type: 'string', minLength: 1, maxLength: 80 },
          memberLabel: { type: 'string', minLength: 1, maxLength: 80 },
          instructions: { type: 'string', minLength: 1, maxLength: 20000 },
        },
        required: ['teamId', 'memberLabel', 'instructions'],
      },
      run: launchClaudeTeammate,
    },
  },
  ui: {
    translations: CLAUDE_UI_TRANSLATION_BUNDLES,
    surfaces: [{
      id: 'subagent-launch',
      placement: 'sessionSubagentLaunch',
      target: { kind: 'session' },
      renderer: {
        kind: 'declarative',
        root: {
          kind: 'actionPanel',
          children: [{
            kind: 'action',
            action: 'subagent-team-launch',
            label: 'Create team',
            variant: 'primary',
          }, {
            kind: 'action',
            action: 'subagent-member-launch',
            label: 'Launch teammate',
          }],
        },
      },
    }, {
      id: 'subagent-details',
      placement: 'sessionSubagentDetails',
      target: { kind: 'session' },
      renderer: {
        kind: 'declarative',
        root: {
          kind: 'stack',
          children: [{
            kind: 'text',
            text: 'Launch a Claude teammate in an agent team.',
          }, {
            kind: 'actionPanel',
            children: [{
              kind: 'action',
              action: 'subagent-member-launch',
              label: 'Launch teammate',
              variant: 'primary',
            }],
          }],
        },
      },
    }],
  },
  settings: {
    [CLAUDE_AGENT_SETTINGS_CONTRIBUTION_ID]: CLAUDE_AGENT_SETTINGS_DECLARATION,
  },
});

export const PLUGIN_MANIFEST = CLAUDE_PLUGIN.manifest;
