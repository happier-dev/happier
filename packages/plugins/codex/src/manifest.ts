import {
  BackendSurfaceOperationCatalogV1,
  definePluginManifest,
  type PluginAgentContributionV2,
  type PluginHookContributionV2,
  type PluginManagedDependencyContributionV2,
  type PluginManifestV2,
  type PluginMcpContributesV1,
  type PluginAgentSettingsContributionV1,
  type PluginSystemToolContributionV1,
} from '@happier-dev/plugin-sdk/manifest';

import { CODEX_ACP_INSTALLABLE_DESCRIPTOR } from './agent/installables/codexAcp.js';
import { CODEX_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';

type CodexPluginManifestV2 = Omit<PluginManifestV2, 'contributes'> & Readonly<{
  contributes: Readonly<{
    agents: ReadonlyArray<PluginAgentContributionV2>;
    hooks: ReadonlyArray<PluginHookContributionV2>;
    managedDependencies: ReadonlyArray<PluginManagedDependencyContributionV2>;
    mcp: PluginMcpContributesV1;
    agentSettings: ReadonlyArray<PluginAgentSettingsContributionV1>;
    systemTools: ReadonlyArray<PluginSystemToolContributionV1>;
  }>;
}>;

// Thin composition file that declares this plugin’s canonical manifest.
// Keep this mostly declarative; executable behavior lives in domain folders.
export const PLUGIN_MANIFEST = definePluginManifest({
  schemaVersion: 2,
  id: 'happier.agent.codex',
  version: '0.0.0',
  displayName: 'codex',
  description: undefined,
  engines: { happier: '^0.0.0' },
  activationEvents: ['onAgent:codex'],
  uses: ['agents', 'mcp', 'hooks'],
  entrypoints: { main: './dist/index.js' },
  permissions: { required: [], optional: [] },
  contributes: {
    agents: [
      {
        kindVersion: 1,
        id: 'codex',
        runtime: { kind: 'custom' },
        surfaceHandlers: [
          {
            surfaceApiVersion: 1,
            id: 'codex.handoff.exportBundle',
            kind: 'handoff',
            operation: 'exportBundle',
            handler: { target: 'daemon', exportName: 'exportCodexSessionBundle' },
          },
          {
            surfaceApiVersion: 1,
            id: 'codex.handoff.importBundle',
            kind: 'handoff',
            operation: 'importBundle',
            handler: { target: 'daemon', exportName: 'importCodexSessionBundle' },
          },
          {
            surfaceApiVersion: 1,
            id: 'codex.fork.fork',
            kind: 'fork',
            operation: BackendSurfaceOperationCatalogV1.fork.fork,
            handler: { target: 'daemon', exportName: 'forkCodexSession' },
          },
          {
            surfaceApiVersion: 1,
            id: 'codex.terminalRuntime.launch',
            kind: 'terminalRuntime',
            operation: BackendSurfaceOperationCatalogV1.terminalRuntime.launch,
            handler: { target: 'daemon' },
          },
          {
            surfaceApiVersion: 1,
            id: 'codex.externalSession.resolveSource',
            kind: 'externalSession',
            operation: BackendSurfaceOperationCatalogV1.externalSession.resolveSource,
            handler: { target: 'daemon' },
          },
          {
            surfaceApiVersion: 1,
            id: 'codex.externalSession.listCandidates',
            kind: 'externalSession',
            operation: BackendSurfaceOperationCatalogV1.externalSession.listCandidates,
            handler: { target: 'daemon' },
          },
          {
            surfaceApiVersion: 1,
            id: 'codex.externalSession.getActivity',
            kind: 'externalSession',
            operation: BackendSurfaceOperationCatalogV1.externalSession.getActivity,
            handler: { target: 'daemon' },
          },
          {
            surfaceApiVersion: 1,
            id: 'codex.externalSession.pageTranscript',
            kind: 'externalSession',
            operation: BackendSurfaceOperationCatalogV1.externalSession.pageTranscript,
            handler: { target: 'daemon' },
          },
          {
            surfaceApiVersion: 1,
            id: 'codex.externalSession.readAfterTranscript',
            kind: 'externalSession',
            operation: BackendSurfaceOperationCatalogV1.externalSession.readAfterTranscript,
            handler: { target: 'daemon' },
          },
          {
            surfaceApiVersion: 1,
            id: 'codex.externalSession.resolveFollowTranscriptPath',
            kind: 'externalSession',
            operation: BackendSurfaceOperationCatalogV1.externalSession.resolveFollowTranscriptPath,
            handler: { target: 'daemon' },
          },
          {
            surfaceApiVersion: 1,
            id: 'codex.externalSession.acquireFollowLease',
            kind: 'externalSession',
            operation: BackendSurfaceOperationCatalogV1.externalSession.acquireFollowLease,
            handler: { target: 'daemon' },
          },
          {
            surfaceApiVersion: 1,
            id: 'codex.externalSession.resolveLinkIdentity',
            kind: 'externalSession',
            operation: BackendSurfaceOperationCatalogV1.externalSession.resolveLinkIdentity,
            handler: { target: 'daemon' },
          },
          {
            surfaceApiVersion: 1,
            id: 'codex.externalSession.resolveLinkedIdentity',
            kind: 'externalSession',
            operation: BackendSurfaceOperationCatalogV1.externalSession.resolveLinkedIdentity,
            handler: { target: 'daemon' },
          },
          {
            surfaceApiVersion: 1,
            id: 'codex.externalSession.resolveTakeoverLaunch',
            kind: 'externalSession',
            operation: BackendSurfaceOperationCatalogV1.externalSession.resolveTakeoverLaunch,
            handler: { target: 'daemon' },
          },
        ],
        surfaces: {
          externalSession: {
            sources: [
              {
                sourceKind: 'codexHome',
                schema: {
                  passthrough: true,
                  fields: [
                    { name: 'kind', kind: 'literal', value: 'codexHome' },
                    { name: 'home', kind: 'enum', values: ['user', 'connectedService'] },
                    { name: 'homePath', kind: 'string', min: 1, optional: true },
                    { name: 'connectedServiceId', kind: 'string', min: 1, optional: true },
                    { name: 'connectedServiceProfileId', kind: 'string', min: 1, optional: true },
                    { name: 'connectedServiceGroupId', kind: 'string', min: 1, optional: true },
                  ],
                  refinements: [
                    {
                      kind: 'requiresWhenEquals',
                      field: 'connectedServiceId',
                      when: { field: 'home', equals: 'connectedService' },
                    },
                    {
                      kind: 'forbidsWhenEquals',
                      fields: [
                        'connectedServiceId',
                        'connectedServiceProfileId',
                        'connectedServiceGroupId',
                      ],
                      when: { field: 'home', equals: 'user' },
                    },
                  ],
                },
                key: {
                  segments: [
                    { kind: 'literal', value: 'codexHome' },
                    { kind: 'homeMode', field: 'home' },
                    {
                      kind: 'conditionalField',
                      field: 'connectedServiceId',
                      when: { field: 'home', equals: 'connectedService' },
                    },
                    {
                      kind: 'connectedServiceScope',
                      groupField: 'connectedServiceGroupId',
                      profileField: 'connectedServiceProfileId',
                      when: { field: 'home', equals: 'connectedService' },
                    },
                    { kind: 'field', field: 'homePath' },
                  ],
                },
              },
            ],
          },
        },
        capabilities: {
          executionRun: {
            supported: true,
            structuredOutputRecovery: {
              delegate: 'loose-deliverables-with-single-fallback',
            },
          },
          session: {
            media: {
              emitsSessionMedia: {
                supported: true,
                mediaKinds: ['image'],
                sources: ['provider-generated'],
                storage: 'session-media-file',
              },
              nativeImageGeneration: {
                supported: true,
                mediaKinds: ['image'],
                streamingPartials: false,
              },
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
        filters: { agentId: 'codex' },
        executionKind: 'decide',
        handler: {
          target: 'plugin',
          exportName: 'resolveCodexDaemonSpawnPrerequisites',
        },
      },
      {
        id: 'agent.spawnEnv.augment',
        hookApiVersion: 1,
        category: 'augmentation',
        scope: 'daemon',
        filters: { agentId: 'codex' },
        executionKind: 'augment',
        handler: {
          target: 'plugin',
          exportName: 'augmentCodexDaemonSpawnEnv',
        },
      },
    ],
    managedDependencies: [CODEX_ACP_INSTALLABLE_DESCRIPTOR],
    mcp: {
      servers: [],
      discoveryProviders: [
        {
          id: 'codex.config',
          kind: 'mcp.discoveryProvider',
          version: '1.0.0',
          capabilityGates: [],
          permissionGates: [],
          redaction: 'none',
          hidden: false,
          agentId: 'codex',
        },
      ],
    },
    agentSettings: [CODEX_AGENT_SETTINGS_CONTRIBUTION],
    systemTools: [{
      toolId: 'codex-acp',
      displayName: 'Codex ACP',
      source: 'system',
      lookupNames: ['codex-acp'],
      defaultArgs: [],
    }],
  },
} satisfies CodexPluginManifestV2);
