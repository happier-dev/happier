import { definePlugin } from '@happier-dev/plugin-sdk';
import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';

import { AGENT_DEFINITION } from './agent/definition.js';
import { createCustomAcpAgentRuntime } from './agent/runtime/factory.js';

export const CUSTOM_ACP_PLUGIN = definePlugin({
  id: 'happier.agent.custom-acp',
  version: '0.0.0',
  displayName: 'Custom ACP Agent',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  agents: {
    'custom-acp': {
      declaration: {
        title: 'Custom ACP Agent',
        runtime: { kind: 'custom' },
        primary: 'sessions',
        catalog: { vendorResume: { support: 'supported' } },
        capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
          sessions: {
            open: ['create', 'resume'], delivery: ['newTurn', 'steer', 'followUp'],
            cancel: true, configuration: true, executionRunContext: { versions: [1] },
          },
        }),
      },
      factory: createCustomAcpAgentRuntime,
      sessionRunnerFactory: {
        module: './agent/runtime/factory', export: 'createCustomAcpAgentRuntime', runtimeApiVersion: 1,
      },
    },
  },
});

export const PLUGIN_MANIFEST = CUSTOM_ACP_PLUGIN.manifest;
