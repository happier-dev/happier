import {
  definePluginManifest,
  type PluginBackendContributionV2,
  type PluginManifestV2,
} from '@happier-dev/plugin-sdk';

import { KILO_ACP_BACKEND_SPEC } from './agent/acp/definition.js';

type KiloPluginManifestV2 = Omit<PluginManifestV2, 'contributes'> & Readonly<{
  contributes: Readonly<{
    backends: ReadonlyArray<PluginBackendContributionV2>;
  }>;
}>;

export const PLUGIN_MANIFEST = definePluginManifest({
  schemaVersion: 2,
  id: 'happier.agent.kilo',
  version: '0.0.0',
  displayName: 'kilo',
  description: undefined,
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1, capabilities: ['backends'] },
  targets: {},
  capabilities: { permissions: [] },
  contributes: {
    backends: [
      {
        kindVersion: 1,
        id: 'kilo',
        agentId: 'kilo',
        engine: {
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
  },
} satisfies KiloPluginManifestV2);
