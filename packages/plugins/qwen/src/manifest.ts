import {
  definePluginManifest,
  type PluginBackendContributionV2,
  type PluginManifestV2,
} from '@happier-dev/plugin-sdk';

import { QWEN_ACP_BACKEND_SPEC } from './agent/acp/definition.js';

type QwenPluginManifestV2 = Omit<PluginManifestV2, 'contributes'> & Readonly<{
  contributes: Readonly<{
    backends: ReadonlyArray<PluginBackendContributionV2>;
  }>;
}>;

export const PLUGIN_MANIFEST = definePluginManifest({
  schemaVersion: 2,
  id: 'happier.agent.qwen',
  version: '0.0.0',
  displayName: 'qwen',
  description: undefined,
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1, capabilities: ['backends'] },
  targets: {},
  capabilities: { permissions: [] },
  contributes: {
    backends: [
      {
        kindVersion: 1,
        id: 'qwen',
        agentId: 'qwen',
        engine: {
          kind: 'acp',
          transport: QWEN_ACP_BACKEND_SPEC.transport,
          ux: QWEN_ACP_BACKEND_SPEC.ux,
          capabilities: QWEN_ACP_BACKEND_SPEC.capabilities,
          permissionModeArgv: QWEN_ACP_BACKEND_SPEC.permissionModeArgv,
          sessionIdHeaderName: QWEN_ACP_BACKEND_SPEC.sessionIdHeaderName,
          mcp: QWEN_ACP_BACKEND_SPEC.mcp,
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
} satisfies QwenPluginManifestV2);
