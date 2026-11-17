import type { DatabaseCaptureSourceV1 } from '@happier-dev/database-protocol';
import { telemetryPartition } from './telemetry/assignments.js';

/** Source identity codec shared by local launch, authorized readers and Resource invalidation. */
export function captureSourcePartition(source: DatabaseCaptureSourceV1): string {
    return source.kind === 'environment' ? telemetryPartition(source.environmentId)
        : JSON.stringify([source.serverId, source.machineId, source.projectId, source.workspaceId]);
}
