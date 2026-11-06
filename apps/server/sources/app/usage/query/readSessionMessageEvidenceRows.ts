import type { Tx } from '@/storage/inTx';
import { prismaRuntime } from '@/storage/prisma';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { sessionEvidenceSql } from './sessionEvidenceSql';

export interface UsageMessageEvidenceStorageRow {
    id: string;
    sessionId: string;
    localId: string | null;
    createdAt: Date | number | bigint;
    sidechainIds: unknown;
    role: unknown;
    recordType: unknown;
    nativeAgentId: unknown;
    eventId: unknown;
    event: unknown;
    tools: unknown;
    acceptedDelivery: unknown;
    envelopeType: unknown;
}

/** Projection SQL contains schema identifiers only. All requested ids and ceilings remain bound. */
export async function readSessionMessageEvidenceRowsInTx(tx: Tx,
    sessions: readonly Readonly<{ id: string; maximumSeq: number | null }>[],
    collaborationLeafKeys: readonly string[]): Promise<UsageMessageEvidenceStorageRow[]> {
    if (!sessions.length) return [];
    const s = sessionEvidenceSql();
    const content = s.nativeJson('m.' + s.column('content'));
    const raw = s.json(content, 'v', 'content');
    const data = s.json(raw, 'data');
    const recordType = s.text(raw, 'type');
    const nativeType = s.text(data, 'type');
    const payload = (value: string) => {
        const opened = s.parseObject(value);
        return s.object(Object.fromEntries(collaborationLeafKeys.map(key => [key, s.embed(s.json(opened, key))])));
    };
    const call = (id: string, name: string, input: string) => s.object({ kind: s.literal('call'), id, name, input: s.embed(payload(input)) });
    const result = (id: string, output: string) => s.object({ kind: s.literal('result'), id, name: "''", result: s.embed(payload(output)) });
    const block = 'b.value';
    const blockType = s.text(block, 'type');
    const tools = `(SELECT ${s.collect('tool.value')} FROM (
        SELECT ${call(s.text(data, 'callId'), s.text(data, 'name'), s.json(data, 'input'))} AS value
        WHERE ${recordType} IN ('codex','acp') AND ${nativeType}='tool-call'
        UNION ALL SELECT ${result(s.text(data, 'callId'), s.json(data, 'output'))}
        WHERE ${recordType} IN ('codex','acp') AND ${nativeType} IN ('tool-result','tool-call-result')
        UNION ALL SELECT CASE WHEN ${blockType} IN ('tool_use','tool-call')
            THEN ${call(`COALESCE(${s.text(block, 'id')},${s.text(block, 'callId')})`, s.text(block, 'name'), s.json(block, 'input'))}
            ELSE ${result(`COALESCE(${s.text(block, 'tool_use_id')},${s.text(block, 'callId')})`,
                `COALESCE(${s.json(block, 'output')},${s.json(block, 'content')})`)} END
        FROM ${s.members(s.json(data, 'message', 'content'), 'array', 'b')}
        WHERE ${recordType}='output' AND ${nativeType} IN ('assistant','user')
            AND ${blockType} IN ('tool_use','tool-call','tool_result','tool-call-result')
    ) tool)`;
    const event = `CASE WHEN ${recordType}='event' THEN ${data}
        WHEN ${recordType}='acp' AND ${nativeType}='event' THEN ${s.json(data, 'data')} ELSE NULL END`;
    const eventType = s.text(event, 'type');
    const projectedEvent = `CASE WHEN ${eventType} IN ('prompt-composition','mcp-binding-usage') THEN ${event}
        WHEN ${eventType}='context-compaction' THEN (${s.sparseObject(Object.fromEntries([
            'type', 'phase', 'source', 'lifecycleId', 'agentEventId', 'turnId',
        ].map(key => [key, s.json(event, key)])))}) ELSE NULL END`;
    const delivery = s.nativeJson('m.' + s.column('deliveryResolution'));
    const accepted = `CASE WHEN ${s.text(delivery, 'kind')}='provider_accepted'
        AND ${s.text(delivery, 'content', 't')}='plain' THEN ${s.json(delivery, 'content', 'v')} ELSE NULL END`;
    const rows: UsageMessageEvidenceStorageRow[] = [];
    for (const chunk of portableQueryChunks({ values: sessions, bindingsPerValue: 2 })) {
        const subjects = prismaRuntime.join(chunk.map(session => prismaRuntime.sql`(${prismaRuntime.raw('m.' + s.column('sessionId'))}=${session.id}
            ${session.maximumSeq === null ? prismaRuntime.empty : prismaRuntime.sql`AND ${prismaRuntime.raw('m.' + s.column('seq'))}<=${session.maximumSeq}`})`), ' OR ');
        rows.push(...await tx.$queryRaw<UsageMessageEvidenceStorageRow[]>(prismaRuntime.sql`
            SELECT ${prismaRuntime.raw(['id', 'sessionId', 'localId', 'createdAt'].map(key => `m.${s.column(key)}`).join(', '))},
            ${prismaRuntime.raw(`(SELECT ${s.collect('sc.value')} FROM (
                SELECT ${s.json(data, 'sidechainId')} AS value WHERE ${s.type(s.json(data, 'sidechainId'))}='string'
                UNION ALL SELECT ${s.json(data, 'parent_tool_use_id')} WHERE ${recordType}='output'
                    AND ${s.type(s.json(data, 'parent_tool_use_id'))}='string') sc)`)} AS ${prismaRuntime.raw(s.column('sidechainIds'))},
            ${prismaRuntime.raw(s.text(content, 't'))} AS ${prismaRuntime.raw(s.column('envelopeType'))},
            ${prismaRuntime.raw(s.text(content, 'v', 'role'))} AS ${prismaRuntime.raw(s.column('role'))},
            ${prismaRuntime.raw(recordType)} AS ${prismaRuntime.raw(s.column('recordType'))},
            ${prismaRuntime.raw(`CASE WHEN ${recordType}='output' THEN 'claude' WHEN ${recordType}='codex' THEN 'codex'
                WHEN ${recordType}='acp' THEN ${s.text(raw, 'agentId')} ELSE NULL END`)} AS ${prismaRuntime.raw(s.column('nativeAgentId'))},
            ${prismaRuntime.raw(`CASE WHEN ${recordType}='event' THEN ${s.text(raw, 'id')} ELSE NULL END`)} AS ${prismaRuntime.raw(s.column('eventId'))},
            ${prismaRuntime.raw(projectedEvent)} AS ${prismaRuntime.raw(s.column('event'))},
            ${prismaRuntime.raw(tools)} AS ${prismaRuntime.raw(s.column('tools'))},
            ${prismaRuntime.raw(accepted)} AS ${prismaRuntime.raw(s.column('acceptedDelivery'))}
            FROM ${prismaRuntime.raw(s.column('SessionMessage'))} m WHERE ${subjects}
            ORDER BY ${prismaRuntime.raw('m.' + s.column('sessionId'))}, ${prismaRuntime.raw('m.' + s.column('seq'))} DESC`));
    }
    return rows;
}
