import { createHash } from 'node:crypto';
import { restoreUsageMoneyProvenance, serializeUsageMoneyProvenance, type SerializedUsageMoneyProvenance } from '@happier-dev/protocol/usage/usageMoney';
import type { UsageAnalyticsContribution } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { prepareScopedUsageReplayContext, type ResolvedScopedUsageContributions, type ScopedUsageContribution,
    type ScopedUsageEventRow, type ScopedUsageReplayContext, type ScopedUsageReplayFact } from './resolveScopedUsageContributions';
import { foldScopedUsageContributions } from './scopedUsageContributionFold';
import { projectScopedUsageContribution } from './buildUsageResultProjection';

interface StoredUsageActivityContribution {
    value: UsageAnalyticsContribution;
    createdAtMs: number;
    scope: string;
    isCumulative: boolean;
    contributingEventIds: readonly string[];
    coverageReasons: ScopedUsageContribution['coverageReasons'];
    rankEventId: string;
    tokensProvenance?: SerializedUsageMoneyProvenance;
    categoriesProvenance?: SerializedUsageMoneyProvenance;
    costProvenance?: SerializedUsageMoneyProvenance;
    breakdownProvenance?: SerializedUsageMoneyProvenance;
}

/** Internal read-owned checkpoint; raw producer fingerprints decide input currentness. */
export interface UsageActivitySubjectReplayEntry {
    witness: string;
    contributions: StoredUsageActivityContribution[];
    coverageReasons: ResolvedScopedUsageContributions['coverageReasons'];
}

export interface UsageActivitySubjectReplayStats {
    subjectCount: number;
    replayedSubjects: number;
    replayedEvents: number;
}

export interface UsageActivitySubjectReplaySubjectPlan {
    subjectKey: string;
    eventIds: readonly string[];
    witness: string;
    needsReplay: boolean;
}

export interface UsageActivitySubjectReplayPlan {
    replayContext: ScopedUsageReplayContext;
    subjects: UsageActivitySubjectReplaySubjectPlan[];
}

export interface UsageActivitySubjectReplayResult extends ResolvedScopedUsageContributions {
    preparedContributions: UsageAnalyticsContribution[];
}

export interface UsageActivitySubjectReplay {
    entries: Map<string, UsageActivitySubjectReplayEntry>;
    stats: UsageActivitySubjectReplayStats;
    plan(facts: readonly ScopedUsageReplayFact[], range?: Readonly<{ startMs?: number; endMs?: number }>): UsageActivitySubjectReplayPlan;
    resolvePlanned(subject: UsageActivitySubjectReplaySubjectPlan, rows: readonly ScopedUsageEventRow[] | undefined,
        ranks: Map<string, number>): UsageActivitySubjectReplayResult;
    resolve(subjectKey: string, rows: readonly ScopedUsageEventRow[], ranks: Map<string, number>): UsageActivitySubjectReplayResult;
}

function moneyProvenance(value: object): SerializedUsageMoneyProvenance | undefined {
    const provenance = serializeUsageMoneyProvenance(value);
    return Object.keys(provenance).length > 0 ? provenance : undefined;
}

function storeContribution(
    row: ScopedUsageContribution,
    ranks: ReadonlyMap<string, number>,
    sourceByRank: ReadonlyMap<number | undefined, ScopedUsageEventRow>,
): StoredUsageActivityContribution {
    const source = sourceByRank.get(ranks.get(row.id));
    if (source === undefined) throw new Error('Usage activity contribution is missing its source rank');
    const value = projectScopedUsageContribution(row);
    return {
        value,
        createdAtMs: row.createdAt.getTime(), scope: row.scope, isCumulative: row.isCumulative,
        contributingEventIds: row.contributingEventIds, coverageReasons: row.coverageReasons,
        rankEventId: source.id,
        tokensProvenance: moneyProvenance(value.tokens),
        categoriesProvenance: value.tokenCategories ? moneyProvenance(value.tokenCategories) : undefined,
        costProvenance: moneyProvenance(value.cost),
        breakdownProvenance: value.cost.breakdown ? moneyProvenance(value.cost.breakdown) : undefined,
    };
}

