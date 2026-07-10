import {
  definePluginManifest,
  type PluginAgentContributionV2,
  type PluginManifestV2,
  type PluginAgentSettingsContributionV1,
} from '@happier-dev/plugin-sdk';

import { AUGGIE_ACP_BACKEND_SPEC } from './agent/acp/definition.js';
import { AUGGIE_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';

type AuggiePluginManifestV2 = Omit<PluginManifestV2, 'contributes'> & Readonly<{
  contributes: Readonly<{
    agents: ReadonlyArray<PluginAgentContributionV2>;
    agentSettings: ReadonlyArray<PluginAgentSettingsContributionV1>;
  }>;
}>;

export const PLUGIN_MANIFEST = definePluginManifest({
  schemaVersion: 2,
  id: 'happier.agent.auggie',
  version: '0.0.0',
  displayName: 'auggie',
  description: undefined,
  engines: { happier: '^0.0.0' },
  activationEvents: ['onAgent:auggie'],
  uses: ['agents'],
  entrypoints: { main: './dist/index.js' },
  permissions: { required: [], optional: [] },
  contributes: {
    agents: [
      {
        kindVersion: 1,
        id: 'auggie',
        runtime: {
          kind: 'acp',
          transport: AUGGIE_ACP_BACKEND_SPEC.transport,
          ux: AUGGIE_ACP_BACKEND_SPEC.ux,
          capabilities: AUGGIE_ACP_BACKEND_SPEC.capabilities,
          sessionIdHeaderName: AUGGIE_ACP_BACKEND_SPEC.sessionIdHeaderName,
          toolNameInference: AUGGIE_ACP_BACKEND_SPEC.toolNameInference,
          stderrRules: AUGGIE_ACP_BACKEND_SPEC.stderrRules,
          mcp: AUGGIE_ACP_BACKEND_SPEC.mcp,
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
    agentSettings: [AUGGIE_AGENT_SETTINGS_CONTRIBUTION],
  },
} satisfies AuggiePluginManifestV2);
