import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from '@happier-dev/protocol/zodRuntimePolicy';
import { WorkspaceRefV1Schema } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { ProjectServiceDeclarationRefV1Schema } from '@happier-dev/protocol/local/services/actions/v1';
import { LocalServiceLaunchTargetV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { RequesterWorkAttributionV1Schema } from '@/daemon/lifecycle/requesterWorkAttribution';
import { ensureProtectedLocalStateDirectory, readProtectedLocalStateFile, writeProtectedLocalStateFileAtomic } from '@/utils/fs/protectedLocalState';
import { ManagedServiceProcessRecoveryRecordSchema } from './managedProcessRecovery';

// Host-private observed identity, not permission or inputs to replay a launch.
const ProjectServiceRecoveryRecordSchema = z.strictObject({
    v: z.literal(1),
    workspace: WorkspaceRefV1Schema,
    declaration: ProjectServiceDeclarationRefV1Schema,
    requester: RequesterWorkAttributionV1Schema,
    cwd: z.string().check(z.minLength(1)),
    specIdentity: z.string().check(z.minLength(1)),
    endpointNone: z.optional(z.literal(true)),
    execution: LocalServiceLaunchTargetV1Schema.shape.execution,
    interactive: z.optional(z.literal(true)),
    portSource: LocalServiceLaunchTargetV1Schema.shape.portSource,
    process: ManagedServiceProcessRecoveryRecordSchema,
});
export type ProjectServiceRecoveryRecord = z.infer<typeof ProjectServiceRecoveryRecordSchema>;

/** One latest instance per declaration, owned by the existing Services owner. */
export function createProjectServiceRecoveryStore(directory: string | undefined) {
    const key = (record: ProjectServiceRecoveryRecord) => JSON.stringify([record.workspace.serverId,
        record.workspace.machineId, record.workspace.id, record.declaration, record.cwd]);
    return {
        async read(): Promise<readonly ProjectServiceRecoveryRecord[]> {
            if (!directory) return [];
            let names: string[];
            try { names = await readdir(directory); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
            return Promise.all(names.filter(name => name.endsWith('.json')).map(async name =>
                ProjectServiceRecoveryRecordSchema.parse(JSON.parse(await readProtectedLocalStateFile(join(directory, name), { authority: 'owned' })))));
        },
        async record(record: ProjectServiceRecoveryRecord): Promise<void> {
            if (!directory) return;
            const identity = key(record);
            await ensureProtectedLocalStateDirectory(directory, { authority: 'owned' });
            const path = join(directory, `${createHash('sha256').update(identity).digest('hex')}.json`);
            await writeProtectedLocalStateFileAtomic(path, `${JSON.stringify(record)}\n`, { authority: 'owned' });
        },
    };
}
