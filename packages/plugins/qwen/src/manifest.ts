import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';

import { QWEN_ACP_RUNTIME_DEFINITION } from './agent/acp/definition.js';
import { AGENT_DEFINITION } from './agent/definition.js';
import { QWEN_ACP_COMMAND } from './agent/acp/preflight.js';
import { qwenExternalSessionsContribution } from './agent/externalSessions/contribution.js';

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
      scope: { executables: [{ kind: 'systemTool', id: QWEN_ACP_COMMAND.toolId }] },
    }],
    optional: [],
  },
  agents: {
    qwen: {
      declaration: {
        title: 'Qwen Code',
        runtime: {
          kind: 'acp',
          transport: {
            kind: 'stdio',
            executable: { kind: 'systemTool', id: 'qwen-cli' },
            args: [...QWEN_ACP_COMMAND.args],
          },
          definition: QWEN_ACP_RUNTIME_DEFINITION,
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
        primary: 'sessions',
        catalog: {
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
