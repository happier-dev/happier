import {
  definePluginManifest,
  type PluginBackendContributionV2,
  type PluginManifestV2,
} from '@happier-dev/plugin-sdk';
import { BackendSurfaceOperationCatalogV1 } from '@happier-dev/protocol';

const OH_MY_PI_BACKEND_ID = 'ohMyPi';
const SURFACE_OPERATIONS = BackendSurfaceOperationCatalogV1;
type BackendSurfaceHandlerV1 = NonNullable<PluginBackendContributionV2['surfaceHandlers']>[number];

function surfaceHandler(params: Readonly<{
  id: string;
  operation: string;
  exportName: string;
}>): BackendSurfaceHandlerV1 {
  return {
    surfaceApiVersion: 1,
    id: params.id,
    kind: 'externalSession',
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
  runtime: { apiVersion: 1, capabilities: ['backends'] },
  targets: {},
  capabilities: { permissions: [] },
  contributes: {
    backends: [
      {
        kindVersion: 1,
        id: OH_MY_PI_BACKEND_ID,
        agentId: OH_MY_PI_BACKEND_ID,
        engine: { kind: 'custom' },
        surfaceHandlers: [
          surfaceHandler({
            id: 'ohMyPi.externalSession.resolveSource',
            operation: SURFACE_OPERATIONS.externalSession.resolveSource,
            exportName: 'resolveOhMyPiExternalSessionSource',
          }),
          surfaceHandler({
            id: 'ohMyPi.externalSession.listCandidates',
            operation: SURFACE_OPERATIONS.externalSession.listCandidates,
            exportName: 'listOhMyPiExternalSessionCandidates',
          }),
          surfaceHandler({
            id: 'ohMyPi.externalSession.getActivity',
            operation: SURFACE_OPERATIONS.externalSession.getActivity,
            exportName: 'getOhMyPiExternalSessionActivity',
          }),
          surfaceHandler({
            id: 'ohMyPi.externalSession.pageTranscript',
            operation: SURFACE_OPERATIONS.externalSession.pageTranscript,
            exportName: 'pageOhMyPiExternalSessionTranscript',
          }),
          surfaceHandler({
            id: 'ohMyPi.externalSession.readAfterTranscript',
            operation: SURFACE_OPERATIONS.externalSession.readAfterTranscript,
            exportName: 'readOhMyPiExternalSessionAfterTranscript',
          }),
          surfaceHandler({
            id: 'ohMyPi.externalSession.resolveFollowTranscriptPath',
            operation: SURFACE_OPERATIONS.externalSession.resolveFollowTranscriptPath,
            exportName: 'resolveOhMyPiExternalSessionFollowTranscriptPath',
          }),
          surfaceHandler({
            id: 'ohMyPi.externalSession.acquireFollowLease',
            operation: SURFACE_OPERATIONS.externalSession.acquireFollowLease,
            exportName: 'acquireOhMyPiExternalSessionFollowLease',
          }),
          surfaceHandler({
            id: 'ohMyPi.externalSession.resolveLinkIdentity',
            operation: SURFACE_OPERATIONS.externalSession.resolveLinkIdentity,
            exportName: 'resolveOhMyPiExternalSessionLinkIdentity',
          }),
          surfaceHandler({
            id: 'ohMyPi.externalSession.resolveLinkedIdentity',
            operation: SURFACE_OPERATIONS.externalSession.resolveLinkedIdentity,
            exportName: 'resolveLinkedOhMyPiExternalSessionIdentity',
          }),
          surfaceHandler({
            id: 'ohMyPi.externalSession.resolveTakeoverLaunch',
            operation: SURFACE_OPERATIONS.externalSession.resolveTakeoverLaunch,
            exportName: 'resolveOhMyPiExternalSessionTakeoverLaunch',
          }),
        ],
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
  },
} satisfies PluginManifestV2);
