import {
  definePluginManifest,
  type PluginAgentContributionV2,
  type PluginManifestV2,
  type PluginAgentSettingsContributionV1,
} from '@happier-dev/plugin-sdk';

import { COPILOT_ACP_BACKEND_SPEC } from './agent/acp/definition.js';
import { COPILOT_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';

type CopilotPluginManifestV2 = Omit<PluginManifestV2, 'contributes'> & Readonly<{
  contributes: Readonly<{
    agents: ReadonlyArray<PluginAgentContributionV2>;
    agentSettings: ReadonlyArray<PluginAgentSettingsContributionV1>;
  }>;
}>;

export const PLUGIN_MANIFEST = definePluginManifest({
  schemaVersion: 2,
  id: 'happier.agent.copilot',
  version: '0.0.0',
  displayName: 'copilot',
  description: undefined,
  engines: { happier: '^0.0.0' },
  activationEvents: ['onAgent:copilot'],
  uses: ['agents'],
  entrypoints: { main: './dist/index.js' },
  permissions: { required: [], optional: [] },
  contributes: {
    agents: [
      {
        kindVersion: 1,
        id: 'copilot',
        runtime: {
          kind: 'acp',
          transport: COPILOT_ACP_BACKEND_SPEC.transport,
          ux: COPILOT_ACP_BACKEND_SPEC.ux,
          capabilities: COPILOT_ACP_BACKEND_SPEC.capabilities,
          sessionIdHeaderName: COPILOT_ACP_BACKEND_SPEC.sessionIdHeaderName,
          toolNameInference: COPILOT_ACP_BACKEND_SPEC.toolNameInference,
          stderrRules: COPILOT_ACP_BACKEND_SPEC.stderrRules,
          mcp: COPILOT_ACP_BACKEND_SPEC.mcp,
        },
        capabilities: {
          executionRun: { supported: true },
          session: {
            media: {
              acceptsImageInput: { supported: false },
              emitsSessionMedia: { supported: false },
              nativeImageGeneration: { supported: false },
            },
          },
        },
      },
    ],
    agentSettings: [COPILOT_AGENT_SETTINGS_CONTRIBUTION],
  },
} satisfies CopilotPluginManifestV2);
