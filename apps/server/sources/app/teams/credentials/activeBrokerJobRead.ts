import { getDbProviderFromEnv } from '@/storage/prisma';
import type { Tx } from '@/storage/inTx';

type ActiveBrokerJobRow = Readonly<{
    tokenEpoch: number | bigint;
    status: string;
    resourceId: string | null;
    teamId: string | null;
    custodianAccountId: string | null;
    enabled: number | bigint;
    revision: number | bigint | null;
    sourceBindingJson: string | null;
    brokerMachineId: string | null;
    brokerPoolId: string | null;
    sessionAccountId: string | null;
    sessionActive: number | bigint;
    sessionArchived: number | bigint;
    latestTurnId: string | null;
    latestTurnStatus: string | null;
    turnId: string | null;
    usageActorAccountId: string | null;
    teamCredentialResourceId: string | null;
    credentialDeliveryMode: string | null;
}>;

// One indexed read of the admitted job, not another permission evaluation.
// Values remain bound parameters; only the database dialect changes SQL syntax.
export async function readActiveBrokerJobRowsInTx(tx: Tx, input: Readonly<{
    accountId: string;
    resourceId: string;
    sessionId: string | null;
}>): Promise<ActiveBrokerJobRow | null> {
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    const query = `SELECT a."tokenEpoch", a."status",
        r."id" AS "resourceId", r."teamId", r."custodianAccountId",
        CASE WHEN r."enabled" THEN 1 ELSE 0 END AS "enabled",
        r."revision", r."sourceBindingJson", r."brokerMachineId", r."brokerPoolId",
        s."accountId" AS "sessionAccountId",
        CASE WHEN s."active" THEN 1 ELSE 0 END AS "sessionActive",
        CASE WHEN s."archivedAt" IS NOT NULL THEN 1 ELSE 0 END AS "sessionArchived",
        s."latestTurnId", s."latestTurnStatus", t."turnId", t."usageActorAccountId",
        t."teamCredentialResourceId", t."credentialDeliveryMode"
        FROM "Account" a
        LEFT JOIN "TeamCredentialResource" r ON r."id" = $1
        LEFT JOIN "Session" s ON s."id" = $2
        LEFT JOIN "SessionTurn" t ON t."sessionId" = s."id"
            AND t."turnId" = s."latestTurnId" AND t."status" = 'in_progress'
        WHERE a."id" = $3`;
    const sql = provider === 'mysql' ? query.replaceAll('"', '`').replace(/\$[123]/g, '?')
        : provider === 'sqlite' ? query.replace(/\$[123]/g, '?') : query;
    const [row] = await tx.$queryRawUnsafe<ActiveBrokerJobRow[]>(sql, input.resourceId, input.sessionId, input.accountId);
    return row ?? null;
}
