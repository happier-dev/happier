import {
  definePluginManifest,
  type PluginAgentContributionV2,
  type PluginManifestV2,
  type PluginAgentSettingsContributionV1,
} from '@happier-dev/plugin-sdk';

import { KIMI_ACP_BACKEND_SPEC } from './agent/acp/definition.js';
import { KIMI_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';

type KimiPluginManifestV2 = Omit<PluginManifestV2, 'contributes'> & Readonly<{
  contributes: Readonly<{
    agents: ReadonlyArray<PluginAgentContributionV2>;
    hooks: NonNullable<NonNullable<PluginManifestV2['contributes']>['hooks']>;
    agentSettings: ReadonlyArray<PluginAgentSettingsContributionV1>;
  }>;
}>;

export const PLUGIN_MANIFEST = definePluginManifest({
  schemaVersion: 2,
  id: 'happier.agent.kimi',
  version: '0.0.0',
  displayName: 'kimi',
  description: undefined,
  engines: { happier: '^0.0.0' },
  activationEvents: ['onAgent:kimi'],
  uses: ['agents', 'hooks'],
  entrypoints: { main: './dist/index.js' },
  permissions: { required: [], optional: [] },
  contributes: {
    agents: [
      {
        kindVersion: 1,
        id: 'kimi',
        runtime: {
          kind: 'acp',
          transport: KIMI_ACP_BACKEND_SPEC.transport,
          ux: KIMI_ACP_BACKEND_SPEC.ux,
          capabilities: KIMI_ACP_BACKEND_SPEC.capabilities,
          sessionIdHeaderName: KIMI_ACP_BACKEND_SPEC.sessionIdHeaderName,
          toolNameInference: KIMI_ACP_BACKEND_SPEC.toolNameInference,
          stderrRules: KIMI_ACP_BACKEND_SPEC.stderrRules,
          mcp: KIMI_ACP_BACKEND_SPEC.mcp,
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
    hooks: [
      {
        id: 'agent.resolvePrerequisites',
        hookApiVersion: 1,
        category: 'decision',
        scope: 'agent',
        filters: { agentId: 'kimi' },
        executionKind: 'decide',
        handler: {
          target: 'plugin',
          exportName: 'resolveKimiDaemonSpawnPrerequisites',
        },
      },
    ],
    agentSettings: [KIMI_AGENT_SETTINGS_CONTRIBUTION],
  },
} satisfies KimiPluginManifestV2);
