import {
  definePluginManifest,
  type PluginBackendContributionV2,
  type PluginManifestV2,
} from '@happier-dev/plugin-sdk';

import { AUGGIE_ACP_BACKEND_SPEC } from './agent/acp/definition.js';

type AuggiePluginManifestV2 = Omit<PluginManifestV2, 'contributes'> & Readonly<{
  contributes: Readonly<{
    backends: ReadonlyArray<PluginBackendContributionV2>;
  }>;
}>;

export const PLUGIN_MANIFEST = definePluginManifest({
  schemaVersion: 2,
  id: 'happier.agent.auggie',
  version: '0.0.0',
  displayName: 'auggie',
  description: undefined,
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1, capabilities: ['backends'] },
  targets: {},
  capabilities: { permissions: [] },
  contributes: {
    backends: [
      {
        kindVersion: 1,
        id: 'auggie',
        agentId: 'auggie',
        engine: {
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
  },
} satisfies AuggiePluginManifestV2);
