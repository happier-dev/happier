import type { Tx } from '@/storage/inTx';
import { getDbProviderFromEnv } from '@/storage/prisma';

/** The Source parent serializes first-insert CAS for its separate defaults leaves. */
export async function lockProjectSourceForDefaultsInTx(tx: Tx, sourceId: string): Promise<void> {
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    if (provider === 'postgres' || provider === 'pglite') {
        await tx.$queryRawUnsafe('SELECT "id" FROM "ProjectSource" WHERE "id" = $1 FOR UPDATE', sourceId);
    }
    if (provider === 'mysql') await tx.$queryRawUnsafe('SELECT `id` FROM `ProjectSource` WHERE `id` = ? FOR UPDATE', sourceId);
}
