import {
  definePluginManifest,
  type PluginBackendContributionV2,
  type PluginManifestV2,
  type PluginMcpContributesV1,
  type PluginSystemToolContributionV1,
} from '@happier-dev/plugin-sdk';
import {
  BackendSurfaceOperationCatalogV1,
  type PluginHookContributionV2,
} from '@happier-dev/protocol';

type CodexPluginManifestV2 = Omit<PluginManifestV2, 'contributes'> & Readonly<{
  contributes: Readonly<{
    backends: ReadonlyArray<PluginBackendContributionV2>;
    hooks: ReadonlyArray<PluginHookContributionV2>;
    mcp: PluginMcpContributesV1;
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
  runtime: { apiVersion: 1, capabilities: ['agents', 'backends', 'mcp', 'hooks'] },
  targets: {},
  capabilities: { permissions: [{ capability: 'hooks.register' }] },
  contributes: {
    backends: [
      {
        kindVersion: 1,
        id: 'codex',
        agentId: 'codex',
        engine: { kind: 'custom' },
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
        capabilities: {
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
        id: 'backend.resolveRuntimePrerequisites',
        hookApiVersion: 1,
        category: 'decision',
        scope: 'backend',
        filters: { backendId: 'codex' },
        executionKind: 'decide',
        handler: {
          target: 'plugin',
          exportName: 'resolveCodexDaemonSpawnPrerequisites',
        },
      },
      {
        id: 'spawn.augmentEnv',
        hookApiVersion: 1,
        category: 'augmentation',
        scope: 'daemon',
        filters: { backendId: 'codex' },
        executionKind: 'augment',
        handler: {
          target: 'plugin',
          exportName: 'augmentCodexDaemonSpawnEnv',
        },
      },
    ],
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
          providerId: 'codex',
        },
      ],
    },
    systemTools: [{
      toolId: 'codex-acp',
      displayName: 'Codex ACP',
      source: 'system',
      lookupNames: ['codex-acp'],
      defaultArgs: [],
    }],
  },
} satisfies CodexPluginManifestV2);
