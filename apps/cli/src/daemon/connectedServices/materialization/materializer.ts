import { rm } from 'node:fs/promises';

import type {
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceId,
} from '@happier-dev/protocol';

export type ConnectedServicesMaterialization = Readonly<{
  env: Record<string, string>;
  cleanupOnFailure: (() => void) | null;
  cleanupOnExit: (() => void) | null;
}>;

export type ConnectedServicesMaterializer = (params: Readonly<{
  materializationKey: string;
  activeServerDir: string;
  baseDir: string;
  rootDir: string;
  recordsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
}>) => Promise<ConnectedServicesMaterialization | null>;

export function createBestEffortCleanupDirectory(path: string): () => void {
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    void rm(path, { recursive: true, force: true }).catch(() => {});
  };
}

export function createBestEffortConnectedServicesMaterialization(params: Readonly<{
  rootDir: string;
  env: Record<string, string>;
}>): ConnectedServicesMaterialization {
  const cleanup = createBestEffortCleanupDirectory(params.rootDir);
  return {
    env: params.env,
    cleanupOnFailure: cleanup,
    cleanupOnExit: cleanup,
  };
}
