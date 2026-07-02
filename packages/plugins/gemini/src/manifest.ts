import {
  definePluginManifest,
  type PluginBackendContributionV2,
  type PluginManifestV2,
} from '@happier-dev/plugin-sdk';

import { GEMINI_ACP_BACKEND_SPEC } from './agent/acp/definition.js';

type GeminiPluginManifestV2 = Omit<PluginManifestV2, 'contributes'> & Readonly<{
  contributes: Readonly<{
    backends: ReadonlyArray<PluginBackendContributionV2>;
  }>;
}>;

// Thin composition file that declares this plugin’s canonical manifest.
// Keep unsupported media defaults explicit until a source-real media event is mapped.
export const PLUGIN_MANIFEST = definePluginManifest({
  schemaVersion: 2,
  id: 'happier.agent.gemini',
  version: '0.0.0',
  displayName: 'gemini',
  description: undefined,
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1, capabilities: ['backends'] },
  targets: {},
  capabilities: { permissions: [] },
  contributes: {
    backends: [
      {
        kindVersion: 1,
        id: 'gemini',
        agentId: 'gemini',
        engine: {
          kind: 'acp',
          transport: GEMINI_ACP_BACKEND_SPEC.transport,
          ux: GEMINI_ACP_BACKEND_SPEC.ux,
          capabilities: GEMINI_ACP_BACKEND_SPEC.capabilities,
          auth: GEMINI_ACP_BACKEND_SPEC.auth,
          transportLifecycle: GEMINI_ACP_BACKEND_SPEC.transportLifecycle,
          permissionModeArgv: GEMINI_ACP_BACKEND_SPEC.permissionModeArgv,
          sessionIdHeaderName: GEMINI_ACP_BACKEND_SPEC.sessionIdHeaderName,
          toolNameInference: GEMINI_ACP_BACKEND_SPEC.toolNameInference,
          stderrRules: GEMINI_ACP_BACKEND_SPEC.stderrRules,
          mcp: GEMINI_ACP_BACKEND_SPEC.mcp,
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
} satisfies GeminiPluginManifestV2);
