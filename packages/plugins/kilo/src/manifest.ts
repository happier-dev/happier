import {
  definePluginManifest,
  type PluginAgentContributionV2,
  type PluginManifestV2,
  type PluginAgentSettingsContributionV1,
} from '@happier-dev/plugin-sdk';

import { KILO_ACP_BACKEND_SPEC } from './agent/acp/definition.js';
import { KILO_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';

type KiloPluginManifestV2 = Omit<PluginManifestV2, 'contributes'> & Readonly<{
  contributes: Readonly<{
    agents: ReadonlyArray<PluginAgentContributionV2>;
    agentSettings: ReadonlyArray<PluginAgentSettingsContributionV1>;
  }>;
}>;

export const PLUGIN_MANIFEST = definePluginManifest({
  schemaVersion: 2,
  id: 'happier.agent.kilo',
  version: '0.0.0',
  displayName: 'kilo',
  description: undefined,
  engines: { happier: '^0.0.0' },
  activationEvents: ['onAgent:kilo'],
  uses: ['agents'],
  entrypoints: { main: './dist/index.js' },
  permissions: { required: [], optional: [] },
  contributes: {
    agents: [
      {
        kindVersion: 1,
        id: 'kilo',
        runtime: {
          kind: 'acp',
          transport: KILO_ACP_BACKEND_SPEC.transport,
          ux: KILO_ACP_BACKEND_SPEC.ux,
          capabilities: KILO_ACP_BACKEND_SPEC.capabilities,
          sessionIdHeaderName: KILO_ACP_BACKEND_SPEC.sessionIdHeaderName,
          toolNameInference: KILO_ACP_BACKEND_SPEC.toolNameInference,
          stderrRules: KILO_ACP_BACKEND_SPEC.stderrRules,
          permissionOptionSelection: KILO_ACP_BACKEND_SPEC.permissionOptionSelection,
          mcp: KILO_ACP_BACKEND_SPEC.mcp,
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
    agentSettings: [KILO_AGENT_SETTINGS_CONTRIBUTION],
  },
} satisfies KiloPluginManifestV2);
