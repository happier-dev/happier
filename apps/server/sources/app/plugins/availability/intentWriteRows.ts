import type { PluginCollectionContractRefV1 } from '@happier-dev/protocol/plugins/data/collectionContractRefV1';
import type { Tx } from '@/storage/inTx';
import { getActivePrismaRuntime, getDbProviderFromEnv } from '@/storage/prisma';

/**
 * Persist the admitted intent CAS without making Prisma walk and encode every
 * Machine manifest under the Account lock. The caller captures declaration JSON
 * before admission; dialect differences here are storage encoding only.
 */
export async function updateIntentRow(tx: Tx, input: Readonly<{
    accountId: string;
    pluginId: string;
    revision: bigint;
    desiredVersion: string | null;
    enabled: boolean;
    offlineUiHosting: 'disabled' | 'enabled';
    writableCollections: readonly PluginCollectionContractRefV1[];
    releaseLessDeclarationText: string | null;
}>): Promise<number> {
    const prisma = getActivePrismaRuntime();
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    const identifier = (name: string) => prisma.raw(provider === 'mysql' ? `\`${name}\`` : `"${name}"`);
    const json = (text: string | null) => provider === 'sqlite' ? prisma.sql`${text}`
        : prisma.sql`CAST(${text} AS ${prisma.raw(provider === 'mysql' ? 'JSON' : 'JSONB')})`;
    return await tx.$executeRaw(prisma.sql`
        UPDATE ${identifier('AccountPluginIntent')}
        SET ${identifier('desiredVersion')} = ${input.desiredVersion},
            ${identifier('enabled')} = ${input.enabled},
            ${identifier('offlineUiHosting')} = ${input.offlineUiHosting},
            ${identifier('writableCollections')} = ${json(JSON.stringify(input.writableCollections))},
            ${identifier('releaseLessDeclaration')} = ${json(input.releaseLessDeclarationText)},
            ${identifier('revision')} = ${identifier('revision')} + 1,
            ${identifier('updatedAt')} = ${new Date()}
        WHERE ${identifier('accountId')} = ${input.accountId}
            AND ${identifier('pluginId')} = ${input.pluginId}
            AND ${identifier('revision')} = ${input.revision}
    `);
}
