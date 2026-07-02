import {
  definePluginManifest,
  type PluginBackendContributionV2,
  type PluginManifestV2,
} from '@happier-dev/plugin-sdk';

import { KIMI_ACP_BACKEND_SPEC } from './agent/acp/definition.js';

type KimiPluginManifestV2 = Omit<PluginManifestV2, 'contributes'> & Readonly<{
  contributes: Readonly<{
    backends: ReadonlyArray<PluginBackendContributionV2>;
  }>;
}>;

export const PLUGIN_MANIFEST = definePluginManifest({
  schemaVersion: 2,
  id: 'happier.agent.kimi',
  version: '0.0.0',
  displayName: 'kimi',
  description: undefined,
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1, capabilities: ['backends'] },
  targets: {},
  capabilities: { permissions: [] },
  contributes: {
    backends: [
      {
        kindVersion: 1,
        id: 'kimi',
        agentId: 'kimi',
        engine: {
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
  },
} satisfies KimiPluginManifestV2);
