import { WorkspaceManifestSchema } from '@happier-dev/protocol';
import { z } from 'zod';

import { createJsonTransferPayloadCodec } from '@/machines/transfer/transferPayloadCodec';

import type { WorkspaceReplicationSourceOffer } from './createWorkspaceReplicationSourceOffer';

const WorkspaceReplicationSourceOfferBlobSchema = z.object({
  digest: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
}).strict();

const WorkspaceReplicationSourceOfferSchema = z.object({
  offerId: z.string().min(1),
  relationshipId: z.string().min(1),
  directionId: z.string().min(1),
  sourceFingerprint: z.string().min(1),
  manifest: WorkspaceManifestSchema,
  blobIndex: z.array(WorkspaceReplicationSourceOfferBlobSchema),
  sourceControllerMetadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

function decodeWorkspaceReplicationSourceOffer(payload: unknown): WorkspaceReplicationSourceOffer {
  const parsed = WorkspaceReplicationSourceOfferSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error('Invalid workspace replication source offer');
  }
  return parsed.data;
}

export const workspaceReplicationSourceOfferCodec = createJsonTransferPayloadCodec<WorkspaceReplicationSourceOffer>({
  encodePayload: (payload) => payload,
  decodePayload: decodeWorkspaceReplicationSourceOffer,
  invalidPayloadMessage: 'Invalid workspace replication source offer',
});
