import { HOME_SETTINGS_ID } from '@/app/home/settings/homeSettings';
import type { Tx } from '@/storage/inTx';
import { getDbProviderFromEnv } from '@/storage/prisma';

/** Acquire before relation/access reads, including MySQL's first consistent read. */
export async function acquireSessionManagerHomeFenceInTx(tx: Tx): Promise<void> {
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    if (provider === 'sqlite') {
        await tx.$executeRawUnsafe('INSERT OR IGNORE INTO "HomeSettings" ("id", "revision", "updatedAt") VALUES (?, 1, ?)', HOME_SETTINGS_ID, Date.now());
        const count = await tx.$executeRawUnsafe('UPDATE "HomeSettings" SET "revision" = "revision" WHERE "id" = ?', HOME_SETTINGS_ID);
        if (count !== 1) throw new Error('Manager Home fence requires the HomeSettings singleton');
        return;
    }
    if (provider === 'mysql') {
        // A duplicate INSERT IGNORE holds a shared record lock. Concurrent
        // callers would then deadlock upgrading it. The no-op upsert acquires
        // the exclusive fence directly, whether the singleton exists or not.
        await tx.$executeRawUnsafe('INSERT INTO `HomeSettings` (`id`, `revision`, `updatedAt`) VALUES (?, 1, CURRENT_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE `id` = `id`', HOME_SETTINGS_ID);
        return;
    }
    await tx.$executeRawUnsafe('INSERT INTO "HomeSettings" ("id", "revision", "updatedAt") VALUES ($1, 1, CURRENT_TIMESTAMP) ON CONFLICT ("id") DO NOTHING', HOME_SETTINGS_ID);
    const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT "id" FROM "HomeSettings" WHERE "id" = $1 FOR UPDATE',
        HOME_SETTINGS_ID,
    );
    if (rows.length !== 1) throw new Error('Manager Home fence requires the HomeSettings singleton');
}
