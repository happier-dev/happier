import { createLocalSessionHandoffMetadataStore } from '@/session/handoff/metadata/localSessionHandoffMetadataStore';
import type { SessionHandoffLocalMetadataSource } from '@/session/handoff/metadata/runtimeLocalSessionHandoffMetadata';

import { createLoadLocalSessionMetadataForHandoff } from './createLoadLocalSessionMetadataForHandoff';
import type { TrackedSession } from '../types';

type SavePreparedTargetLocalMetadataInput = Readonly<{
  remoteSessionId: string;
  exportMetadataOverlay: Record<string, unknown>;
}>;

export type DaemonSessionHandoffMetadataBridge = Readonly<{
  loadLocalSessionMetadataForHandoff: (sessionId: string) => Promise<SessionHandoffLocalMetadataSource | null>;
  loadLocalHandoffMetadataByVendorResumeId: (vendorResumeId: string) => Promise<Record<string, unknown> | null>;
  savePreparedTargetLocalMetadata: (input: SavePreparedTargetLocalMetadataInput) => Promise<void>;
}>;

export function createDaemonSessionHandoffMetadataBridge(params: Readonly<{
  pidToTrackedSession: Map<number, TrackedSession>;
  getMachineId: () => string;
  activeServerDir: string;
}>): DaemonSessionHandoffMetadataBridge {
  const localSessionHandoffMetadataStore = createLocalSessionHandoffMetadataStore({
    activeServerDir: params.activeServerDir,
  });

  return {
    loadLocalSessionMetadataForHandoff: createLoadLocalSessionMetadataForHandoff({
      pidToTrackedSession: params.pidToTrackedSession,
      getMachineId: params.getMachineId,
      activeServerDir: params.activeServerDir,
      localSessionHandoffMetadataStore,
    }),
    loadLocalHandoffMetadataByVendorResumeId: async (vendorResumeId: string) =>
      await localSessionHandoffMetadataStore.loadByVendorResumeId(vendorResumeId),
    savePreparedTargetLocalMetadata: async ({ remoteSessionId, exportMetadataOverlay }) => {
      await localSessionHandoffMetadataStore.saveByVendorResumeId({
        vendorResumeId: remoteSessionId,
        exportMetadataOverlay,
      });
    },
  };
}
