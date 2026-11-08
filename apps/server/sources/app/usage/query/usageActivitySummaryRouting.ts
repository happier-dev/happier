import { createHash } from 'node:crypto';
import type { UsageAnalyticsQueryRequest } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { resolveUsageBucketBounds } from '@happier-dev/protocol/usage/usageCalendar';
import type { Tx } from '@/storage/inTx';
import type { UsageAnalyticsSnapshot } from '../usageQueryService';
import { loadRetainedLegacyUsageReports, loadUsageEventsForQuery, type UsageQueryEvent } from './loadUsageEventsForQuery';
import { toScopedUsageEvidenceRow } from './scopedUsageEventRow';
import { isScopedUsageReplayFactEligible, orderRuntimeObservations, toScopedUsageReplayFact,
    updateScopedUsageReplaySessionEligibility, type ScopedUsageEventRow, type ScopedUsageReplayFact,
    type ScopedUsageReplaySessionEligibility } from './resolveScopedUsageContributions';
import { resolveUsageLegacyReportRows, toUsageLegacyBridgeFacts, type UsageLegacyBridgeFact } from './projectUsageAnalyticsPopulation';
import { projectUsageCoverageEvidence, type UsageCoverageEvidence } from './projectUsageCoverageEvidence';
import { readUsageActivitySummaryChunks, type UsageActivitySourceChange } from './usageActivitySummaryStore';

export const usageActivityUtcDay = (time: number): number => Math.floor(time / 86_400_000) * 86_400_000;
export const usageActivityFingerprint = (value: string): string => createHash('sha256').update(value).digest('hex');
export const usageActivityRoutingKey = (day: number): string => `routing:${day}`;
export const usageActivitySubjectKey = (key: string): string => `subject:${key}`;
export const usageActivityProjectionDayKey = (day: number): string => `day:${day}`;
const sessionKey = (key: string | null): string => `session:${JSON.stringify(key)}`;

interface SourceRoute {
    fact: ScopedUsageReplayFact;
    fingerprint: string;
    eligible: boolean;
    bridge?: UsageLegacyBridgeFact;
    coverage?: UsageCoverageEvidence;
}

interface SessionRoute {
    eligibility: ScopedUsageReplaySessionEligibility;
    bridges: Array<{ id: string; value: UsageLegacyBridgeFact }>;
}

export interface UsageActivitySubjectRoute {
    sources: Array<{ id: string; dayStartMs: number; report?: true }>;
    projectionDays: number[];
    projectionWitnesses: Array<[number, string]>;
    selected: boolean;
}

export interface UsageActivityRoutingHead {
    sourceDays: number[];
    subjectKeys: string[];
    sessionKeys: Array<string | null>;
    sourceCoverage: Array<[number, UsageCoverageEvidence]>;
    reportSources: SourceRoute[];
    legacyReports: UsageAnalyticsSnapshot['legacyReports'];
    subjectCount: number;
    projectionDays: number[];
}

export interface UsageActivityDirtySubject {
    subjectKey: string;
    previous?: UsageActivitySubjectRoute;
    current: UsageActivitySubjectRoute;
    eventIds: string[];
}

export interface UsageActivityRoutingCapture {
    head?: UsageActivityRoutingHead;
    sourceDays: Set<number>;
    subjectKeys: Set<string>;
    sessionKeys: Set<string | null>;
    sourceCoverage: Map<number, UsageCoverageEvidence>;
    reportSources: SourceRoute[];
    legacyReports: UsageAnalyticsSnapshot['legacyReports'];
    dirtySubjects: UsageActivityDirtySubject[];
    ranks: Map<string, number>;
    sourceFingerprints: Map<string, string>;
    rows: UsageAnalyticsSnapshot['rows'];
    reportRows: Map<string, ScopedUsageEventRow>;
    chunks: Map<string, string | null>;
    subjectCount: number;
    discoveryEventsRead: number;
    historyEventsRead: number;
    projectionDays: number[];
    orderChangedProjectionDays: number[];
    operandChunks: Map<number, string>;
}

/** A missing referenced reconstructible chunk restarts capture from canonical source. */
export class MissingUsageActivityRoutingChunk extends Error {}

