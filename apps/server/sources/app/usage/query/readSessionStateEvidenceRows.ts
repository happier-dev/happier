import { UsageSessionPermissionCompletedProjectionSchema } from '@happier-dev/protocol/usage/usageWorkEvidence';
import type { Tx } from '@/storage/inTx';
import { prismaRuntime } from '@/storage/prisma';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { sessionEvidenceSql } from './sessionEvidenceSql';

export interface UsageStateEvidenceStorageRow {
    id: string;
    known: boolean | number | bigint;
    malformed: boolean | number | bigint;
    sharedRequests: unknown;
    sharedCompleted: unknown;
    privateRequests: unknown;
    privateCompleted: unknown;
    machineId: unknown;
}

/** Only canonical recipient-admitted private state is selected. Arguments stay in storage. */
export async function readSessionStateEvidenceRowsInTx(tx: Tx,
    subjects: readonly Readonly<{ id: string; privateState: boolean }>[]): Promise<UsageStateEvidenceStorageRow[]> {
    if (!subjects.length) return [];
    const j = sessionEvidenceSql();
    const c = (key: string) => 's.' + j.column(key);
    const metadata = c('metadata'), state = c('agentState');
    const confirmations = j.json(metadata, 'actionConfirmationsV1');
    const sharedValid = `CAST(${j.text(confirmations, 'v')} AS ${j.dialect === 'mysql' ? 'CHAR' : 'TEXT'})='1'`;
    const sources = {
        sharedRequests: `CASE WHEN ${sharedValid} THEN ${j.json(confirmations, 'requests')} ELSE NULL END`,
        sharedCompleted: `CASE WHEN ${sharedValid} THEN ${j.json(confirmations, 'completedRequests')} ELSE NULL END`,
        privateRequests: j.json(state, 'requests'), privateCompleted: j.json(state, 'completedRequests'),
    };
    const keys = Object.keys(UsageSessionPermissionCompletedProjectionSchema.shape);
    const projection = (value: string) => {
        const entries = j.objectEntries(value, 'p');
        const valueObject = j.dialect === 'sqlite' ? `CASE WHEN p.type='object' THEN ${entries.value} ELSE ${j.emptyObject} END`
            : j.safeObject(entries.value);
        const record = j.sparseObject(Object.fromEntries(keys.map(key => [key, j.json(valueObject, key)])));
        return `(SELECT ${j.collectObject(entries.key, record)} FROM ${entries.from})`;
    };
    const rows: UsageStateEvidenceStorageRow[] = [];
    for (const chunk of portableQueryChunks({ values: subjects, bindingsPerValue: 2 })) {
        const privateIds = chunk.filter(subject => subject.privateState).map(subject => subject.id);
        const privateRead = privateIds.length ? prismaRuntime.sql`CASE WHEN ${prismaRuntime.raw(j.column('id'))} IN (${prismaRuntime.join(privateIds)})
            THEN ${prismaRuntime.raw(j.parseText(j.column('agentState')))} ELSE ${prismaRuntime.raw(j.emptyObject)} END` : prismaRuntime.raw(j.emptyObject);
        const known = Object.values(sources).map(value => `${j.type(value)}='object'`).join(' OR ');
        const malformed = Object.values(sources).map(value => `(${j.type(value)} IS NOT NULL AND ${j.type(value)} NOT IN ('object','null'))`).join(' OR ');
        rows.push(...await tx.$queryRaw<UsageStateEvidenceStorageRow[]>(prismaRuntime.sql`
            WITH usage_state AS ${prismaRuntime.raw(j.dialect === 'mysql' ? '' : 'MATERIALIZED')} (
                SELECT ${prismaRuntime.raw(j.column('id'))}, ${prismaRuntime.raw(j.column('metadataLayoutVersion'))},
                    ${prismaRuntime.raw(j.parseText(j.column('ownerMetadata')))} AS ${prismaRuntime.raw(j.column('ownerMetadata'))},
                    ${prismaRuntime.raw(j.parseText(j.column('metadata')))} AS ${prismaRuntime.raw(j.column('metadata'))},
                    ${privateRead} AS ${prismaRuntime.raw(j.column('agentState'))}
                FROM ${prismaRuntime.raw(j.column('Session'))} WHERE ${prismaRuntime.raw(j.column('id'))} IN (${prismaRuntime.join(chunk.map(subject => subject.id))}))
            SELECT ${prismaRuntime.raw(c('id'))}, ${prismaRuntime.raw(j.machineId(metadata, c('ownerMetadata'), c('metadataLayoutVersion')))} AS ${prismaRuntime.raw(j.column('machineId'))},
                CASE WHEN ${prismaRuntime.raw(known)} THEN 1 ELSE 0 END AS ${prismaRuntime.raw(j.column('known'))},
                CASE WHEN ${prismaRuntime.raw(malformed)} THEN 1 ELSE 0 END AS ${prismaRuntime.raw(j.column('malformed'))},
                ${prismaRuntime.raw(Object.entries(sources).map(([name, value]) => projection(value) + ' AS ' + j.column(name)).join(', '))}
            FROM usage_state s`));
    }
    return rows;
}
