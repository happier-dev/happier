import {
  definePluginManifest,
  type PluginBackendContributionV2,
  type PluginManifestV2,
} from '@happier-dev/plugin-sdk';
import type { PluginAgentContributionV2 } from '@happier-dev/protocol';

import { AGENT_DEFINITION } from './agent/definition.js';

const PI_BACKEND_ID = 'pi';
type PiAgentCliRuntime = NonNullable<PluginAgentContributionV2['agentCliRuntime']>;

function toPiAgentCliRuntime(): PiAgentCliRuntime {
  const runtime = AGENT_DEFINITION.agentCliRuntime;
  return {
    ...runtime,
    kindVersion: 1,
  };
}

const PI_AGENT_CLI_RUNTIME = Object.freeze(toPiAgentCliRuntime());
const PI_CONNECTED_SERVICE_IDS = [
  ...(AGENT_DEFINITION.core.connectedServices?.supportedServiceIds ?? []),
];

type PiPluginManifestV2 = Omit<PluginManifestV2, 'contributes'> & Readonly<{
  contributes: Readonly<{
    agents: ReadonlyArray<PluginAgentContributionV2>;
    backends: ReadonlyArray<PluginBackendContributionV2>;
  }>;
}>;

// Thin composition file that declares this plugin's canonical manifest.
// Keep this mostly declarative; executable behavior lives in plugin-owned agent folders.
export const PLUGIN_MANIFEST = definePluginManifest({
  schemaVersion: 2,
  id: 'happier.agent.pi',
  version: '0.0.0',
  displayName: 'pi',
  description: undefined,
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1, capabilities: ['agents', 'backends'] },
  targets: {},
  capabilities: { permissions: [] },
  contributes: {
    agents: [
      {
        kindVersion: 1,
        id: PI_BACKEND_ID,
        catalogAgentId: PI_BACKEND_ID,
        iconAgentId: PI_BACKEND_ID,
        settingsBackendId: PI_BACKEND_ID,
        display: {
          name: 'Pi',
          subtitle: 'Pi Coding Agent',
          tags: [],
        },
        agentCliRuntime: PI_AGENT_CLI_RUNTIME,
        install: {
          docsUrl: AGENT_DEFINITION.agentCliRuntime.installGuideUrl ?? undefined,
        },
        auth: {
          machineLoginSupport: AGENT_DEFINITION.localCli.supportKind,
          connectedServiceCompatibility: PI_CONNECTED_SERVICE_IDS,
        },
        session: {
          storage: AGENT_DEFINITION.core.sessionStorage.direct ? 'direct' : 'host',
          resume: {
            supportLevel: AGENT_DEFINITION.core.resume.vendorResume,
            vendorResumeIdField: AGENT_DEFINITION.core.resume.vendorResumeIdField ?? undefined,
          },
          handoff: {
            supportLevel: AGENT_DEFINITION.core.handoff.vendorStateTransfer,
          },
          sessionCapabilities: AGENT_DEFINITION.core.sessionCapabilities,
        },
        ui: {
          modeSelection: AGENT_DEFINITION.sessionModesKind,
          modelSelection: AGENT_DEFINITION.modelConfig.supportsSelection ? 'supported' : 'unsupported',
        },
        ownedBackendIds: [PI_BACKEND_ID],
      },
    ],
    backends: [
      {
        kindVersion: 1,
        id: PI_BACKEND_ID,
        agentId: PI_BACKEND_ID,
        engine: { kind: 'custom' },
        capabilities: {
          executionRun: { supported: true },
          mcp: { policy: 'unsupported' },
          session: {
            media: {
              emitsSessionMedia: {
                supported: false,
              },
              nativeImageGeneration: { supported: false },
            },
          },
        },
      },
    ],
  },
} satisfies PiPluginManifestV2);