function makeRoutes(rows: readonly UsageQueryEvent[]) {
    const admitted = rows.map(toScopedUsageEvidenceRow);
    return { admitted, routes: admitted.map((row, index): SourceRoute => {
        const bridge = toUsageLegacyBridgeFacts([row])[0];
        return { fact: toScopedUsageReplayFact(row), fingerprint: usageActivityFingerprint(JSON.stringify(rows[index])),
            eligible: true, ...(bridge ? { bridge } : {}) };
    }), coverage: projectUsageCoverageEvidence(admitted) };
}

function orderedInputs(routes: readonly SourceRoute[], query: UsageAnalyticsQueryRequest) {
    const byId = new Map(routes.map(route => [route.fact.id, route]));
    const groups = new Map<string, Array<[string, string]>>();
    const projectionOrder = new Map<number, string[]>();
    const start = query.dateRange?.startMs ?? -Infinity;
    const end = query.dateRange?.endMs ?? Infinity;
    for (const fact of orderRuntimeObservations(routes.filter(route => route.eligible).map(route => route.fact))) {
        const group = groups.get(fact.subjectKey) ?? [];
        group.push([fact.id, byId.get(fact.id)!.fingerprint]);
        groups.set(fact.subjectKey, group);
        if (fact.observedAtMs >= start && fact.observedAtMs < end) {
            const day = resolveUsageBucketBounds('day', fact.observedAtMs, query.timeZoneOffsetMinutes).bucketStartMs;
            const ids = projectionOrder.get(day) ?? [];
            ids.push(fact.id);
            projectionOrder.set(day, ids);
        }
    }
    return { subjects: new Map([...groups].map(([key, values]) => [key, JSON.stringify(values)])), projectionOrder };
}

