import { isDeepStrictEqual } from 'node:util';
import { ProjectSessionDefaultsV1Schema } from '@happier-dev/protocol/projects/projectSessionDefaultsV1';
import type { ProjectSessionDefaultsLeafV1 } from '@happier-dev/protocol/projects/projectSessionDefaultsStorageV1';
import type { ProjectSourcesUpdateInputV1, ProjectSourcesFailureV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { managedPlacementAudienceInTx } from '@/app/teams/managedPlacementAudience';
import type { Tx } from '@/storage/inTx';
import { prismaRuntime } from '@/storage/prisma';

const storedDefaults = createStoredReadSchema(ProjectSessionDefaultsV1Schema);
type LeafRead = Readonly<{ ok: true; sessionDefaults?: ProjectSessionDefaultsLeafV1 }>
    | Readonly<{ ok: false; error: 'source_invalid' }>;

/** Called only after Source admission; metadata lists never reach this leaf. */
export async function readProjectSourceSessionDefaultsInTx(tx: Tx, sourceId: string): Promise<LeafRead> {
    const row = await tx.projectSourceSessionDefaults.findUnique({ where: { sourceId }, select: { revision: true, defaults: true } });
    if (!row) return { ok: true };
    if (row.defaults === null) return { ok: true, sessionDefaults: { revision: row.revision, defaults: null } };
    const defaults = storedDefaults.safeParse(row.defaults);
    return defaults.success ? { ok: true, sessionDefaults: { revision: row.revision, defaults: defaults.data } }
        : { ok: false, error: 'source_invalid' };
}

/** Parent Source lock owns first insertion; prepare all refusals before either record is mutated. */
export async function prepareProjectSourceSessionDefaultsInTx(tx: Tx, input: Readonly<{
    sourceId: string;
    patch: NonNullable<ProjectSourcesUpdateInputV1['patch']['sessionDefaults']>;
    audience: () => Promise<readonly string[]>;
}>): Promise<Readonly<{ ok: true; sessionDefaults: ProjectSessionDefaultsLeafV1; write: (() => Promise<void>) | null }> | ProjectSourcesFailureV1> {
    const previous = await readProjectSourceSessionDefaultsInTx(tx, input.sourceId);
    if (!previous.ok) return previous;
    const revision = previous.sessionDefaults?.revision ?? 'absent';
    if (revision !== input.patch.expectedRevision) return { ok: false, error: 'source_conflict' };
    if (previous.sessionDefaults && isDeepStrictEqual(previous.sessionDefaults.defaults, input.patch.defaults)) {
        return { ok: true, sessionDefaults: previous.sessionDefaults, write: null };
    }
    const placement = input.patch.defaults?.placement;
    if (placement?.kind === 'machine' && !isDeepStrictEqual(previous.sessionDefaults?.defaults?.placement, placement)) {
        const accountIds = await input.audience();
        const admitted = await managedPlacementAudienceInTx(tx, { kind: 'accounts', accountIds }, placement);
        if (!admitted.ok) return admitted;
    }
    const sessionDefaults = { revision: revision === 'absent' ? 1 : revision + 1, defaults: input.patch.defaults };
    return { ok: true, sessionDefaults, write: async () => {
        const defaults = input.patch.defaults === null ? prismaRuntime.DbNull
            : JSON.parse(JSON.stringify(input.patch.defaults)) as import('@prisma/client').Prisma.InputJsonValue;
        if (revision === 'absent') {
            await tx.projectSourceSessionDefaults.create({ data: { sourceId: input.sourceId, defaults } });
        } else {
            const written = await tx.projectSourceSessionDefaults.updateMany({
                where: { sourceId: input.sourceId, revision }, data: { defaults, revision: { increment: 1 } },
            });
            if (written.count !== 1) throw new Error('Project Session defaults CAS lost its Source lock');
        }
    } };
}
