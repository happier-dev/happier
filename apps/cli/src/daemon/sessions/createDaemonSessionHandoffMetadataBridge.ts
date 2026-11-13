import type { SessionHandoffLocalMetadataSource } from '@/session/handoff/metadata/runtimeLocalSessionHandoffMetadata';

import { createLoadLocalSessionMetadataForHandoff, createResolveHostedSessionWorkingDirectory } from './createLoadLocalSessionMetadataForHandoff';
import type { TrackedSession } from '../types';
import type { TrackedSessionMap } from '@/daemon/sessions/sessionTrackingKey';

export type DaemonSessionHandoffMetadataBridge = Readonly<{
  loadLocalSessionMetadataForHandoff: (sessionId: string) => Promise<SessionHandoffLocalMetadataSource | null>;
  resolveHostedSessionWorkingDirectory: (sessionId: string) => Promise<string | null>;
}>;

export function createDaemonSessionHandoffMetadataBridge(params: Readonly<{
  trackedSessionsByKey: TrackedSessionMap;
  getMachineId: () => string;
}>): DaemonSessionHandoffMetadataBridge {
  return {
    resolveHostedSessionWorkingDirectory: createResolveHostedSessionWorkingDirectory(params),
    loadLocalSessionMetadataForHandoff: createLoadLocalSessionMetadataForHandoff({
      trackedSessionsByKey: params.trackedSessionsByKey,
      getMachineId: params.getMachineId,
    }),
  };
}
