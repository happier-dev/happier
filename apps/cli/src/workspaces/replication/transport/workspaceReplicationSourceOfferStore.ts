import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { WorkspaceReplicationSourceOffer } from './createWorkspaceReplicationSourceOffer';
import {
  readWorkspaceReplicationSourceOfferFromFile,
  writeWorkspaceReplicationSourceOfferToFile,
} from './workspaceReplicationSourceOfferFileFormat';

export type WorkspaceReplicationSourceOfferStore = Readonly<{
  write: (offer: WorkspaceReplicationSourceOffer) => Promise<Readonly<{ filePath: string; sizeBytes: number }>>;
  read: (offerId: string) => Promise<WorkspaceReplicationSourceOffer | null>;
  resolveFilePath: (offerId: string) => string;
}>;

function resolveOffersDirectory(activeServerDir: string): string {
  return join(activeServerDir, 'workspace-replication', 'offers');
}

export function resolveWorkspaceReplicationSourceOfferPath(input: Readonly<{
  activeServerDir: string;
  offerId: string;
}>): string {
  if (!/^offer_[A-Za-z0-9_-]+$/u.test(input.offerId)) {
    throw new Error(`Invalid workspace replication source offer id: ${input.offerId}`);
  }
  return join(resolveOffersDirectory(input.activeServerDir), `${input.offerId}.txt`);
}

export function createWorkspaceReplicationSourceOfferStore(input: Readonly<{
  activeServerDir: string;
}>): WorkspaceReplicationSourceOfferStore {
  return {
    resolveFilePath: (offerId) => resolveWorkspaceReplicationSourceOfferPath({ activeServerDir: input.activeServerDir, offerId }),
    write: async (offer) => {
      const offersDirectory = resolveOffersDirectory(input.activeServerDir);
      await mkdir(offersDirectory, { recursive: true });
      const filePath = resolveWorkspaceReplicationSourceOfferPath({ activeServerDir: input.activeServerDir, offerId: offer.offerId });
      return await writeWorkspaceReplicationSourceOfferToFile({ offer, filePath });
    },
    read: async (offerId) => {
      try {
        const filePath = resolveWorkspaceReplicationSourceOfferPath({ activeServerDir: input.activeServerDir, offerId });
        return await readWorkspaceReplicationSourceOfferFromFile({
          transferId: offerId,
          filePath,
        });
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError?.code === 'ENOENT') {
          return null;
        }
        throw error;
      }
    },
  };
}
