import {
  definePluginManifest,
  type PluginAgentContributionV2,
  type PluginManifestV2,
} from '@happier-dev/plugin-sdk';

import { QWEN_ACP_BACKEND_SPEC } from './agent/acp/definition.js';

type QwenPluginManifestV2 = Omit<PluginManifestV2, 'contributes'> & Readonly<{
  contributes: Readonly<{
    agents: ReadonlyArray<PluginAgentContributionV2>;
  }>;
}>;

export const PLUGIN_MANIFEST = definePluginManifest({
  schemaVersion: 2,
  id: 'happier.agent.qwen',
  version: '0.0.0',
  displayName: 'qwen',
  description: undefined,
  engines: { happier: '^0.0.0' },
  activationEvents: ['onAgent:qwen'],
  uses: ['agents'],
  entrypoints: { main: './dist/index.js' },
  permissions: { required: [], optional: [] },
  contributes: {
    agents: [
      {
        kindVersion: 1,
        id: 'qwen',
        runtime: {
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
