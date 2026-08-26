import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';

import { AGENT_DEFINITION } from './agent/definition.js';
import { createQwenAgentRuntime } from './agent/runtime/factory.js';

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
      scope: { executables: [{ kind: 'systemTool', id: 'qwen-cli' }] },
    }],
    optional: [],
  },
  agents: {
    qwen: {
      declaration: {
        title: 'Qwen Code',
        runtime: { kind: 'custom' },
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
        capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
          sessions: {
            open: ['create', 'resume'],
            delivery: ['newTurn', 'steer', 'followUp'],
            cancel: true,
          },
        }),
      },
      factory: createQwenAgentRuntime,
      sessionRunnerFactory: {
        module: './agent/runtime/factory',
        export: 'createQwenAgentRuntime',
        runtimeApiVersion: 1,
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
