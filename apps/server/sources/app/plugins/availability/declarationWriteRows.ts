import type { Tx } from '@/storage/inTx';
import { getActivePrismaRuntime, getDbProviderFromEnv } from '@/storage/prisma';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import type { PluginDeclarationChange } from './currentDeclaration';

/** Called only after creating the intent or winning its revision CAS, in the same transaction. */
export async function applyPluginDeclarationChangeTx(
    tx: Tx,
    accountId: string,
    pluginId: string,
    change: PluginDeclarationChange | undefined,
    clear = false,
): Promise<void> {
    if (!change && !clear) return;
    const prisma = getActivePrismaRuntime();
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    const name = (identifier: string) => prisma.raw(provider === 'mysql' ? `\`${identifier}\`` : `"${identifier}"`);
    const table = name('AccountPluginDeclarationBody');
    const accountColumn = name('accountId');
    const pluginColumn = name('pluginId');
    const digestColumn = name('declarationDigest');
    const owner = prisma.sql`${accountColumn} = ${accountId} AND ${pluginColumn} = ${pluginId}`;
    // A retained body can already hold this immutable digest during an inline-to-split write.
    // MySQL's only unique key on this table is the same three-column primary key.
    const onConflict = provider === 'mysql'
        ? prisma.sql`ON DUPLICATE KEY UPDATE ${digestColumn} = ${digestColumn}`
        : prisma.sql`ON CONFLICT (${accountColumn}, ${pluginColumn}, ${digestColumn}) DO NOTHING`;

    for (const bodies of portableQueryChunks({ values: change?.inserted ?? [], bindingsPerValue: 4, fixedBindings: 0 })) {
        const values = bodies.map(({ digest, manifestText }) => {
            const body = provider === 'sqlite' ? prisma.sql`json(${manifestText})`
                : provider === 'mysql' ? prisma.sql`CAST(${manifestText} AS JSON)`
                : prisma.sql`CAST(${manifestText} AS jsonb)`;
            return prisma.sql`(${accountId}, ${pluginId}, ${digest}, ${body})`;
        });
        await tx.$executeRaw(prisma.sql`INSERT INTO ${table}
            (${accountColumn}, ${pluginColumn}, ${digestColumn}, ${name('manifest')}) VALUES ${prisma.join(values)} ${onConflict}`);
    }
    if (clear) {
        await tx.$executeRaw(prisma.sql`DELETE FROM ${table} WHERE ${owner}`);
    }
    for (const digests of portableQueryChunks({ values: change?.retired ?? [], bindingsPerValue: 1, fixedBindings: 2 })) {
        await tx.$executeRaw(prisma.sql`DELETE FROM ${table}
            WHERE ${owner} AND ${digestColumn} IN (${prisma.join([...digests])})`);
    }
}
