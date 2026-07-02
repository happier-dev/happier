import {
  definePluginManifest,
  type PluginBackendContributionV2,
  type PluginManifestV2,
} from '@happier-dev/plugin-sdk';

import { COPILOT_ACP_BACKEND_SPEC } from './agent/acp/definition.js';

type CopilotPluginManifestV2 = Omit<PluginManifestV2, 'contributes'> & Readonly<{
  contributes: Readonly<{
    backends: ReadonlyArray<PluginBackendContributionV2>;
  }>;
}>;

export const PLUGIN_MANIFEST = definePluginManifest({
  schemaVersion: 2,
  id: 'happier.agent.copilot',
  version: '0.0.0',
  displayName: 'copilot',
  description: undefined,
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1, capabilities: ['backends'] },
  targets: {},
  capabilities: { permissions: [] },
  contributes: {
    backends: [
      {
        kindVersion: 1,
        id: 'copilot',
        agentId: 'copilot',
        engine: {
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
  },
} satisfies CopilotPluginManifestV2);