/** Only changed UTC-day routes, affected Sessions and whole dirty subjects cross chunk admission. */
export async function captureUsageActivityRoutingInTx(tx: Tx, accountId: string, query: UsageAnalyticsQueryRequest,
    changes: readonly UsageActivitySourceChange[], head?: UsageActivityRoutingHead): Promise<UsageActivityRoutingCapture> {
    const sourceDays = new Set(head?.sourceDays);
    const subjectKeys = new Set(head?.subjectKeys);
    const sessionKeys = new Set(head?.sessionKeys);
    const sourceCoverage = new Map(head?.sourceCoverage);
    const routes = new Map<number, SourceRoute[]>();
    const previousRoutes = new Map<number, SourceRoute[]>();
    const sessions = new Map<string | null, SessionRoute>();
    const subjects = new Map<string, UsageActivitySubjectRoute>();
    const chunks = new Map<string, string | null>();
    const changedDays = new Set(head ? changes.filter(change => change.kind === 'event').map(change => change.dayStartMs) : []);
    const loadRoutes = async (days: readonly number[]) => {
        const needed = [...new Set(days)].filter(day => !routes.has(day));
        if (needed.length === 0) return;
        const present = needed.filter(day => sourceDays.has(day));
        const loaded = await readUsageActivitySummaryChunks(tx, accountId, present.map(usageActivityRoutingKey));
        for (const day of needed) {
            const raw = loaded.get(usageActivityRoutingKey(day));
            if (sourceDays.has(day) && raw === undefined) throw new MissingUsageActivityRoutingChunk();
            const values: SourceRoute[] = raw === undefined ? [] : JSON.parse(raw);
            routes.set(day, values);
            previousRoutes.set(day, values);
        }
    };
    if (head) await loadRoutes([...changedDays]);
    const loaded = await loadUsageEventsForQuery(tx, accountId, query, undefined,
        head ? changes.filter(change => change.kind === 'event' && change.fingerprint !== null).map(change => change.dayStartMs) : undefined);
    const loadedByDay = new Map<number, UsageQueryEvent[]>();
    for (const row of loaded) {
        const day = usageActivityUtcDay(row.observedAt.getTime());
        const group = loadedByDay.get(day) ?? [];
        group.push(row);
        loadedByDay.set(day, group);
    }
    if (!head) for (const day of loadedByDay.keys()) changedDays.add(day);
    const loadedById = new Map(loaded.map(row => [row.id, row]));
    const removed: SourceRoute[] = [];
    const added: SourceRoute[] = [];
    for (const day of changedDays) {
        const old = routes.get(day) ?? [];
        previousRoutes.set(day, old);
        const { admitted, routes: next, coverage } = makeRoutes(loadedByDay.get(day) ?? []);
        for (const row of admitted) loadedById.set(row.id, row);
        const oldById = new Map(old.map(route => [route.fact.id, route]));
        const nextById = new Map(next.map(route => [route.fact.id, route]));
        for (const route of old) if (nextById.get(route.fact.id)?.fingerprint !== route.fingerprint) removed.push(route);
        for (const route of next) {
            const before = oldById.get(route.fact.id);
            if (before?.fingerprint === route.fingerprint) route.eligible = before.eligible;
            else added.push(route);
        }
        routes.set(day, next);
        if (next.length > 0) { sourceDays.add(day); sourceCoverage.set(day, coverage); }
        else { sourceDays.delete(day); sourceCoverage.delete(day); }
    }
    const legacyReports = !head || changes.some(change => change.kind === 'report')
        ? await loadRetainedLegacyUsageReports(tx, accountId, query) : head.legacyReports;
    const affectedSessions = new Set([...removed, ...added].map(route => route.fact.sessionId));
    if (!head || changes.some(change => change.kind === 'report')) {
        for (const report of [...(head?.legacyReports ?? []), ...legacyReports]) affectedSessions.add(report.sessionId);
    }
    const sessionNames = [...affectedSessions];
    const sessionChunks = head ? await readUsageActivitySummaryChunks(tx, accountId,
        sessionNames.filter(key => sessionKeys.has(key)).map(sessionKey)) : new Map<string, string>();
    const legacyDays = new Set<number>();
    const groupBySession = (values: readonly SourceRoute[]) => {
        const result = new Map<string | null, SourceRoute[]>();
        for (const route of values) {
            const group = result.get(route.fact.sessionId) ?? [];
            group.push(route);
            result.set(route.fact.sessionId, group);
        }
        return result;
    };
    const removedBySession = groupBySession(removed);
    const addedBySession = groupBySession(added);
    for (const key of sessionNames) {
        const raw = sessionChunks.get(sessionKey(key));
        if (head && sessionKeys.has(key) && raw === undefined) throw new MissingUsageActivityRoutingChunk();
        const old: SessionRoute | undefined = raw === undefined ? undefined : JSON.parse(raw);
        const oldRows = removedBySession.get(key) ?? [];
        const newRows = addedBySession.get(key) ?? [];
        const eligibility = updateScopedUsageReplaySessionEligibility(old?.eligibility,
            oldRows.map(route => route.fact), newRows.map(route => route.fact));
        const bridges = new Map(old?.bridges.map(bridge => [bridge.id, bridge.value]));
        for (const route of oldRows) bridges.delete(route.fact.id);
        for (const route of newRows) if (route.bridge) bridges.set(route.fact.id, route.bridge);
        const next = { eligibility, bridges: [...bridges].map(([id, value]) => ({ id, value })) };
        sessions.set(key, next);
        sessionKeys.add(key);
        chunks.set(sessionKey(key), JSON.stringify(next));
        if ((old?.eligibility.nonLegacyCount ?? 0) === 0 !== (eligibility.nonLegacyCount === 0)) {
            for (const fact of [...(old?.eligibility.legacyFacts ?? []), ...eligibility.legacyFacts]) legacyDays.add(usageActivityUtcDay(fact.observedAtMs));
        }
    }
    await loadRoutes([...legacyDays]);
    for (const day of new Set([...changedDays, ...legacyDays])) {
        const next = (routes.get(day) ?? []).map(route => affectedSessions.has(route.fact.sessionId)
            ? { ...route, eligible: isScopedUsageReplayFactEligible(route.fact, sessions.get(route.fact.sessionId)?.eligibility) } : route);
        routes.set(day, next);
        changedDays.add(day);
        chunks.set(usageActivityRoutingKey(day), next.length > 0 ? JSON.stringify(next) : null);
    }
    const oldReportSources = head?.reportSources ?? [];
    const reportRows = new Map<string, ScopedUsageEventRow>();
    const newReportSources: SourceRoute[] = [];
    for (const key of affectedSessions) {
        const session = sessions.get(key)!;
        for (const row of resolveUsageLegacyReportRows(legacyReports.filter(report => report.sessionId === key), session.bridges.map(bridge => bridge.value))) {
            const fact = toScopedUsageReplayFact(row);
            reportRows.set(row.id, row);
            newReportSources.push({ fact, fingerprint: usageActivityFingerprint(JSON.stringify(row)),
                eligible: isScopedUsageReplayFactEligible(fact, session.eligibility), coverage: projectUsageCoverageEvidence([row]) });
        }
    }
    const replacedReportSources = oldReportSources.filter(route => affectedSessions.has(route.fact.sessionId));
    const reportSources = [...oldReportSources.filter(route => !affectedSessions.has(route.fact.sessionId)), ...newReportSources];
    const oldReportById = new Map(replacedReportSources.map(route => [route.fact.id, route]));
    const newReportById = new Map(newReportSources.map(route => [route.fact.id, route]));
    const removedReports = replacedReportSources.filter(route => newReportById.get(route.fact.id)?.fingerprint !== route.fingerprint);
    const addedReports = newReportSources.filter(route => oldReportById.get(route.fact.id)?.fingerprint !== route.fingerprint);
    // Preserve the canonical retained-report order after independently refreshing Session closures.
    const reportOrder = new Map(legacyReports.map((report, index) => [`legacy-report:${report.id}`, index]));
    reportSources.sort((left, right) => reportOrder.get(left.fact.id)! - reportOrder.get(right.fact.id)!);
    const dirty = new Set<string>();
    const orderChangedProjectionDays = new Set<number>();
    const compareInputs = (before: readonly SourceRoute[], after: readonly SourceRoute[]) => {
        const left = orderedInputs(before, query);
        const right = orderedInputs(after, query);
        for (const key of new Set([...left.subjects.keys(), ...right.subjects.keys()])) {
            if (left.subjects.get(key) !== right.subjects.get(key)) dirty.add(key);
        }
        // A replaced peer can change other subjects' equal-instant slots without emitting a row itself.
        for (const day of new Set([...left.projectionOrder.keys(), ...right.projectionOrder.keys()])) {
            const before = left.projectionOrder.get(day) ?? [];
            const after = right.projectionOrder.get(day) ?? [];
            const beforeIds = new Set(before);
            const afterIds = new Set(after);
            const retainedBefore = before.filter(id => afterIds.has(id));
            const retainedAfter = after.filter(id => beforeIds.has(id));
            if (retainedBefore.some((id, index) => id !== retainedAfter[index])) orderChangedProjectionDays.add(day);
        }
    };
    const replayDays = new Set([...changedDays,
        ...[...replacedReportSources, ...newReportSources].map(route => usageActivityUtcDay(route.fact.observedAtMs))]);
    await loadRoutes([...replayDays]);
    for (const day of replayDays) compareInputs([
        ...(previousRoutes.get(day) ?? []), ...oldReportSources.filter(route => usageActivityUtcDay(route.fact.observedAtMs) === day),
    ], [
        ...(routes.get(day) ?? []), ...reportSources.filter(route => usageActivityUtcDay(route.fact.observedAtMs) === day),
    ]);
    // Suppressed sources still own history membership so their later revival is exact.
    for (const route of [...removed, ...added, ...removedReports, ...addedReports]) dirty.add(route.fact.subjectKey);
    const dirtyKeys = [...dirty];
    const subjectChunks = head ? await readUsageActivitySummaryChunks(tx, accountId,
        dirtyKeys.filter(key => subjectKeys.has(key)).map(usageActivitySubjectKey)) : new Map<string, string>();
    for (const key of dirtyKeys) {
        const raw = subjectChunks.get(usageActivitySubjectKey(key));
        if (head && subjectKeys.has(key) && raw === undefined) throw new MissingUsageActivityRoutingChunk();
        if (raw !== undefined) subjects.set(key, JSON.parse(raw));
    }
    const removedIds = new Set([...removed, ...removedReports].map(route => route.fact.id));
    const reportIds = new Set(reportSources.map(route => route.fact.id));
    const addedBySubject = new Map<string, SourceRoute[]>();
    for (const route of [...added, ...addedReports]) {
        const group = addedBySubject.get(route.fact.subjectKey) ?? [];
        group.push(route);
        addedBySubject.set(route.fact.subjectKey, group);
    }
    const dirtySubjects: UsageActivityDirtySubject[] = dirtyKeys.map(subjectKey => {
        const previous = subjects.get(subjectKey);
        const refs = new Map(previous?.sources.filter(source => !removedIds.has(source.id)).map(source => [source.id, source]));
        for (const route of addedBySubject.get(subjectKey) ?? []) refs.set(route.fact.id,
            { id: route.fact.id, dayStartMs: usageActivityUtcDay(route.fact.observedAtMs), ...(reportIds.has(route.fact.id) ? { report: true as const } : {}) });
        const current: UsageActivitySubjectRoute = { sources: [...refs.values()], projectionDays: [], projectionWitnesses: [], selected: false };
        if (current.sources.length > 0) subjectKeys.add(subjectKey);
        else subjectKeys.delete(subjectKey);
        return { subjectKey, previous, current, eventIds: [] };
    });
    await loadRoutes(dirtySubjects.flatMap(subject => subject.current.sources.filter(source => !source.report).map(source => source.dayStartMs)));
    let allRoutes = [...routes.values()].flat().concat(reportSources);
    const byId = new Map(allRoutes.map(route => [route.fact.id, route]));
    let subjectCount = head?.subjectCount ?? 0;
    const start = query.dateRange?.startMs ?? -Infinity;
    const end = query.dateRange?.endMs ?? Infinity;
    const projectionDays = new Set([...orderChangedProjectionDays,
        ...dirtySubjects.flatMap(subject => subject.previous?.projectionDays ?? [])]);
    for (const subject of dirtySubjects) {
        const eligible = subject.current.sources.map(source => {
            const route = byId.get(source.id);
            if (!route) throw new MissingUsageActivityRoutingChunk();
            return route;
        }).filter(route => route.eligible);
        subject.current.selected = eligible.some(route => route.fact.observedAtMs >= start && route.fact.observedAtMs < end);
        subjectCount += Number(subject.current.selected) - Number(subject.previous?.selected ?? false);
        if (subject.current.selected) {
            subject.eventIds = eligible.map(route => route.fact.id);
            for (const route of eligible) if (route.fact.observedAtMs >= start && route.fact.observedAtMs < end) {
                projectionDays.add(resolveUsageBucketBounds('day', route.fact.observedAtMs,
                    query.timeZoneOffsetMinutes ?? 0).bucketStartMs);
            }
        }
    }
    // Complete equal-instant peer slots for every touched local day, including its UTC neighbour.
    await loadRoutes([...projectionDays].flatMap(day => [usageActivityUtcDay(day), usageActivityUtcDay(day + 86_400_000 - 1)]));
    allRoutes = [...routes.values()].flat().concat(reportSources);
    const ordered = orderRuntimeObservations(allRoutes.filter(route => route.eligible).map(route => route.fact));
    const ranks = new Map(ordered.map((fact, index) => [fact.id, index]));
    const sourceFingerprints = new Map(allRoutes.map(route => [route.fact.id, route.fingerprint]));
    for (const subject of dirtySubjects) subject.eventIds.sort((left, right) => ranks.get(left)! - ranks.get(right)! || left.localeCompare(right));
    const oldProjectionDays = new Set(head?.projectionDays);
    const dayChunks = head ? await readUsageActivitySummaryChunks(tx, accountId,
        [...projectionDays].filter(day => oldProjectionDays.has(day)).map(usageActivityProjectionDayKey)) : new Map<string, string>();
    const operandChunks = new Map<number, string>();
    for (const day of projectionDays) {
        const raw = dayChunks.get(usageActivityProjectionDayKey(day));
        if (oldProjectionDays.has(day) && raw === undefined) throw new MissingUsageActivityRoutingChunk();
        if (raw !== undefined) operandChunks.set(day, raw);
    }
    const neededIds = dirtySubjects.flatMap(subject => subject.eventIds).filter(id => !reportIds.has(id));
    const missing = neededIds.filter(id => !loadedById.has(id));
    const historical = await loadUsageEventsForQuery(tx, accountId, query, missing);
    for (const row of historical) loadedById.set(row.id, row);
    // Unchanged synthetic report bodies are reconstructed only for a dirty subject that needs them.
    const missingReports = new Set(dirtySubjects.flatMap(subject => subject.eventIds).filter(id => reportIds.has(id) && !reportRows.has(id)));
    if (missingReports.size > 0) {
        for (const row of resolveUsageLegacyReportRows(legacyReports.filter(report => missingReports.has(`legacy-report:${report.id}`)), [])) reportRows.set(row.id, row);
    }
    return { head, sourceDays, subjectKeys, sessionKeys, sourceCoverage, reportSources, legacyReports, dirtySubjects,
        ranks, sourceFingerprints, rows: neededIds.map(id => {
            const row = loadedById.get(id);
            if (!row) throw new Error('Usage activity source changed within its admitted snapshot');
            return row;
        }), reportRows, chunks, subjectCount, discoveryEventsRead: loaded.length, historyEventsRead: historical.length,
        projectionDays: [...projectionDays], orderChangedProjectionDays: [...orderChangedProjectionDays], operandChunks };
}
