import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { OPENAI_CODEX_CONNECTED_ACCOUNT_SERVICE } from '@happier-dev/plugins-codex/connected-account-service';

import { AGENT_DEFINITION } from './agent/definition.js';
import { KILO_ACP_COMMAND } from './agent/acp/command.js';
import { KILO_PERMISSION_ENV } from './agent/permissions/kiloPermissionPolicy.js';
import { createKiloAgentRuntime } from './agent/runtime/factory.js';
import { KILO_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';
import { kiloExternalSessionsContribution } from './agent/externalSessions/contribution.js';
import { KILO_PROVIDER_BINDING_ADAPTER_V1, KILO_PROVIDER_OWNED_ENV_KEYS } from './agent/providerBinding/adapter.js';
import { KILO_CODEX_PURPOSE, prepareKiloConnectedAccount } from './agent/runtime/connectedAccounts.js';
import { KILO_KEY_ACCOUNTS, KILO_KEY_DECLARATIONS, KILO_KEY_ENVIRONMENT_USES } from './agent/runtime/connectedAccountKeys.js';
import { CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV } from '@happier-dev/plugin-sdk/connected-accounts';

const {
  id: KILO_AGENT_SETTINGS_CONTRIBUTION_ID,
  ...KILO_AGENT_SETTINGS_DECLARATION
} = KILO_AGENT_SETTINGS_CONTRIBUTION;

export const KILO_PLUGIN = definePlugin({
  id: 'happier.agent.kilo',
  version: '0.0.0',
  displayName: 'Kilo',
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [{
      id: 'kilo-workspace',
      capability: 'filesystem',
      reason: 'Use the admitted Agent workspace as the Kilo process working directory.',
      scope: { locations: [{ root: 'workspace' }], access: ['read'] },
    }, {
      id: 'kilo-process',
      capability: 'process',
      reason: 'Run the declared Kilo CLI executable.',
      scope: {
        executables: [{ kind: 'systemTool', id: 'kilo-cli' }],
        envKeys: [...new Set([KILO_PERMISSION_ENV, ...KILO_PROVIDER_OWNED_ENV_KEYS, ...KILO_KEY_ENVIRONMENT_USES.map(use => use.environmentKey), CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV])],
      },
    }],
    optional: [],
  },
  agents: {
    kilo: {
      declaration: {
        title: 'Kilo',
        runtime: { kind: 'custom' },
        cli: {
          displayName: 'Kilo CLI',
          executable: {
            binaryName: 'kilo',
            knownUserBinDirSuffixes: null,
            sourcePreference: 'system-first',
          },
          install: {
            managed: {
              kind: 'managed_package',
              packageName: '@kilocode/cli',
              binaryName: 'kilo',
            },
            manual: { kind: 'command' },
            guideUrl: null,
            docsUrl: 'https://kilo.ai/docs/cli',
          },
          auth: {
            support: 'login_terminal',
            loginLaunches: [{ kind: 'primary', args: [], initialInput: '/connect\r' }],
          },
        },
        sessionModeDescriptor: AGENT_DEFINITION.sessionModeDescriptor,
        primary: 'sessions',
        connectedAccounts: [{
          purpose: KILO_CODEX_PURPOSE,
          service: OPENAI_CODEX_CONNECTED_ACCOUNT_SERVICE,
          materializationKinds: ['httpHeaders'], credentialKinds: ['oauth'],
        }, ...KILO_KEY_DECLARATIONS],
        providerRequirements: {
          acceptsProtocols: ['openai-chat', 'openai-responses', 'anthropic'],
          required: { streaming: true, toolRoundTrips: true },
          credentialSupport: {
            supportsNoAuth: true,
            noAuthProtocols: ['openai-chat'],
            apiKeyTransports: [
              { protocol: 'openai-chat', destination: { kind: 'httpHeader', names: ['Authorization'], formats: ['bearer'] } },
              { protocol: 'openai-responses', destination: { kind: 'httpHeader', names: ['Authorization'], formats: ['bearer'] } },
              { protocol: 'anthropic', destination: { kind: 'httpHeader', names: ['x-api-key'], formats: ['raw'] } },
            ],
          },
          authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: [...KILO_PROVIDER_OWNED_ENV_KEYS] },
          materialization: 'spawnEnv', applyPolicy: 'restart_session', supportsFreeformModelIds: true,
        },
        catalog: {
          agentCliSystemTool: { toolId: 'kilo-cli' },
          acpRegistryIds: [...AGENT_DEFINITION.acpRegistryIds],
          vendorResume: { support: AGENT_DEFINITION.core.resume.vendorResume },
        },
        capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
          surfaces: ['externalSessions'],
          skills: {
            delivery: 'none', nativeDisable: 'unsupported', liveReload: 'unsupported',
            nativeRoots: {
              user: [['.agents', 'skills'], ['.claude', 'skills'], ['.kilo', 'skills']],
              project: [['.agents', 'skills'], ['.claude', 'skills'], ['.kilo', 'skills'], ['.kilocode', 'skills']],
            },
          },
          sessions: {
            open: ['create', 'resume'],
            delivery: ['newTurn', 'followUp'],
            cancel: true,
            executionRunContext: { versions: [1] },
          },
        }),
        surfaces: {
          externalSession: {
            externalLinkedTakeover: { writerSafety: 'unsupported' },
            sources: [{ sourceKind: 'kiloStorage', contentSearch: true,
              schema: { fields: [
                { kind: 'literal', name: 'kind', value: 'kiloStorage' },
                { kind: 'string', name: 'storageRoot', min: 1, nullish: true },
              ] },
              key: { segments: [{ kind: 'literal', value: 'kiloStorage' }, { kind: 'field', field: 'storageRoot' }] },
              instances: [{ kind: 'default', constants: {} }],
            }],
          },
        },
      },
      factory: createKiloAgentRuntime,
      connectedAccountLaunch: {
        environmentUses: KILO_KEY_ENVIRONMENT_USES,
        requestAuthUses: [{ purpose: KILO_CODEX_PURPOSE, materialization: {
          kind: 'httpHeaders', origin: 'https://chatgpt.com', headerNames: ['authorization', 'chatgpt-account-id'],
        } }],
        continuity: {
          // Kilo's current SQLite store has no host-declared resume-file lookup.
          // Native ACP resume still works; pre-switch reachability is unproven.
          verifyResumeReachable: async () => ({ ok: false, reason: 'kilo_resume_reachability_unsupported' }),
        },
      },
      providerBinding: KILO_PROVIDER_BINDING_ADAPTER_V1,
      preflightSessionControls: {
        prepareLaunchEnvironment: async ({ environment, modelId, connectedAccounts, signal }) => {
          const bindings = await Promise.all([...KILO_KEY_ACCOUNTS.map(row => row.purpose), KILO_CODEX_PURPOSE]
              .map(purpose => connectedAccounts.getBinding(purpose, { signal })));
          const prepared = await prepareKiloConnectedAccount({ modelId, launchEnvironment: { values: environment, unset: [] },
            connectedAccounts: bindings.flatMap(binding => binding ? [{ purpose: binding.purpose, account: binding.account }] : []) });
          return { environment: prepared.launchEnvironment?.values ?? { ...environment, ...prepared.env },
            unset: prepared.launchEnvironment?.unset, catalogConfidence: prepared.models?.catalogConfidence, dispose() {} };
        },
        catalogs: { kind: 'acp', command: KILO_ACP_COMMAND },
        models: {
          command: {
            toolId: 'kilo-cli',
            args: ['models'],
          },
        },
      },
      sessionRunnerFactory: {
        module: './agent/runtime/factory',
        export: 'createKiloAgentRuntime',
        runtimeApiVersion: 1,
        externalSessionsExport: 'kiloExternalSessionsContribution',
      },
      externalSessions: kiloExternalSessionsContribution,
    },
  },
  systemTools: {
    'kilo-cli': { title: 'Kilo CLI', executableNames: ['kilo'] },
  },
  settings: {
    [KILO_AGENT_SETTINGS_CONTRIBUTION_ID]: KILO_AGENT_SETTINGS_DECLARATION,
  },
});

export const PLUGIN_MANIFEST = KILO_PLUGIN.manifest;
