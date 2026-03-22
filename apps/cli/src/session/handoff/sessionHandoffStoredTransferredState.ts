import {
  createSessionHandoffMetadataV2,
  type SessionHandoffMetadataV2,
} from './transfer/sessionHandoffMetadataV2';
import {
  createSessionHandoffTransferredBundles,
  type SessionHandoffTransferredBundles,
} from './transfer/sessionHandoffTransferredBundles';

export type SessionHandoffStoredTransferredState = Readonly<{
  transferredBundles?: SessionHandoffTransferredBundles;
  handoffMetadataV2?: SessionHandoffMetadataV2;
}>;

function stripProviderBundle(
  transferredBundles?: SessionHandoffTransferredBundles | null,
): SessionHandoffTransferredBundles | undefined {
  if (!transferredBundles) {
    return undefined;
  }

  return createSessionHandoffTransferredBundles({
    ...(transferredBundles.workspaceExportArtifacts
      ? { workspaceExportArtifacts: transferredBundles.workspaceExportArtifacts }
      : {}),
  });
}

export function resolveStoredSessionHandoffMetadataV2(
  current?: SessionHandoffStoredTransferredState | null,
): SessionHandoffMetadataV2 | undefined {
  return current?.handoffMetadataV2;
}

function mergeStoredSessionHandoffMetadataV2(params: Readonly<{
  current?: SessionHandoffStoredTransferredState | null;
  handoffMetadataV2?: SessionHandoffMetadataV2;
}>): SessionHandoffMetadataV2 | undefined {
  const currentMetadata = resolveStoredSessionHandoffMetadataV2(params.current);
  return createSessionHandoffMetadataV2({
    ...(params.handoffMetadataV2?.providerBundleTransferPublication
      ? { providerBundleTransferPublication: params.handoffMetadataV2.providerBundleTransferPublication }
      : currentMetadata?.providerBundleTransferPublication
        ? { providerBundleTransferPublication: currentMetadata.providerBundleTransferPublication }
        : {}),
    ...(params.handoffMetadataV2?.workspaceReplicationMetadata
      ? { workspaceReplicationMetadata: params.handoffMetadataV2.workspaceReplicationMetadata }
      : currentMetadata?.workspaceReplicationMetadata
        ? { workspaceReplicationMetadata: currentMetadata.workspaceReplicationMetadata }
        : {}),
    ...(params.handoffMetadataV2?.workspaceReplicationDirectPeerPublication
      ? {
          workspaceReplicationDirectPeerPublication:
            params.handoffMetadataV2.workspaceReplicationDirectPeerPublication,
        }
      : currentMetadata?.workspaceReplicationDirectPeerPublication
        ? {
            workspaceReplicationDirectPeerPublication:
              currentMetadata.workspaceReplicationDirectPeerPublication,
          }
        : {}),
  });
}

export function createSessionHandoffStoredTransferredState(params: Readonly<{
  current?: SessionHandoffStoredTransferredState | null;
  transferredBundles: SessionHandoffTransferredBundles;
  handoffMetadataV2?: SessionHandoffMetadataV2;
}>): SessionHandoffStoredTransferredState {
  const handoffMetadataV2 = mergeStoredSessionHandoffMetadataV2(params);
  const currentTransferredBundles = stripProviderBundle(params.current?.transferredBundles);
  const incomingTransferredBundles = stripProviderBundle(params.transferredBundles);
  const transferredBundles = createSessionHandoffTransferredBundles({
    ...(incomingTransferredBundles?.workspaceExportArtifacts
      ? { workspaceExportArtifacts: incomingTransferredBundles.workspaceExportArtifacts }
      : currentTransferredBundles?.workspaceExportArtifacts
        ? { workspaceExportArtifacts: currentTransferredBundles.workspaceExportArtifacts }
        : {}),
  });

  return {
    ...(handoffMetadataV2 ? { handoffMetadataV2 } : {}),
    transferredBundles,
  };
}
