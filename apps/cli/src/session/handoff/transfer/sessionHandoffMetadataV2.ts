import {
  TransferEndpointCandidateSchema,
  WorkspaceManifestSchema,
} from '@happier-dev/protocol';
import { z } from 'zod';

import type { SessionHandoffProviderBundleTransferPublication } from '../sessionHandoffProviderBundleTransferPublication';
import { parseSessionHandoffProviderBundleTransferPublication } from '../sessionHandoffProviderBundleTransferPublication';
import type { SessionHandoffWorkspaceReplicationDirectPeerPublication } from '../workspace/sessionHandoffWorkspaceReplicationDirectPeer';
import type { SessionHandoffWorkspaceReplicationMetadata } from '../workspace/sessionHandoffWorkspaceReplicationMetadata';

const SessionHandoffWorkspaceReplicationMetadataSchema = z.object({
  sourceRootPath: z.string().min(1),
  manifest: WorkspaceManifestSchema,
  sourceControllerMetadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

const SessionHandoffWorkspaceReplicationDirectPeerPublicationSchema = z.object({
  blobPacks: z.array(z.object({
    transferId: z.string().min(1),
    packId: z.string().min(1),
    digests: z.tuple([z.string().min(1)]),
    endpointCandidates: z.array(TransferEndpointCandidateSchema),
  }).strict()),
}).strict();

const SessionHandoffMetadataV2Schema = z.object({
  providerBundleTransferPublication: z.unknown().optional(),
  workspaceReplicationMetadata: SessionHandoffWorkspaceReplicationMetadataSchema.optional(),
  workspaceReplicationDirectPeerPublication: SessionHandoffWorkspaceReplicationDirectPeerPublicationSchema.optional(),
}).strict();

export type SessionHandoffMetadataV2 = Readonly<{
  providerBundleTransferPublication?: SessionHandoffProviderBundleTransferPublication;
  workspaceReplicationMetadata?: SessionHandoffWorkspaceReplicationMetadata;
  workspaceReplicationDirectPeerPublication?: SessionHandoffWorkspaceReplicationDirectPeerPublication;
}>;

function cloneProviderBundleTransferPublication(
  value: SessionHandoffProviderBundleTransferPublication,
): SessionHandoffProviderBundleTransferPublication {
  return {
    ...value,
    ...(value.endpointCandidates ? { endpointCandidates: [...value.endpointCandidates] } : {}),
  };
}

function cloneWorkspaceReplicationMetadata(
  value: SessionHandoffWorkspaceReplicationMetadata,
): SessionHandoffWorkspaceReplicationMetadata {
  return {
    sourceRootPath: value.sourceRootPath,
    manifest: {
      entries: value.manifest.entries.map((entry) => ({ ...entry })),
      ...(value.manifest.fingerprint ? { fingerprint: value.manifest.fingerprint } : {}),
    },
    ...(value.sourceControllerMetadata ? { sourceControllerMetadata: { ...value.sourceControllerMetadata } } : {}),
  };
}

function cloneWorkspaceReplicationDirectPeerPublication(
  value: SessionHandoffWorkspaceReplicationDirectPeerPublication,
): SessionHandoffWorkspaceReplicationDirectPeerPublication {
  return {
    blobPacks: value.blobPacks.map((blobPack) => ({
      transferId: blobPack.transferId,
      packId: blobPack.packId,
      digests: [blobPack.digests[0]],
      endpointCandidates: [...blobPack.endpointCandidates],
    })),
  };
}

export function createSessionHandoffMetadataV2(input: Readonly<{
  providerBundleTransferPublication?: SessionHandoffProviderBundleTransferPublication;
  workspaceReplicationMetadata?: SessionHandoffWorkspaceReplicationMetadata;
  workspaceReplicationDirectPeerPublication?: SessionHandoffWorkspaceReplicationDirectPeerPublication;
}>): SessionHandoffMetadataV2 | undefined {
  const metadata: SessionHandoffMetadataV2 = {
    ...(input.providerBundleTransferPublication
      ? { providerBundleTransferPublication: cloneProviderBundleTransferPublication(input.providerBundleTransferPublication) }
      : {}),
    ...(input.workspaceReplicationMetadata
      ? { workspaceReplicationMetadata: cloneWorkspaceReplicationMetadata(input.workspaceReplicationMetadata) }
      : {}),
    ...(input.workspaceReplicationDirectPeerPublication
      ? {
          workspaceReplicationDirectPeerPublication: cloneWorkspaceReplicationDirectPeerPublication(
            input.workspaceReplicationDirectPeerPublication,
          ),
        }
      : {}),
  };

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export function parseSessionHandoffMetadataV2(value: unknown): SessionHandoffMetadataV2 | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = SessionHandoffMetadataV2Schema.safeParse(value);
  if (!parsed.success) {
    throw new Error('Invalid session handoff transfer payload');
  }

  const providerBundleTransferPublication = parsed.data.providerBundleTransferPublication === undefined
    ? undefined
    : parseSessionHandoffProviderBundleTransferPublication(parsed.data.providerBundleTransferPublication) ?? undefined;

  return createSessionHandoffMetadataV2({
    ...(providerBundleTransferPublication ? { providerBundleTransferPublication } : {}),
    ...(parsed.data.workspaceReplicationMetadata
      ? { workspaceReplicationMetadata: parsed.data.workspaceReplicationMetadata }
      : {}),
    ...(parsed.data.workspaceReplicationDirectPeerPublication
      ? {
          workspaceReplicationDirectPeerPublication: cloneWorkspaceReplicationDirectPeerPublication(
            parsed.data.workspaceReplicationDirectPeerPublication,
          ),
        }
      : {}),
  });
}
