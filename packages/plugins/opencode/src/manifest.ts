import {
  definePluginManifest,
  type PluginBackendContributionV2,
  type PluginManifestV2,
  type PluginMcpContributesV1,
} from '@happier-dev/plugin-sdk';
import { BackendSurfaceOperationCatalogV1 } from '@happier-dev/protocol';

const OPENCODE_BACKEND_ID = 'opencode';
const SURFACE_OPERATIONS = BackendSurfaceOperationCatalogV1;
type BackendSurfaceHandlerV1 = NonNullable<PluginBackendContributionV2['surfaceHandlers']>[number];

function surfaceHandler(params: Readonly<{
  id: string;
  kind: 'externalSession' | 'handoff' | 'fork';
  operation: string;
  exportName: string;
}>): BackendSurfaceHandlerV1 {
  return {
    surfaceApiVersion: 1,
    id: params.id,
    kind: params.kind,
    operation: params.operation,
    handler: { target: 'daemon' as const, exportName: params.exportName },
  } as BackendSurfaceHandlerV1;
}

type OpenCodePluginManifestV2 = Omit<PluginManifestV2, 'contributes'> & Readonly<{
  contributes: Readonly<{
    backends: ReadonlyArray<PluginBackendContributionV2>;
    mcp: PluginMcpContributesV1;
  }>;
}>;

// Thin composition file that declares this plugin’s canonical manifest.
// Keep this mostly declarative; executable behavior lives in domain folders.
export const PLUGIN_MANIFEST = definePluginManifest({
  schemaVersion: 2,
  id: 'happier.agent.opencode',
  version: '0.0.0',
  displayName: 'opencode',
  description: undefined,
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1, capabilities: ['backends', 'mcp'] },
  targets: {},
  capabilities: { permissions: [] },
  contributes: {
    backends: [
      {
        kindVersion: 1,
        id: OPENCODE_BACKEND_ID,
        agentId: 'opencode',
        engine: { kind: 'custom' },
        surfaceHandlers: [
          surfaceHandler({
            id: 'opencode.externalSession.resolveSource',
            kind: 'externalSession',
            operation: SURFACE_OPERATIONS.externalSession.resolveSource,
            exportName: 'resolveOpenCodeExternalSessionSource',
          }),
          surfaceHandler({
            id: 'opencode.externalSession.listCandidates',
            kind: 'externalSession',
            operation: SURFACE_OPERATIONS.externalSession.listCandidates,
            exportName: 'listOpenCodeExternalSessionCandidates',
          }),
          surfaceHandler({
            id: 'opencode.externalSession.getActivity',
            kind: 'externalSession',
            operation: SURFACE_OPERATIONS.externalSession.getActivity,
            exportName: 'getOpenCodeExternalSessionActivity',
          }),
          surfaceHandler({
            id: 'opencode.externalSession.pageTranscript',
            kind: 'externalSession',
            operation: SURFACE_OPERATIONS.externalSession.pageTranscript,
            exportName: 'pageOpenCodeExternalSessionTranscript',
          }),
          surfaceHandler({
            id: 'opencode.externalSession.readAfterTranscript',
            kind: 'externalSession',
            operation: SURFACE_OPERATIONS.externalSession.readAfterTranscript,
            exportName: 'readOpenCodeExternalSessionAfterTranscript',
          }),
          surfaceHandler({
            id: 'opencode.externalSession.resolveLinkIdentity',
            kind: 'externalSession',
            operation: SURFACE_OPERATIONS.externalSession.resolveLinkIdentity,
            exportName: 'resolveOpenCodeExternalSessionLinkIdentity',
          }),
          surfaceHandler({
            id: 'opencode.externalSession.resolveLinkedIdentity',
            kind: 'externalSession',
            operation: SURFACE_OPERATIONS.externalSession.resolveLinkedIdentity,
            exportName: 'resolveLinkedOpenCodeExternalSessionIdentity',
          }),
          surfaceHandler({
            id: 'opencode.externalSession.resolveTakeoverLaunch',
            kind: 'externalSession',
            operation: SURFACE_OPERATIONS.externalSession.resolveTakeoverLaunch,
            exportName: 'resolveOpenCodeExternalSessionTakeoverLaunch',
          }),
          surfaceHandler({
            id: 'opencode.handoff.exportBundle',
            kind: 'handoff',
            operation: SURFACE_OPERATIONS.handoff.exportBundle,
            exportName: 'exportOpenCodeSessionBundle',
          }),
          surfaceHandler({
            id: 'opencode.handoff.importBundle',
            kind: 'handoff',
            operation: SURFACE_OPERATIONS.handoff.importBundle,
            exportName: 'importOpenCodeSessionBundle',
          }),
          surfaceHandler({
            id: 'opencode.fork.resolveReplayChildLaunch',
            kind: 'fork',
            operation: SURFACE_OPERATIONS.fork.resolveReplayChildLaunch,
            exportName: 'resolveOpenCodeReplayForkChildLaunch',
          }),
        ],
        capabilities: {
          executionRun: { supported: true },
          session: {
            media: {
              acceptsImageInput: { supported: false },
              emitsSessionMedia: {
                supported: false,
              },
              nativeImageGeneration: { supported: false },
            },
          },
        },
      },
    ],
    mcp: {
      servers: [],
      discoveryProviders: [
        {
          id: 'opencode.config',
          kind: 'mcp.discoveryProvider',
          version: '1.0.0',
          capabilityGates: [],
          permissionGates: [],
          redaction: 'none',
          hidden: false,
          providerId: OPENCODE_BACKEND_ID,
        },
      ],
    },
  },
} satisfies OpenCodePluginManifestV2);
