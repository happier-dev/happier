import type { UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { resolveUsageQueryPeriod } from '@happier-dev/protocol/inputs/usageQuery';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { buildSessionAccessWhere } from '@/app/session/access/sessionAccessWhere';
import type { Tx } from '@/storage/inTx';
import { prismaRuntime } from '@/storage/prisma';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { sessionEvidenceSql } from './sessionEvidenceSql';

/** Header-only authority scope. Explicit/historical membership never enters this census. */
export async function readSessionEvidenceCandidateIdsInTx(tx: Tx, input: Readonly<{
    accountId: string; authentication: SessionAccessAuthentication; candidateIds?: readonly string[];
}>): Promise<string[]> {
    const where = await buildSessionAccessWhere({ tx, accountId: input.accountId,
        authentication: input.authentication, capability: 'readTranscript', mode: 'effective_access_v1' });
    return (await tx.session.findMany({
        where: input.candidateIds === undefined ? where : { AND: [where, { id: { in: [...new Set(input.candidateIds)] } }] },
        select: { id: true },
    })).map(row => row.id);
}

/** Window predicates use producer timing; unrelated protected bodies stay in storage. */
export async function selectSessionEvidenceSubjectsInTx(tx: Tx, input: Readonly<{
    accountId: string; candidateIds: readonly string[]; query: UsageQuery; nowMs: number;
}>): Promise<string[]> {
    if (!input.candidateIds.length) return [];
    const j = sessionEvidenceSql();
    const c = (alias: string, key: string) => alias + '.' + j.column(key);
    const period = resolveUsageQueryPeriod(input.query, input.nowMs);
    const start = period.startMs ?? 0, end = period.endMs ?? input.nowMs;
    const inWindow = (expression: string) => prismaRuntime.sql`(${prismaRuntime.raw(expression)} >= ${start} AND ${prismaRuntime.raw(expression)} < ${end})`;
    const numeric = (value: string) => `CASE WHEN ${j.type(value)} IN ('number','integer','real','double','decimal')
        THEN CAST(${j.text(value)} AS ${j.dialect === 'postgres' ? 'double precision' : j.dialect === 'mysql' ? 'DECIMAL(65,10)' : 'REAL'}) ELSE NULL END`;
    const dateMs = (value: string) => j.dialect === 'postgres' ? `(EXTRACT(EPOCH FROM ${value})*1000)`
        : j.dialect === 'mysql' ? `(UNIX_TIMESTAMP(${value})*1000)` : value;
    // Identity filters still consume the canonical physical metadata paths.
    const metadata = c('s', 'metadata');
    const ownerEnvelope = c('s', 'ownerMetadata');
    const timing = j.nativeJson(c('s', 'usageTimingV1'));
    const activityWindow = prismaRuntime.sql`(${prismaRuntime.raw(dateMs(c('s', 'updatedAt')))}>=${start}
        OR ${prismaRuntime.raw(dateMs(c('s', 'lastActiveAt')))}>=${start})`;
    // This is an unknown-coverage fallback, never a substitute timing proof.
    // The owner accepts omitting orphaned legacy waits in silent old Sessions;
    // the independent Turn predicate below still retains overlapping live work.
    const boundsRelevant = (value: string, unknownWindow = activityWindow) => prismaRuntime.sql`(CASE
        WHEN ${prismaRuntime.raw(j.type(value))} IS NULL OR ${prismaRuntime.raw(j.type(value))}<>'object'
            OR COALESCE(${prismaRuntime.raw(numeric(j.json(value, 'v')))},0)<>1 THEN ${unknownWindow}
        WHEN ${prismaRuntime.raw(j.text(value, 'minMs'))} IS NULL AND ${prismaRuntime.raw(j.text(value, 'maxMs'))} IS NULL THEN FALSE
        WHEN ${prismaRuntime.raw(j.type(j.json(value, 'minMs')))} IN ('number','integer','real','double','decimal')
            THEN (${prismaRuntime.raw(numeric(j.json(value, 'minMs')))}<${end}
                AND (${prismaRuntime.raw(j.text(value, 'maxMs'))} IS NULL
                    OR ${prismaRuntime.raw(numeric(j.json(value, 'maxMs')))}>=${start}))
        ELSE ${unknownWindow} END)`;
    const metadataWindow = boundsRelevant(j.json(timing, 'metadata'));
    const stateWindow = boundsRelevant(j.json(timing, 'agentState'));
    // Recipients cannot observe owner-private timing through membership. Finite
    // publication may also hide live row activity, so keep them conservative.
    const privateDocumentsWindow = prismaRuntime.sql`(${prismaRuntime.raw(c('s', 'accountId'))}<>${input.accountId}
        OR ${metadataWindow} OR ${stateWindow})`;
    const messageWindow = prismaRuntime.sql`EXISTS (SELECT 1 FROM ${prismaRuntime.raw(j.column('SessionMessage'))} m
        WHERE ${prismaRuntime.raw(c('m', 'sessionId'))}=${prismaRuntime.raw(c('s', 'id'))}
        AND (${inWindow(dateMs(c('m', 'createdAt')))} OR ${boundsRelevant(j.nativeJson(c('m', 'usageTimingV1')),
            prismaRuntime.sql`(${activityWindow} OR ${prismaRuntime.raw(dateMs(c('m', 'updatedAt')))}>=${start})`)}))`;
    const turnWindow = prismaRuntime.sql`EXISTS (SELECT 1 FROM ${prismaRuntime.raw(j.column('SessionTurn'))} t
        WHERE ${prismaRuntime.raw(c('t', 'sessionId'))}=${prismaRuntime.raw(c('s', 'id'))}
        AND ${prismaRuntime.raw(c('t', 'startedAt'))}<${end}
        AND (${prismaRuntime.raw(c('t', 'terminalAt'))} IS NULL OR ${prismaRuntime.raw(c('t', 'terminalAt'))}>${start}))`;
    const createdOrigin = prismaRuntime.sql`(${prismaRuntime.raw(c('s', 'originKind'))} IN ('session','execution_run')
        AND ${inWindow(dateMs(c('s', 'createdAt')))})`;
    // Manager reports are intentionally untimed in the canonical Usage fold.
    const managerReport = prismaRuntime.sql`EXISTS (SELECT 1 FROM ${prismaRuntime.raw(j.column('SessionFollowEdge'))} manager
        WHERE ${prismaRuntime.raw(c('manager', 'managerSourceSessionId'))}=${prismaRuntime.raw(c('s', 'id'))})`;
    // Content mode and owner-document encryption independently hide filter identity.
    const opaqueFacts = prismaRuntime.sql`(${prismaRuntime.raw(c('s', 'encryptionMode'))}<>'plain'
        OR (${prismaRuntime.raw(c('s', 'metadataLayoutVersion'))}=1 AND ${prismaRuntime.raw(j.text(ownerEnvelope, 't'))}='encrypted'))`;
    const agentFilter = input.query.agents.length ? prismaRuntime.sql`AND (${opaqueFacts} OR EXISTS (SELECT 1 FROM ${prismaRuntime.raw(j.column('SessionTurn'))} a
        WHERE ${prismaRuntime.raw(c('a', 'sessionId'))}=${prismaRuntime.raw(c('s', 'id'))}
        AND ${prismaRuntime.raw(c('a', 'agentId'))} IN (${prismaRuntime.join(input.query.agents)})))` : prismaRuntime.empty;
    const machineFilter = input.query.machines.length ? prismaRuntime.sql`AND (
        ${opaqueFacts}
        OR (${prismaRuntime.raw(j.machineId(metadata, ownerEnvelope, c('s', 'metadataLayoutVersion')))}) IN (${prismaRuntime.join(input.query.machines)}))` : prismaRuntime.empty;
    const filters = prismaRuntime.sql`${agentFilter} ${machineFilter}`;
    const selected: string[] = [];
    // Known bounds retain exact handling in both modes; only unknowns use activity.
    const predicate = prismaRuntime.join([privateDocumentsWindow, turnWindow, messageWindow, createdOrigin, managerReport], ' OR ');
    // The fixed binds are period predicates, not a product subject cap.
    for (const chunk of portableQueryChunks({ values: input.candidateIds, bindingsPerValue: 1,
        fixedBindings: predicate.values.length + filters.values.length })) {
        const rows = await tx.$queryRaw<{ id: string }[]>(prismaRuntime.sql`WITH usage_subjects AS ${prismaRuntime.raw(j.dialect === 'mysql' ? '' : 'MATERIALIZED')} (
            SELECT ${prismaRuntime.raw(['id', 'accountId', 'createdAt', 'updatedAt', 'lastActiveAt', 'originKind', 'encryptionMode', 'metadataLayoutVersion', 'usageTimingV1'].map(j.column).join(', '))},
                ${prismaRuntime.raw(input.query.machines.length ? j.parseText(j.column('metadata')) : j.emptyObject)} AS ${prismaRuntime.raw(j.column('metadata'))},
                ${prismaRuntime.raw(input.query.machines.length || input.query.agents.length ? j.parseText(j.column('ownerMetadata')) : j.emptyObject)} AS ${prismaRuntime.raw(j.column('ownerMetadata'))}
            FROM ${prismaRuntime.raw(j.column('Session'))} WHERE ${prismaRuntime.raw(j.column('id'))} IN (${prismaRuntime.join(chunk)}))
            SELECT ${prismaRuntime.raw(c('s', 'id'))} AS ${prismaRuntime.raw(j.column('id'))}
            FROM usage_subjects s WHERE (${predicate}) ${filters}
            ORDER BY ${prismaRuntime.raw(c('s', 'id'))}`);
        selected.push(...rows.map(row => row.id));
    }
    return selected;
}
