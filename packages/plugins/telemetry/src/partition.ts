import { PluginError } from '@happier-dev/plugin-sdk';
import type { DatabaseCaptureSourceV1 } from '@happier-dev/database-protocol';
import { telemetryPartition } from './telemetry/assignments.js';

/** Source identity codec shared by local launch, authorized readers and Resource invalidation.
 * A worktree partition belongs to the Account whose admitted launch recorded it (P5: never mix
 * Accounts' captures), so a reader names only the source and its own Account selects the rows. */
export function captureSourcePartition(source: DatabaseCaptureSourceV1, accountId: string | undefined): string {
    if (source.kind === 'environment') return telemetryPartition(source.environmentId);
    if (!accountId) throw new PluginError({ code: 'capture_source_unavailable' });
    return JSON.stringify([accountId, source.serverId, source.machineId, source.projectId, source.workspaceId]);
}