function restoreContribution(stored: StoredUsageActivityContribution, ranks: Map<string, number>) {
    const sourceRank = ranks.get(stored.rankEventId);
    if (sourceRank === undefined) throw new Error('Usage activity checkpoint is missing its source rank');
    const value: UsageAnalyticsContribution = { ...stored.value,
        tokens: stored.tokensProvenance ? restoreUsageMoneyProvenance({ ...stored.value.tokens }, stored.tokensProvenance) : stored.value.tokens,
        ...(stored.value.tokenCategories && stored.categoriesProvenance
            ? { tokenCategories: restoreUsageMoneyProvenance({ ...stored.value.tokenCategories }, stored.categoriesProvenance) } : {}),
        cost: stored.costProvenance || stored.breakdownProvenance
            ? restoreUsageMoneyProvenance({ ...stored.value.cost,
                ...(stored.value.cost.breakdown && stored.breakdownProvenance
                    ? { breakdown: restoreUsageMoneyProvenance({ ...stored.value.cost.breakdown }, stored.breakdownProvenance) } : {}) },
            stored.costProvenance ?? {}) : stored.value.cost,
    };
    const row: ScopedUsageContribution = {
        id: value.id, sessionId: value.sessionId, observedAt: new Date(value.observedAtMs), createdAt: new Date(stored.createdAtMs),
        agentId: value.agentId, backendMode: value.backendMode ?? null, modelId: value.modelId,
        projectKey: value.projectKey, workspaceId: value.workspaceId, machineId: value.machineId,
        source: value.source, scope: stored.scope, isCumulative: stored.isCumulative, turnId: value.turnId,
        contextUsedTokens: value.context?.usedTokens ?? null, contextWindowTokens: value.context?.windowTokens ?? null,
        tokens: value.tokens, cost: value.cost, contributingEventIds: stored.contributingEventIds, coverageReasons: stored.coverageReasons,
    };
    ranks.set(row.id, sourceRank);
    return { row, value };
}

/** Subject folds remain canonical; the caller owns source fingerprints and upstream eligibility. */
export function createUsageActivitySubjectReplay(input: {
    sourceFingerprints: ReadonlyMap<string, string>;
    retained?: ReadonlyMap<string, UsageActivitySubjectReplayEntry>;
}): UsageActivitySubjectReplay {
    const entries = new Map<string, UsageActivitySubjectReplayEntry>();
    const stats: UsageActivitySubjectReplayStats = { subjectCount: 0, replayedSubjects: 0, replayedEvents: 0 };
    const subjectPlan = (subjectKey: string, eventIds: readonly string[]): UsageActivitySubjectReplaySubjectPlan => {
        const witness = createHash('sha256').update(JSON.stringify(eventIds.map(id => {
            const fingerprint = input.sourceFingerprints.get(id);
            if (fingerprint === undefined) throw new Error('Usage activity input is missing its source fingerprint');
            return [id, fingerprint];
        }))).digest('hex');
        return { subjectKey, eventIds, witness, needsReplay: input.retained?.get(subjectKey)?.witness !== witness };
    };
    const resolvePlanned: UsageActivitySubjectReplay['resolvePlanned'] = (subject, rows, ranks) => {
        stats.subjectCount++;
        const retained = input.retained?.get(subject.subjectKey);
        if (retained?.witness === subject.witness) {
            const restored = retained.contributions.map(row => restoreContribution(row, ranks));
            const contributions = restored.map(value => value.row);
            entries.set(subject.subjectKey, retained);
            return { totalContributions: contributions, bucketAttributions: contributions,
                coverageReasons: [...retained.coverageReasons], preparedContributions: restored.map(value => value.value) };
        }
        if (!rows) throw new Error('Usage activity subject replay requires its captured source rows');
        stats.replayedSubjects++;
        stats.replayedEvents += rows.length;
        const sourceByRank = new Map(rows.map(row => [ranks.get(row.id), row]));
        const result = foldScopedUsageContributions(rows, ranks);
        const contributions = result.totalContributions.map(row => storeContribution(row, ranks, sourceByRank));
        entries.set(subject.subjectKey, { witness: subject.witness, contributions, coverageReasons: result.coverageReasons });
        return { ...result, preparedContributions: contributions.map(row => row.value) };
    };
    return { entries, stats, resolvePlanned,
        plan(facts, range) {
            const replayContext = prepareScopedUsageReplayContext(facts, range);
            const groups = new Map<string, string[]>();
            for (const fact of facts) if (replayContext.selectedEventIds.has(fact.id)) {
                const ids = groups.get(fact.subjectKey) ?? [];
                ids.push(fact.id);
                groups.set(fact.subjectKey, ids);
            }
            const subjects = [...groups].map(([key, ids]) => subjectPlan(key,
                ids.sort((left, right) => replayContext.ranks.get(left)! - replayContext.ranks.get(right)! || left.localeCompare(right))));
            return { replayContext, subjects };
        },
        resolve(subjectKey, rows, ranks) {
            const ordered = [...rows].sort((left, right) => ranks.get(left.id)! - ranks.get(right.id)! || left.id.localeCompare(right.id));
            return resolvePlanned(subjectPlan(subjectKey, ordered.map(row => row.id)), rows, ranks);
        } };
}
