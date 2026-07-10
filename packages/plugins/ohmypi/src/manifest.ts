import {
  BackendSurfaceOperationCatalogV1,
  definePluginManifest,
  type PluginAgentContributionV2,
  type PluginManifestV2,
} from '@happier-dev/plugin-sdk/manifest';

const OH_MY_PI_BACKEND_ID = 'ohMyPi';
const SURFACE_OPERATIONS = BackendSurfaceOperationCatalogV1;
type BackendSurfaceHandlerV1 = NonNullable<PluginAgentContributionV2['surfaceHandlers']>[number];

function surfaceHandler(params: Readonly<{
  id: string;
  kind: BackendSurfaceHandlerV1['kind'];
  operation: string;
  exportName: string;
}>): BackendSurfaceHandlerV1 {
  return {
    surfaceApiVersion: 1,
    id: params.id,
    kind: params.kind,
    operation: params.operation,
    handler: { target: 'daemon', exportName: params.exportName },
  } satisfies BackendSurfaceHandlerV1;
}

// Thin composition file that declares this plugin’s canonical manifest.
// Keep unsupported media defaults explicit until a source-real media event is mapped.
export const PLUGIN_MANIFEST = definePluginManifest({
  schemaVersion: 2,
  // Package path/name stay lowercase (`packages/plugins/ohmypi`), while the runtime/provider id
  // remains the existing wire contract `ohMyPi`.
  id: 'happier.agent.ohmypi',
  version: '0.0.0',
  displayName: 'ohmypi',
  description: undefined,
  engines: { happier: '^0.0.0' },
  activationEvents: ['onAgent:ohMyPi'],
  uses: ['agents', 'hooks'],
  entrypoints: { main: './dist/index.js' },
  permissions: { required: [], optional: [] },
  contributes: {
    agents: [
      {
        kindVersion: 1,
        id: OH_MY_PI_BACKEND_ID,
        runtime: { kind: 'custom' },
        surfaceHandlers: [
          surfaceHandler({
            id: 'ohMyPi.terminalRuntime.resolveTranscriptBinding',
            kind: 'terminalRuntime',
            operation: SURFACE_OPERATIONS.terminalRuntime.resolveTranscriptBinding,
            exportName: 'resolveOhMyPiTerminalRuntimeTranscriptBinding',
          }),
          surfaceHandler({
            id: 'ohMyPi.externalSession.resolveSource',
            kind: 'externalSession',
            operation: SURFACE_OPERATIONS.externalSession.resolveSource,
            exportName: 'resolveOhMyPiExternalSessionSource',
          }),
          surfaceHandler({
            id: 'ohMyPi.externalSession.listCandidates',
            kind: 'externalSession',
            operation: SURFACE_OPERATIONS.externalSession.listCandidates,
            exportName: 'listOhMyPiExternalSessionCandidates',
          }),
          surfaceHandler({
            id: 'ohMyPi.externalSession.getActivity',
            kind: 'externalSession',
            operation: SURFACE_OPERATIONS.externalSession.getActivity,
            exportName: 'getOhMyPiExternalSessionActivity',
          }),
          surfaceHandler({
            id: 'ohMyPi.externalSession.pageTranscript',
            kind: 'externalSession',
            operation: SURFACE_OPERATIONS.externalSession.pageTranscript,
            exportName: 'pageOhMyPiExternalSessionTranscript',
          }),
          surfaceHandler({
            id: 'ohMyPi.externalSession.readAfterTranscript',
            kind: 'externalSession',
            operation: SURFACE_OPERATIONS.externalSession.readAfterTranscript,
            exportName: 'readOhMyPiExternalSessionAfterTranscript',
          }),
          surfaceHandler({
            id: 'ohMyPi.externalSession.resolveFollowTranscriptPath',
            kind: 'externalSession',
            operation: SURFACE_OPERATIONS.externalSession.resolveFollowTranscriptPath,
            exportName: 'resolveOhMyPiExternalSessionFollowTranscriptPath',
          }),
          surfaceHandler({
            id: 'ohMyPi.externalSession.acquireFollowLease',
            kind: 'externalSession',
            operation: SURFACE_OPERATIONS.externalSession.acquireFollowLease,
            exportName: 'acquireOhMyPiExternalSessionFollowLease',
          }),
          surfaceHandler({
            id: 'ohMyPi.externalSession.resolveLinkIdentity',
            kind: 'externalSession',
            operation: SURFACE_OPERATIONS.externalSession.resolveLinkIdentity,
            exportName: 'resolveOhMyPiExternalSessionLinkIdentity',
          }),
          surfaceHandler({
            id: 'ohMyPi.externalSession.resolveLinkedIdentity',
            kind: 'externalSession',
            operation: SURFACE_OPERATIONS.externalSession.resolveLinkedIdentity,
            exportName: 'resolveLinkedOhMyPiExternalSessionIdentity',
          }),
          surfaceHandler({
            id: 'ohMyPi.externalSession.resolveTakeoverLaunch',
            kind: 'externalSession',
            operation: SURFACE_OPERATIONS.externalSession.resolveTakeoverLaunch,
            exportName: 'resolveOhMyPiExternalSessionTakeoverLaunch',
          }),
        ],
        surfaces: {
          externalSession: {
            sources: [
              {
                sourceKind: 'ohMyPiAgentDir',
                schema: {
                  passthrough: true,
                  fields: [
                    { name: 'kind', kind: 'literal', value: 'ohMyPiAgentDir' },
                    { name: 'agentDir', kind: 'string', min: 1, max: 10_000, nullish: true },
                  ],
                },
                key: {
                  segments: [
                    { kind: 'literal', value: 'ohMyPiAgentDir' },
                    { kind: 'field', field: 'agentDir' },
                  ],
                },
              },
            ],
          },
        },
        capabilities: {
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
    hooks: [
      {
        id: 'agent.resolvePrerequisites',
        hookApiVersion: 1,
        category: 'decision',
        scope: 'agent',
        filters: { agentId: OH_MY_PI_BACKEND_ID },
        executionKind: 'decide',
        handler: {
          target: 'plugin',
          exportName: 'resolveOhMyPiDaemonSpawnPrerequisites',
        },
      },
    ],
  },
} satisfies PluginManifestV2);
