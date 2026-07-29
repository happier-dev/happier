import type { ConnectedServiceRuntimeSnapshot } from '@/daemon/connectedServices/connectedServiceRuntimeSnapshot';

export function uniqueSnapshotKey(snapshot: ConnectedServiceRuntimeSnapshot): string {
  return JSON.stringify({
    connectedServices: snapshot.connectedServices,
    connectedServicesUpdatedAt: snapshot.connectedServicesUpdatedAt,
    connectedServiceMaterializationIdentityV1: snapshot.connectedServiceMaterializationIdentityV1,
  });
}
