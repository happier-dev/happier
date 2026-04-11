import { rm } from 'node:fs/promises';

import type {
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceId,
} from '@happier-dev/protocol';

export type ConnectedServicesSpawnMaterialization = Readonly<{
  env: Record<string, string>;
  cleanupOnFailure: (() => void) | null;
  cleanupOnExit: (() => void) | null;
}>;

export type ConnectedServicesSpawnMaterializer = (params: Readonly<{
  materializationKey: string;
  activeServerDir: string;
  baseDir: string;
  rootDir: string;
  recordsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
}>) => Promise<ConnectedServicesSpawnMaterialization | null>;

export function createBestEffortCleanupDirectory(path: string): () => void {
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    void rm(path, { recursive: true, force: true }).catch(() => {});
  };
}
