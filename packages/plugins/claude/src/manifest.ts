import { CLAUDE_SESSION_RETENTION_SETTING_ID } from '@happier-dev/protocol/agents/claude/session-retention';
import { applyClaudeAccountSettings } from './agent/settings/applyAccountSettings.js';
import { CLAUDE_ACCOUNT_USAGE_PROVIDER_ID } from './agent/auth/services/usage/identity.js';
import { CLAUDE_ACCOUNT_USAGE_PLAN_METADATA } from './connectedAccounts/planLabels.js';
import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { AgentPreflightSessionControlsContributionV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import {
  HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON_ENV,
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON_ENV,
} from '@happier-dev/plugin-sdk/connected-accounts';
import { CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1 } from '@happier-dev/protocol/agents/claude/connected-account-materialization';
import type { HookHandler } from '@happier-dev/plugin-sdk/hooks';
import { CLAUDE_SUBSCRIPTION_OAUTH_PROFILE } from './connectedAccounts/claudeSubscriptionProfile.js';
import { claudeSubscriptionAccountAuthentication } from './connectedAccounts/account.js';

import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPES } from './agent/auth/services/native/scopes.js';
import {
  createClaudeConnectedAccountNativeAuthCodec,
  createClaudeConnectedServiceRuntimeAuthAdapter,
} from './agent/auth/services/runtime/failure.js';
import { verifyResumeReachableClaude } from './agent/auth/services/runtime/verifyResumeReachable.js';
import { AGENT_DEFINITION, AGENT_STATE_SHARING_DESCRIPTOR } from './agent/definition.js';
import {
  claudeCliSessionCommandConfig,
  resolveClaudeCliSessionOptions,
} from './agent/cli/command.js';
import { resolveClaudeSessionRuntimePreferences } from './agent/preferences/session.js';
import { resolveClaudeNativeLaunchSettings } from './agent/runtime/launchSettings.js';
import { readClaudeTerminalRuntimeSelection } from './agent/runtime/terminal/unified/selection.js';
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
import { CLAUDE_PROVIDER_MODEL_ROLES } from './agent/providerBinding/modelRoles.js';
import { resolveClaudeNativePluginSkillRoots } from './agent/preflight/pluginSkillRoots.js';
import { createClaudeAgentRuntime } from './agent/runtime/factory.js';
import { createClaudePromptSubmitVerificationPolicy } from './agent/runtime/terminal/unified/promptSubmitVerification.js';
import { claudeExternalSessionsContribution } from './agent/surfaces/sessions/external/contribution.js';
import { claudeExternalSessionHooksContribution } from './agent/surfaces/sessions/external/hooks.js';
import { claudeExternalSessionObservationContribution } from './agent/surfaces/sessions/external/observation.js';
import { claudeExternalSessionTakeoverContribution } from './agent/surfaces/sessions/external/takeover.js';
import { readClaudeSettingSourcesV2 } from '@happier-dev/protocol/agents/claude/predecessor-message-meta';
import { CLAUDE_REMOTE_AGENT_SETTINGS_DEFAULTS, CLAUDE_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';
import { anthropicConnectedAccountRuntime, ANTHROPIC_API_KEY_INPUT_SCHEMA } from './connectedAccounts/anthropicRuntime.js';
import {
  claudeSubscriptionConnectedAccountRuntime,
  CLAUDE_NATIVE_IMPORT_MODE_ID,
} from './connectedAccounts/claudeSubscriptionNativeRuntime.js';

import { ANTHROPIC_PROVIDER_CONTRIBUTION } from './provider/contribution.js';
import { parseClaudeModelCatalog } from './provider/catalog.js';
import { CLAUDE_CONNECTED_ACCOUNT_SERVICE, ANTHROPIC_CONNECTED_ACCOUNT_SERVICE, ANTHROPIC_API_KEY_ENV } from './connectedAccounts/service.js';
import { CLAUDE_KIMI_DECLARATION, CLAUDE_KIMI_ENVIRONMENT_USES, prepareClaudeConnectedAccountKeyPreflight } from './agent/runtime/connectedAccountKeys.js';

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
  id: CLAUDE_CONNECTED_ACCOUNT_SERVICE.pluginId,
  version: '0.0.0',
  displayName: 'Claude',
  description: 'Claude Code coding agent.',
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
          ...CLAUDE_KIMI_ENVIRONMENT_USES.map(use => use.environmentKey),
          'CLAUDE_CONFIG_DIR',
          'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
          'CLAUDE_CODE_ENTRYPOINT',
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
        id: 'claude-subscription-reset',
        capability: 'network',
        reason: 'Use a selected provider reset for the exact Claude Subscription Connected Account.',
        scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://api.anthropic.com' }], methods: ['POST'] },
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
      catalogParsers: { 'claude-models': parseClaudeModelCatalog },
    },
  },
  connectedAccountDescriptors: {
    [CLAUDE_CONNECTED_ACCOUNT_SERVICE.localId]: {
      declaration: {
        title: 'Claude',
        ui: { iconResourceId: 'agent-mark', setup: { order: 0, firstRun: true, catalogDescription: { key: 'connectedServicesSettings.catalogClaude', fallback: 'Pro or Max plan. Sign in with a browser, or paste a setup token.' } } },
        // Claude Pro/Max web billing, not the separate Anthropic API account.
        billingUrl: 'https://claude.ai/settings/billing',
        recoveryCredits: { supported: true },
        usageIdentity: { providerId: CLAUDE_ACCOUNT_USAGE_PROVIDER_ID, requiredContext: 'organization' },
        metadata: CLAUDE_ACCOUNT_USAGE_PLAN_METADATA,
        authentication: {
          account: { artifactId: 'connected-account-authentication', exportName: 'activate' },
          defaultModeId: CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1
            .setupToken.authenticationModeId,
          modes: [{
            id: CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1.setupToken.authenticationModeId,
            kind: 'manual',
            title: 'Setup token',
            setup: {
              url: 'https://code.claude.com/docs/en/cli-reference',
              checklist: ['Run claude setup-token in a terminal and complete the Claude subscription sign-in.', 'Paste the generated token here.'],
              createKeyTitle: 'Read Claude setup-token instructions',
            },
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
            browserReachability: 'unreachable',
            title: 'Sign in with Claude',
            callbackUrl: CLAUDE_SUBSCRIPTION_OAUTH_PROFILE.callbackUrl,
            scopes: [...CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPES],
            pkce: 'required',
            outcomeReconciliation: 'none',
          }, {
            id: CLAUDE_NATIVE_IMPORT_MODE_ID,
            kind: 'manual',
            setup: {
              url: 'https://code.claude.com/docs/en/cli-reference',
              checklist: ['On the computer you will import from, run claude auth login and sign in with your Claude subscription.', 'Choose that computer in Happier to import its saved Claude Code login.'],
              createKeyTitle: 'Read Claude Code login instructions',
            },
            credentialOrigin: 'native_import',
            title: 'Import native login',
            outcomeReconciliation: 'none',
            fields: [{
              id: 'source', title: 'Native login source',
              description: 'Importing shares this native login with Happier. The native app may ask you to sign in again when Happier renews it.',
              schema: { type: 'string', enum: ['native'] }, secret: false, default: 'native',
              presentation: { control: 'select', options: [{ value: 'native', title: 'Claude Code login' }] },
            }],
          }],
        },
      },
      runtime: claudeSubscriptionConnectedAccountRuntime,
      accountRuntime: claudeSubscriptionAccountAuthentication,
    },
    [ANTHROPIC_CONNECTED_ACCOUNT_SERVICE.localId]: {
      declaration: {
        title: 'Anthropic API key',
        ui: { iconResourceId: 'anthropic-mark', setup: { order: 3, firstRun: false, catalogDescription: { key: 'connectedServicesSettings.catalogAnthropic', fallback: 'Pay per use, billed to your Anthropic organization.' } } },
        billingUrl: 'https://platform.claude.com/settings/billing',
        authentication: {
          defaultModeId: 'api-key',
          modes: [{
            id: 'api-key',
            kind: 'manual',
            apiKey: true,
            setup: {
              url: 'https://platform.claude.com/settings/keys',
              checklist: [{ key: 'connectedServicesSettings.keyCreateAnthropic', fallback: 'Create an API key in the Anthropic Console, then paste it here.' }],
              createKeyTitle: { key: 'connectedServicesSettings.keyCreateAnthropic', fallback: 'Create an API key in the Anthropic Console, then paste it here.' },
              billingNote: { key: 'connectedServicesSettings.keyBillingAnthropic', fallback: 'API usage is billed separately from a Claude subscription.' },
              shapeHint: { key: 'connectedServicesSettings.keyShapeAnthropic', fallback: 'This looks like an Anthropic API key.' },
            },
            credentialOrigin: 'authentication',
            outcomeReconciliation: 'none',
            accountDirectSave: true,
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
      accountSettings: { settingLocalIds: [CLAUDE_SESSION_RETENTION_SETTING_ID], apply: applyClaudeAccountSettings },
      declaration: {
        title: 'Claude',
        sessionModeDescriptor: AGENT_DEFINITION.sessionModeDescriptor,
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
                  cmd: 'powershell.exe',
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
        requestCoverage: AGENT_DEFINITION.requestCoverage,
        catalog: {
          acpRegistryIds: [...AGENT_DEFINITION.acpRegistryIds],
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
          service: CLAUDE_CONNECTED_ACCOUNT_SERVICE.localId,
          required: false,
          materializationKinds: ['environment', 'files', 'httpHeaders'],
          credentialKinds: ['oauth', 'token'],
        }, {
          purpose: 'model_upstream_api_key',
          service: ANTHROPIC_CONNECTED_ACCOUNT_SERVICE.localId,
          required: false,
          materializationKinds: ['environment'],
          credentialKinds: ['token'],
        }, CLAUDE_KIMI_DECLARATION],
        capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
          skills: { delivery: 'session_dir', nativeDisable: 'supported', liveReload: 'supported', usageEvidence: 'reported',
            nativeRoots: { user: [['.claude', 'skills']], project: [['.claude', 'skills']] } },
          surfaces: ['externalSessions'],
          sessions: {
            open: ['create', 'resume'],
            startupInstructions: { versions: [1], revisionChanges: 'resume' },
            executionRunContext: { versions: [1] },
            delivery: ['newTurn', 'steer', 'followUp'],
            cancel: true,
            configuration: true,
            workspaceWrites: 'deny',
            catalog: { active: ['skills'] },
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
            supportsAdditionalCredentials: true,
            requiredApiKeyTransports: [
              { protocol: 'anthropic', destination: { kind: 'httpHeader', names: ['authorization'], formats: ['bearer'] } },
              { protocol: 'anthropic', destination: { kind: 'httpHeader', names: ['x-api-key'], formats: ['raw'] } },
            ],
            apiKeyTransports: [
              {
                protocol: 'anthropic',
                destination: { kind: 'httpHeader', names: 'anyValidated', formats: ['raw', 'bearer'] },
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
          modelRoles: CLAUDE_PROVIDER_MODEL_ROLES,
          supportsFreeformModelIds: true,
          supportsReasoningEffort: true,
        },
        surfaces: { externalSession: {
          externalLinkedTakeover: { writerSafety: 'unsupported' },
          sources: [{
            sourceKind: 'claudeConfig',
            contentSearch: true,
            terminalFollow: { userRowClassification: 'explicitV1' },
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
      preflightSessionControls: {
        prepareLaunchEnvironment: prepareClaudeConnectedAccountKeyPreflight,
        resolveNativeCatalogSettingSources: ({ pluginSettings }) => readClaudeSettingSourcesV2(
          CLAUDE_REMOTE_AGENT_SETTINGS_DEFAULTS, pluginSettings.account ?? {},
        ),
        catalogs: CLAUDE_PREFLIGHT_CATALOGS,
        resolveNativePluginSkillRoots: resolveClaudeNativePluginSkillRoots,
        async resolveNativeSkillDirectories({ pluginSettings, runtimeDescriptorV1 }: Parameters<NonNullable<AgentPreflightSessionControlsContributionV1['resolveNativeSkillDirectories']>>[0]) {
          const values = pluginSettings.account ?? {};
          const launch = await resolveClaudeNativeLaunchSettings({
            settings: { get: key => values[key], snapshot: async () => ({ values }) },
            launchEnv: {},
            includeAdvancedOptions: readClaudeTerminalRuntimeSelection(runtimeDescriptorV1)?.mode !== 'unifiedTerminal',
          });
          return launch.settingSources.includes('project') ? launch.advancedOptions.additionalDirectories ?? [] : [];
        },
      },
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
        environmentUses: [...CLAUDE_KIMI_ENVIRONMENT_USES, {
          purpose: 'model_upstream_api_key',
          environmentKey: ANTHROPIC_API_KEY_ENV,
        }],
        stateSharingDescriptor: AGENT_STATE_SHARING_DESCRIPTOR,
        continuity: {
          generationApplicationScope: 'shared_group_auth_surface',
          nativeAuthCodec: createClaudeConnectedAccountNativeAuthCodec(),
          runtimeAuthAdapter: createClaudeConnectedServiceRuntimeAuthAdapter(),
          verifyResumeReachable: verifyResumeReachableClaude,
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
        module: './agent/runtime/factory',
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
        filters: { agentId: 'claude' },
      },
      handler: resolveClaudeDaemonSpawnPrerequisitesHook,
    },
    'augment-spawn-env': {
      declaration: {
        on: 'agent.spawnEnv.augment',
        filters: { agentId: 'claude' },
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
          loadedInHappierSessions: true,
          metadata: { agentId: 'claude' },
        },
        discover: async (input) => {
          const detected = await readClaudeMcpConfigServers({
            directory: input?.directory ?? null,
          });
          return {
            items: [],
            detectedServers: detected.servers,
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
      surfaces: ['ui', 'agent', 'cli', 'mcp'],
      hostAccess: ['claude-session-runtime-control'],
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
      inputHints: {
        fields: [{
          path: 'teamId', title: { key: 'session.subagents.launch.teamName', fallback: 'Team name' },
          widget: 'text', required: true,
        }, {
          path: 'description', title: { key: 'session.subagents.launch.description', fallback: 'Description' },
          widget: 'textarea',
        }],
      },
      run: launchClaudeTeam,
    },
    'subagent-member-launch': {
      title: 'Launch teammate',
      description: 'Launches one Claude teammate in the current Session.',
      scopes: ['session'],
      surfaces: ['ui', 'agent', 'cli', 'mcp'],
      hostAccess: ['claude-session-runtime-control'],
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
      inputHints: {
        fields: [{
          path: 'teamId', title: { key: 'session.subagents.launch.teamName', fallback: 'Team name' },
          widget: 'text', required: true,
        }, {
          path: 'memberLabel', title: { key: 'session.subagents.launch.teammateName', fallback: 'Teammate name' },
          widget: 'text', required: true,
        }, {
          path: 'instructions', title: { key: 'session.subagents.launch.instructions', fallback: 'Instructions' },
          widget: 'textarea', required: true,
        }],
      },
      run: launchClaudeTeammate,
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
    views: [{
      id: 'agent-settings-view',
      container: 'agentSettings',
      target: { kind: 'app' },
      renderer: 'agent-settings-renderer',
    }],
    renderers: [{
      id: 'agent-settings-renderer',
      kind: 'reactNative', artifact: 'claude-agent-settings-native',
      requiredHostMethods: ['executeAction', 'confirm'],
    }],
    surfaces: [{
      id: 'subagent-launch',
      placement: 'sessionSubagentLaunch',
      target: { kind: 'session' },
      renderer: {
        kind: 'declarative',
        root: {
          kind: 'stack',
          children: [{
            kind: 'text',
            text: { key: 'session.subagents.launch.intro', fallback: 'Start a team of Claude agents on one task, or add a teammate to a team.' },
          }, {
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
  resources: {
    'agent-mark': { kind: 'asset', path: 'assets/agent-mark.svg', contentType: 'image/svg+xml' },
    'anthropic-mark': { kind: 'asset', path: 'assets/anthropic-mark.svg', contentType: 'image/svg+xml' },
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
  settings: {
    [CLAUDE_AGENT_SETTINGS_CONTRIBUTION_ID]: CLAUDE_AGENT_SETTINGS_DECLARATION,
  },
});

export const PLUGIN_MANIFEST = CLAUDE_PLUGIN.manifest;
