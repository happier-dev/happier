import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';

import { QWEN_ACP_RUNTIME_DEFINITION } from './agent/acp/definition.js';
import { AGENT_DEFINITION } from './agent/definition.js';
import { QWEN_ACP_COMMAND } from './agent/acp/preflight.js';

export const { manifest: PLUGIN_MANIFEST, activate } = definePlugin({
  id: 'happier.agent.qwen',
  version: '0.0.0',
  displayName: 'Qwen Code',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [{
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
          vendorResume: { support: AGENT_DEFINITION.core.resume.vendorResume },
        },
        // Resume-only: supported Qwen ACP releases answer `session/list`, so
        // the host's generic ACP source owns discovery and resume in Happier.
        // This does not claim linked transcript observation or takeover.
        surfaces: {
          externalSession: {
            sources: [{
              sourceKind: 'qwenAcpSessionList',
              resumeOnly: true,
              schema: { fields: [{ kind: 'literal', name: 'kind', value: 'qwenAcpSessionList' }] },
              key: { segments: [{ kind: 'literal', value: 'qwenAcpSessionList' }] },
              instances: [{ kind: 'default', constants: {} }],
            }],
          },
        },
        capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
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
    },
  },
  systemTools: {
    'qwen-cli': {
      title: 'Qwen Code CLI',
      executableNames: ['qwen'],
    },
  },
});
