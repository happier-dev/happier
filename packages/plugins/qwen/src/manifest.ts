import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';

import { QWEN_ACP_RUNTIME_DEFINITION } from './agent/acp/definition.js';
import { AGENT_DEFINITION } from './agent/definition.js';
import { QWEN_ACP_COMMAND } from './agent/acp/preflight.js';
import { qwenExternalSessionsContribution } from './agent/externalSessions/contribution.js';
import { createQwenAgentRuntime } from './agent/factory.js';
import { QWEN_ACCOUNT_SOURCES, QWEN_ACCOUNT_ENV_KEYS, prepareQwenConnectedAccount } from './agent/connectedAccount.js';
import { QWEN_PROVIDER_BINDING_ADAPTER, QWEN_PROVIDER_OWNED_ENV_KEYS } from './agent/providerBinding.js';

export const { manifest: PLUGIN_MANIFEST, activate } = definePlugin({
  id: 'happier.agent.qwen',
  version: '0.0.0',
  displayName: 'Qwen Code',
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [{
      id: 'qwen-native-history',
      capability: 'filesystem',
      reason: 'Read native Qwen conversation history.',
      scope: { locations: [{ root: 'workspace' }], access: ['read'] },
    }, {
      id: 'qwen-process',
      capability: 'process',
      reason: 'Run the declared Qwen CLI executable.',
      scope: { executables: [{ kind: 'systemTool', id: QWEN_ACP_COMMAND.toolId }], envKeys: [...new Set([...QWEN_ACCOUNT_ENV_KEYS, ...QWEN_PROVIDER_OWNED_ENV_KEYS])] },
    }],
    optional: [],
  },
  agents: {
    qwen: {
      declaration: {
        title: 'Qwen Code',
        connectedAccounts: QWEN_ACCOUNT_SOURCES.map(({ purpose, service, protocol }) => ({ purpose, service,
          materializationKinds: protocol === 'gemini' ? ['environment', 'files'] as ['environment', 'files'] : ['environment'] as ['environment'],
          credentialKinds: ['token'] as ['token'] })),
        runtime: {
          kind: 'custom',
          permissionModeMapping: QWEN_ACP_RUNTIME_DEFINITION.permissionModeMapping,
        },
        providerRequirements: {
          acceptsProtocols: ['openai-chat', 'openai-responses'],
          required: { streaming: true, toolRoundTrips: true },
          credentialSupport: { supportsNoAuth: false, apiKeyTransports: [
            { protocol: 'openai-chat', destination: { kind: 'httpHeader', names: ['authorization'], formats: ['bearer'] } },
            { protocol: 'openai-responses', destination: { kind: 'httpHeader', names: ['authorization'], formats: ['bearer'] } },
          ] },
          authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: [...QWEN_PROVIDER_OWNED_ENV_KEYS] },
          materialization: 'configFile', applyPolicy: 'restart_session', supportsFreeformModelIds: true,
        },
        cli: {
          displayName: 'Qwen CLI',
          executable: {
            binaryName: 'qwen',
            knownUserBinDirSuffixes: null,
            sourcePreference: 'system-first',
          },
          install: {
            managed: {
              kind: 'managed_package',
              packageName: '@qwen-code/qwen-code',
              binaryName: 'qwen',
            },
            manual: { kind: 'command' },
            guideUrl: 'https://qwenlm.github.io/qwen-code-docs/',
            docsUrl: null,
          },
          auth: {
            support: 'login_terminal',
            loginLaunches: [{ kind: 'primary', args: [], initialInput: '/auth\r' }],
          },
        },
        sessionModeDescriptor: AGENT_DEFINITION.sessionModeDescriptor,
        primary: 'sessions',
        catalog: {
          agentCliSystemTool: { toolId: QWEN_ACP_COMMAND.toolId },
          acpRegistryIds: [...AGENT_DEFINITION.acpRegistryIds],
          vendorResume: { support: AGENT_DEFINITION.core.resume.vendorResume },
        },
        surfaces: {
          externalSession: {
            sources: [{
              sourceKind: 'qwenRuntimeDir',
              contentSearch: true,
              schema: { fields: [{ kind: 'literal', name: 'kind', value: 'qwenRuntimeDir' },
                { kind: 'string', name: 'runtimeDir', min: 1, max: 10_000, nullish: true }] },
              key: { segments: [{ kind: 'literal', value: 'qwenRuntimeDir' }, { kind: 'field', field: 'runtimeDir' }] },
              instances: [{ kind: 'default', constants: {} }],
            }],
          },
        },
        capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
          skills: { delivery: 'session_dir', nativeDisable: 'supported', liveReload: 'unsupported',
            nativeRoots: { user: [['.qwen', 'skills'], ['.agents', 'skills']], project: [['.qwen', 'skills'], ['.agents', 'skills']] } },
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
      factory: createQwenAgentRuntime,
      providerBinding: QWEN_PROVIDER_BINDING_ADAPTER,
      sessionRunnerFactory: { module: './agent/factory', export: 'createQwenAgentRuntime', runtimeApiVersion: 1,
        externalSessionsExport: 'qwenExternalSessionsContribution' },
      preflightSessionControls: {
        async prepareLaunchEnvironment({ environment, connectedAccounts, signal, modelId }) {
          const prepared = await prepareQwenConnectedAccount({ modelId }, { services: { connectedAccounts }, signal });
          return { environment: { ...environment, ...prepared?.env },
            ...(prepared ? { commandArgsSuffix: prepared.args, catalogConfidence: prepared.models.catalogConfidence } : {}),
            dispose() { prepared?.dispose(); } };
        },
        catalogs: { kind: 'acp', command: QWEN_ACP_COMMAND },
      },
      connectedAccountLaunch: {
        continuity: {
          verifyResumeReachable: async ({ vendorResumeId, nativeInspection }) => {
            if (!vendorResumeId) return { ok: false, reason: 'vendor_resume_id_missing' };
            if (!nativeInspection) return { ok: false, reason: 'qwen_resume_inspection_unavailable' };
            try {
              await nativeInspection.withDeclaredJsonRpcClient(QWEN_ACP_COMMAND, async (client) => {
                await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
                await client.request('session/load', { sessionId: vendorResumeId, cwd: nativeInspection.cwd, mcpServers: [] });
              });
              return { ok: true, proof: 'native_session' as const };
            } catch {
              return { ok: false, reason: 'qwen_resume_unreachable' };
            }
          },
        },
        switchContinuity: { continuityMode: 'restart_same_home',
        supportedTransitions: ['native_to_connected', 'connected_to_native', 'connected_to_connected'] } },
      externalSessions: qwenExternalSessionsContribution,
    },
  },
  systemTools: {
    'qwen-cli': {
      title: 'Qwen Code CLI',
      executableNames: ['qwen'],
    },
  },
});
