import { computeCanonicalDomainSeparatedDigest, createCanonicalJsonSigningInput, PluginError,
    type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { DATABASE_INSIGHTS_FINDINGS_LIST_ACTION_ID_V1 } from '@happier-dev/database-protocol';
import {
    type DatabaseFindingObservationV1,
    type DatabaseFindingV1,
    type DatabaseFindingsListInputV1,
    type DatabaseOperationResultV1,
    type DatabaseStatsObservationV1,
} from '@happier-dev/plugin-sdk/database';
import { databaseActionLocalIdV1 } from '@happier-dev/database-protocol';
import type { DatabaseActionProducers } from '../actions.js';
import { buildDatabaseFindingBriefV1 } from './brief.js';
import { selectDatabaseStatement } from './presentation.js';

type AvailableStats = Extract<DatabaseStatsObservationV1, { status: 'available' }>;
type Summary = DatabaseFindingObservationV1['summary'];
type FindingRow = Readonly<{ recordKey: string; summary: Summary;
    object?: DatabaseFindingV1['object'];
    normalizedShape?: string; omittedTextReason?: string; activity?: DatabaseFindingV1['activity'] }>;
type StatsResult = Extract<DatabaseOperationResultV1, { operation: 'stats.read' }> | Extract<DatabaseOperationResultV1, { ok: false }>;

/** Keys identify native rows within their resolved binding, without retaining
 * an independent finding record. */
function rowsFor(stats: AvailableStats): FindingRow[] {
    const key = (identity: string) => computeCanonicalDomainSeparatedDigest('happier.database.finding-row.v1', [
        stats.intervalBasis.bindingKey, stats.group, identity,
    ]);
    switch (stats.group) {
        case 'statements': return stats.data.map(row => ({ recordKey: row.key,
            summary: { records: 1, calls: row.calls, totalTimeMs: row.totalTimeMs, rows: row.rows },
            ...(row.shape === undefined ? {} : { normalizedShape: row.shape }),
            ...(row.omittedTextReason === undefined ? {} : { omittedTextReason: row.omittedTextReason }),
        }));
        case 'tables': return stats.data.map(row => ({ recordKey: key(createCanonicalJsonSigningInput(row.relation)),
            object: { kind: 'table', relation: row.relation },
            summary: { records: 1,
                ...(row.size === undefined ? {} : { size: { bytes: row.size.bytes } }),
                maintenance: {
                    ...(row.estimatedRows === undefined ? {} : { estimatedRows: row.estimatedRows }),
                    ...(row.liveRows === undefined ? {} : { liveRows: row.liveRows }),
                    ...(row.deadRows === undefined ? {} : { deadRows: row.deadRows }),
                    ...(row.sequentialScans === undefined ? {} : { sequentialScans: row.sequentialScans }),
                    ...(row.indexScans === undefined ? {} : { indexScans: row.indexScans }),
                    ...(row.rowsRead === undefined ? {} : { rowsRead: row.rowsRead }),
                    ...(row.inserted === undefined ? {} : { inserted: row.inserted }),
                    ...(row.updated === undefined ? {} : { updated: row.updated }),
                    ...(row.deleted === undefined ? {} : { deleted: row.deleted }),
                },
            },
        }));
        case 'indexes': return stats.data.map(row => ({
            recordKey: key(createCanonicalJsonSigningInput({ relation: row.relation, name: row.name })),
            object: { kind: 'index', relation: row.relation, name: row.name },
            summary: { records: 1, index: {
                ...(row.scans === undefined ? {} : { scans: row.scans }),
                ...(row.tuplesRead === undefined ? {} : { tuplesRead: row.tuplesRead }),
                ...(row.tuplesFetched === undefined ? {} : { tuplesFetched: row.tuplesFetched }),
                ...(row.bytes === undefined ? {} : { bytes: row.bytes }),
            } },
        }));
        case 'activity': return stats.data.map(row => ({ recordKey: row.key,
            summary: { records: 1, blocking: { blockers: row.blockingKeys.length } },
            ...(row.shape === undefined ? {} : { normalizedShape: row.shape }),
            ...(row.omittedTextReason === undefined ? {} : { omittedTextReason: row.omittedTextReason }),
            activity: {
                ...(row.waitClass === undefined ? {} : { waitClass: row.waitClass }),
                ...(row.waitEvent === undefined ? {} : { waitEvent: row.waitEvent }),
                ...(row.transactionStartedAt === undefined ? {} : { transactionStartedAt: row.transactionStartedAt }),
                ...(row.queryStartedAt === undefined ? {} : { queryStartedAt: row.queryStartedAt }),
                blockingKeys: row.blockingKeys,
            },
        }));
        case 'size': return [{ recordKey: key(createCanonicalJsonSigningInput(stats.scope)),
            summary: { records: 1, size: { bytes: stats.data.bytes } } }];
    }
}

/** Only project totals whose value is known for every displayed row. Native
 * counters remain decimal strings, including values above Number's precision. */
function sumCounters(rows: readonly Readonly<Record<string, string | undefined>>[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (const field of Object.keys(rows[0] ?? {})) {
        let total = 0n;
        let complete = true;
        for (const row of rows) {
            const value = row[field];
            if (value === undefined) { complete = false; break; }
            total += BigInt(value);
        }
        if (complete) result[field] = total.toString();
    }
    return result;
}

function summaryFor(stats: AvailableStats, rows: readonly FindingRow[]): Summary {
    const summary: Summary = { records: rows.length };
    switch (stats.group) {
        case 'statements': return { ...summary,
            ...sumCounters(stats.data.map(row => ({ calls: row.calls, rows: row.rows }))),
            totalTimeMs: stats.data.reduce((total, row) => total + row.totalTimeMs, 0),
        };
        case 'tables': return { ...summary,
            maintenance: sumCounters(rows.map(row => row.summary.maintenance ?? {})),
            ...(rows.every(row => row.summary.size !== undefined) && rows.length > 0
                ? { size: { bytes: rows.flatMap(row => row.summary.size ? [row.summary.size] : [])
                    .reduce((total, size) => total + BigInt(size.bytes), 0n).toString() } } : {}),
        };
        case 'indexes': return { ...summary, index: sumCounters(rows.map(row => row.summary.index ?? {})) };
        case 'activity': return { ...summary, blocking: {
            blockers: stats.data.reduce((total, row) => total + row.blockingKeys.length, 0),
        } };
        case 'size': return { ...summary, size: { bytes: stats.data.bytes } };
    }
}

/** The native stats completion and finding Actions share this content-free projection. */
export function projectDatabaseFindingObservation(stats: AvailableStats, target: DatabaseFindingsListInputV1['target'],
    context: PluginInvocationContext, rows: readonly FindingRow[] = rowsFor(stats)): DatabaseFindingObservationV1 {
    const machine = context.chosenMachine;
    if (!machine || !context.invocationId) throw new PluginError({ code: 'plugin_service_unavailable',
        message: 'Completed database findings require native Action identity.' });
    // The successful target resolver has already bound the exact routed
    // Home. The Machine itself is stamped by native Action admission.
    const serverId = target.kind === 'worktree' || target.kind === 'manual'
        ? target.workspace.serverId : target.environment.serverId;
    return {
        v: 1, sourceRef: { pluginId: context.plugin.id,
            localId: databaseActionLocalIdV1(DATABASE_INSIGHTS_FINDINGS_LIST_ACTION_ID_V1) },
        sourceScope: { serverId, machineId: machine.machineId },
        evidenceIdentity: computeCanonicalDomainSeparatedDigest('happier.database.completed-finding-read.v1', [
            context.invocationId, String(stats.observedAtMs), createCanonicalJsonSigningInput(stats.intervalBasis),
        ]),
        kind: stats.group, observedWindow: { fromMs: stats.observedAtMs, toMs: stats.observedAtMs },
        coverage: stats.coverage,
        summary: summaryFor(stats, rows),
    };
}

/** Native stats owns connection custody, demand reuse, SQL and sanitization.
 * This producer only projects completed evidence and rereads selected keys. */
export function createDatabaseInsightProducers(options: Readonly<{
    executeOperation: NonNullable<DatabaseActionProducers['executeOperation']>;
}>): Required<Pick<DatabaseActionProducers, 'listFindings' | 'readFinding' | 'buildInsightBrief'>> {
    async function read(input: DatabaseFindingsListInputV1, context: PluginInvocationContext) {
        // The existing operation owner pairs this operand with its stats result;
        // its broader union does not express the input/output correspondence.
        const result = await options.executeOperation({ operation: 'stats.read', target: input.target,
            request: input.request, ...(input.subscriptionId === undefined ? {} : { subscriptionId: input.subscriptionId }) }, context) as StatsResult;
        if (!result.ok) return result;
        const stats = result.observation;
        if (stats.status === 'unavailable') return { ok: false as const, status: 'unavailable' as const,
            code: 'database_stats_unavailable', reason: stats.reason };
        const rows = rowsFor(stats);
        const observation = projectDatabaseFindingObservation(stats, input.target, context, rows);
        return { ok: true as const, observation, rows, stats };
    }
    const readFinding: NonNullable<DatabaseActionProducers['readFinding']> = async (input, context) => {
        const request = input.request.group === 'statements'
            ? selectDatabaseStatement(input.request, input.recordKey)
            : input.request.group === 'activity'
                ? { ...input.request, selection: { ...input.request.selection,
                    page: { ...input.request.selection.page, offset: 0 }, activityKey: input.recordKey } }
                : input.request;
        const result = await read({ ...input, request }, context);
        if (!result.ok) return result;
        const row = result.rows.find(candidate => candidate.recordKey === input.recordKey);
        if (!row) return { ok: false, status: 'unavailable', code: 'database_finding_expired', reason: 'row_evicted' };
        const { recordKey: _recordKey, ...detail } = row;
        return { ok: true, finding: { ...result.observation, ...detail, target: input.target,
            verification: { read: request, basis: result.stats.intervalBasis } } };
    };
    return {
        async listFindings(input, context) {
            const result = await read(input, context);
            if (!result.ok) return result;
            return { ok: true, observation: result.observation,
                findings: result.rows.map(({ recordKey, summary, object }) => ({ recordKey, summary,
                    ...(object === undefined ? {} : { object }) })) };
        },
        readFinding,
        async buildInsightBrief(input, context) {
            if ('task' in input) return { ok: true, brief: buildDatabaseFindingBriefV1(input.task) };
            const result = await readFinding(input, context);
            if (!result.ok) return result;
            return { ok: true, brief: buildDatabaseFindingBriefV1(result.finding, input.baseline) };
        },
    };
}
