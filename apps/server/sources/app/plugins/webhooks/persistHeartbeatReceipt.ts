import { getDbProviderFromEnv, resolveDbSqlDialect } from '@/config/databaseProvider';

/** Raw liveness writes bypass Prisma's content @updatedAt, monotonically on every provider. */
export async function persistPluginWebhookHeartbeatReceiptV1(
    tx: Readonly<{ $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number> }>,
    params: Readonly<{ endpointId: string; receivedAt: Date }>,
): Promise<number> {
    const { endpointId, receivedAt } = params;
    const dialect = resolveDbSqlDialect(getDbProviderFromEnv(process.env, 'postgres'));
    if (dialect === 'postgres') {
        // Prisma DateTime is timezone-free UTC; Date parameters are timestamptz.
        const utc = receivedAt.toISOString();
        return await tx.$executeRaw`
            UPDATE "PluginWebhookEndpoint"
            SET "lastAcceptedAt" = GREATEST(COALESCE("lastAcceptedAt", CAST(${utc} AS timestamp)), CAST(${utc} AS timestamp))
            WHERE "id" = ${endpointId} AND ("lastAcceptedAt" IS NULL OR "lastAcceptedAt" < CAST(${utc} AS timestamp))
        `;
    }
    if (dialect === 'mysql') {
        return await tx.$executeRaw`
            UPDATE \`PluginWebhookEndpoint\`
            SET \`lastAcceptedAt\` = GREATEST(COALESCE(\`lastAcceptedAt\`, ${receivedAt}), ${receivedAt})
            WHERE \`id\` = ${endpointId} AND (\`lastAcceptedAt\` IS NULL OR \`lastAcceptedAt\` < ${receivedAt})
        `;
    }
    return await tx.$executeRaw`
        UPDATE "PluginWebhookEndpoint"
        SET "lastAcceptedAt" = MAX(COALESCE("lastAcceptedAt", ${receivedAt}), ${receivedAt})
        WHERE "id" = ${endpointId} AND ("lastAcceptedAt" IS NULL OR "lastAcceptedAt" < ${receivedAt})
    `;
}

