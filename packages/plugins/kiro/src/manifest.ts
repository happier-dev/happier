import {
  definePluginManifest,
  type PluginAgentContributionV2,
  type PluginManifestV2,
  type PluginAgentSettingsContributionV1,
} from '@happier-dev/plugin-sdk';

import { KIRO_ACP_BACKEND_SPEC } from './agent/acp/definition.js';
import { KIRO_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';

type KiroPluginManifestV2 = Omit<PluginManifestV2, 'contributes'> & Readonly<{
  contributes: Readonly<{
    agents: ReadonlyArray<PluginAgentContributionV2>;
    agentSettings: ReadonlyArray<PluginAgentSettingsContributionV1>;
  }>;
}>;

export const PLUGIN_MANIFEST = definePluginManifest({
  schemaVersion: 2,
  id: 'happier.agent.kiro',
  version: '0.0.0',
  displayName: 'kiro',
  description: undefined,
  engines: { happier: '^0.0.0' },
  activationEvents: ['onAgent:kiro'],
  uses: ['agents'],
  entrypoints: { main: './dist/index.js' },
  permissions: { required: [], optional: [] },
  contributes: {
    agents: [
      {
        kindVersion: 1,
        id: 'kiro',
        runtime: {
          kind: 'acp',
          transport: KIRO_ACP_BACKEND_SPEC.transport,
          ux: KIRO_ACP_BACKEND_SPEC.ux,
          capabilities: KIRO_ACP_BACKEND_SPEC.capabilities,
          auth: KIRO_ACP_BACKEND_SPEC.auth,
          sessionIdHeaderName: KIRO_ACP_BACKEND_SPEC.sessionIdHeaderName,
          stderrRules: KIRO_ACP_BACKEND_SPEC.stderrRules,
          mcp: KIRO_ACP_BACKEND_SPEC.mcp,
        },
        capabilities: {
          executionRun: { supported: true },
          session: {
            media: {
              acceptsImageInput: { supported: true },
              emitsSessionMedia: { supported: false },
              nativeImageGeneration: { supported: false },
            },
          },
        },
      },
    ],
    agentSettings: [KIRO_AGENT_SETTINGS_CONTRIBUTION],
  },
} satisfies KiroPluginManifestV2);
