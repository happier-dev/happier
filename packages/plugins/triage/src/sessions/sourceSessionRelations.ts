import type { TriageDataActionContext } from '../actions/dataContext.js';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';
import {
    TriageSourceLinkSessionResultV1Schema,
    TriageSourceReadSessionLinksResultV1Schema,
    type TriageEntryRefV1,
    type TriageEntryLocatorV1,
} from '@happier-dev/triage-protocol/v1';
import { indexTriageAdmittedSourcesV1, type TriageAdmittedSourceV1 } from '../actions/listEntries.js';
import { TriageListInvocationErrorV1Schema } from '../actions/listEntriesProtocol.js';
import type { TriageReadSourceSessionLinksResultV1, TriageSourceSessionLinksLaneV1 } from '../actions/sessionLinksProtocol.js';
import type { CorpusCollectionsV1 } from '../corpus/collections/bindCorpusCollections.js';
import type { CorpusSessionLinkRowV1, CorpusSourceInstanceRowV1 } from '../corpus/collections/rows.js';
import { readActiveConfiguredSourceRows } from '../corpus/configuration/readConfiguredSourceRows.js';
import { configuredSourceInstanceIsOwnedBy } from '../corpus/configuration/administerConfiguredSourceInstance.js';
import { createTriageConfigureSourceOfferV1 } from '../corpus/configuration/sourceSetupOffer.js';
import { entryReferenceComponents, renderSourceQualifiedId, sameTriageEntryReference } from '../corpus/identity/components.js';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../manifest.js';
import { linkEntryToSession, unlinkEntryFromSession, type TriageEntrySessionLinkDisplayV1 } from './entrySessionLinks.js';
import { readTriageSessionLinksPageV1, readTriageSessionLinksForEntriesV1 } from './readEntrySessionLinks.js';

export type TriageSourceSessionLinkV1 = Readonly<{
    entryRef: TriageEntryRefV1; sessionId: string; linkedAtMs: number; displayPath: string;
    sourceInstanceId?: string;
    sourceInstanceRevision?: number;
    locator?: TriageEntryLocatorV1;
}>;
export type TriageSessionRelationWriteV1 = Readonly<{
    entryRef: TriageEntryRefV1; sessionId: string; sourceInstanceId?: string;
    display?: TriageEntrySessionLinkDisplayV1; linked: boolean;
}>;

function failedRelationWrite(cause: string | PluginError, retryable?: boolean): Readonly<{ status: 'failed'; failure: PluginError }> {
    return { status: 'failed', failure: typeof cause === 'string'
        ? new PluginError({ code: cause, ...(retryable === undefined ? {} : { retryable }) }) : cause };
}

/** Declaration, rather than a currently executable handle, owns the kind. */
function sourceRelationKinds(source: TriageAdmittedSourceV1): readonly string[] {
    return source.descriptor.sessionRelations !== undefined || source.operations?.linkSession !== undefined || source.operations?.readSessionLinks !== undefined
        ? source.descriptor.sessionRelations?.kindIds ?? source.descriptor.kinds.map((kind) => kind.id) : [];
}
type RelationSelection = Readonly<{ entryRef?: TriageEntryRefV1; sourceInstanceId?: string; sessionId?: string }>;
type RelationLaneIdentity = Pick<TriageSourceSessionLinksLaneV1, 'source' | 'sourceInstanceId' | 'displayLabel'>;
type RelationScope =
    | Readonly<{ kind: 'ready'; row: CorpusSourceInstanceRowV1; source: TriageAdmittedSourceV1; lane: RelationLaneIdentity;
        roleKinds: readonly string[]; fallbackKinds: readonly string[] }>
    | Readonly<{ kind: 'diagnostic'; lane: RelationLaneIdentity; health: TriageSourceSessionLinksLaneV1['health'] }>;

function hasUnscopedSessionDemand(input: RelationSelection) {
    return input.sessionId !== undefined && input.entryRef === undefined && input.sourceInstanceId === undefined;
}

function hasNoSessionSourceScopes(input: RelationSelection, scopes: readonly RelationScope[], sources: ReadonlyMap<string, TriageAdmittedSourceV1>) {
    return hasUnscopedSessionDemand(input) && sources.size === 0 && scopes.length === 0;
}

function corpusKindsFor(input: RelationSelection, scopes: readonly RelationScope[], sources: ReadonlyMap<string, TriageAdmittedSourceV1>) {
    const kindsBySource = new Map<string, readonly string[]>();
    if (input.sourceInstanceId === undefined) {
        for (const [sourceId, source] of sources) {
            if (input.entryRef !== undefined && sourceId !== renderSourceQualifiedId(input.entryRef.source)) continue;
            const ownedKinds = sourceRelationKinds(source);
            const kinds = source.descriptor.kinds.map(kind => kind.id).filter(kindId => !ownedKinds.includes(kindId)
                && (input.entryRef === undefined || input.entryRef.kindId === kindId));
            if (kinds.length > 0) kindsBySource.set(sourceId, kinds);
        }
    }
    for (const scope of scopes) if (scope.kind === 'ready' && scope.fallbackKinds.length > 0) {
        kindsBySource.set(renderSourceQualifiedId(scope.lane.source), scope.fallbackKinds);
    }
    return kindsBySource;
}

/** One kind-aware relation decision for starts, Actions and all linked readers.
 * Only a definitively non-owned kind reaches the corpus relationship owner. */
export function createTriageSourceSessionRelations(
    context: Pick<TriageDataActionContext, 'signal'> & Readonly<{
        services: Pick<TriageDataActionContext['services'], 'actions' | 'targetedContributions'>;
    }>,
    collections: Pick<CorpusCollectionsV1, 'sourceInstances' | 'sessionLinks'>,
) {
    const options = { signal: context.signal };
    async function current() {
        const observation = context.services.targetedContributions.observeForSelf(
            TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1, { onInvalidated: () => {} },
        );
        try {
            const snapshot = await observation.readCurrent(options);
            return indexTriageAdmittedSourcesV1(snapshot.contributions);
        } finally { observation.dispose(); }
    }
    // One invocation may link several attachments. Resolve its source/configured
    // view once; the host still validates each original operation handle at use.
    let view: Promise<Readonly<{
        sources: Awaited<ReturnType<typeof current>>;
        configured: Awaited<ReturnType<typeof readActiveConfiguredSourceRows>>;
    }>> | undefined;
    function readView() {
        return view ??= Promise.all([current(), readActiveConfiguredSourceRows(collections.sourceInstances, options)])
            .then(([sources, configured]) => ({ sources, configured }));
    }
    async function ownership(entryRef: TriageEntryRefV1): Promise<'source' | 'corpus' | 'unavailable'> {
        const { sources } = await readView();
        const source = sources.get(renderSourceQualifiedId(entryRef.source));
        if (source === undefined || !source.descriptor.kinds.some((kind) => kind.id === entryRef.kindId)) return 'unavailable';
        return sourceRelationKinds(source).includes(entryRef.kindId) ? 'source' : 'corpus';
    }
    /** The read and its dependency observer consume the same admitted slices. */
    async function readScopes(input: RelationSelection): Promise<readonly RelationScope[]> {
        const { sources, configured } = await readView();
        return configured.rows.filter(row => (input.sourceInstanceId === undefined || row.configured.instance.sourceInstanceId === input.sourceInstanceId)
            && (input.entryRef === undefined || configuredSourceInstanceIsOwnedBy(row, input.entryRef.source))).map((row): RelationScope => {
            const source = sources.get(row.sourceQualifiedId);
            const lane = { source: row.configured.instance.source, sourceInstanceId: row.configured.instance.sourceInstanceId,
                displayLabel: row.configured.locator?.displayLabel ?? source?.descriptor.displayName ?? row.sourceQualifiedId };
            if (row.sourceQualifiedId !== renderSourceQualifiedId(lane.source)) return { kind: 'diagnostic', lane,
                health: { kind: 'failed', failure: { class: 'unsupportedContract', code: 'sourceIdentityMismatch' } } };
            if (source === undefined) return { kind: 'diagnostic', lane, health: {
                kind: 'failed', failure: { class: 'unsupportedContract', code: 'sessionLinksSourceNotAdmitted' },
            } };
            const requestedKinds = source.descriptor.kinds.map(kind => kind.id).filter(kindId => input.entryRef === undefined || input.entryRef.kindId === kindId);
            if (requestedKinds.length === 0) return { kind: 'diagnostic', lane,
                health: { kind: 'failed', failure: { class: 'unsupportedContract', code: 'sessionLinksKindUnsupported' } } };
            const ownedKinds = sourceRelationKinds(source);
            return { kind: 'ready', row, source, lane, roleKinds: requestedKinds.filter(kindId => ownedKinds.includes(kindId)),
                fallbackKinds: requestedKinds.filter(kindId => !ownedKinds.includes(kindId)) };
        });
    }
    const relations = {
        readSources: readView,
        ownership,
        readScopes,
        async hasCorpusReadDemand(input: RelationSelection) {
            const [{ sources }, scopes] = await Promise.all([readView(), readScopes(input)]);
            return corpusKindsFor(input, scopes, sources).size > 0 || hasUnscopedSessionDemand(input);
        },
        async findConfiguredInstance(sourceInstanceId: string) {
            const { configured } = await readView();
            return configured.records.find((record) => record.value.configured.instance.sourceInstanceId === sourceInstanceId) ?? null;
        },
        async write(input: TriageSessionRelationWriteV1): Promise<Readonly<{ status: 'linked' | 'unlinked' | 'conflict' }>
            | Readonly<{ status: 'failed'; failure: PluginError }>> {
            try {
                const { sources, configured } = await readView();
                const source = sources.get(renderSourceQualifiedId(input.entryRef.source));
                const owner = await ownership(input.entryRef);
                if (source === undefined || owner === 'unavailable') return failedRelationWrite('sessionLinksSourceNotAdmitted', false);
                const instances = configured.rows.filter((row) => configuredSourceInstanceIsOwnedBy(row, input.entryRef.source)
                    && row.sourceQualifiedId === renderSourceQualifiedId(input.entryRef.source)
                    && (input.sourceInstanceId === undefined || row.configured.instance.sourceInstanceId === input.sourceInstanceId));
                if (input.sourceInstanceId !== undefined && instances.length !== 1) return failedRelationWrite('sessionLinksSourceInstanceUnavailable', false);
                const operation = source?.operations?.linkSession;
                if (owner === 'source') {
                    if (operation === undefined || source.operations?.readSessionLinks === undefined) return failedRelationWrite('sessionLinksRolesUnsupported', false);
                    if (instances.length !== 1) return failedRelationWrite(instances.length > 1
                        ? 'sessionLinksSourceInstanceRequired' : 'sessionLinksSourceInstanceUnavailable', false);
                    const entry = input.entryRef;
                    const result = TriageSourceLinkSessionResultV1Schema.parse(await context.services.actions.executeAdmittedTargetedOperation(operation, {
                        v: 1, instance: instances[0]!.configured,
                        localRef: { kindId: entry.kindId, collisionScope: entry.collisionScope, entryId: entry.entryId },
                        sessionId: input.sessionId, linked: input.linked,
                    }, options));
                    if (result.status !== (input.linked ? 'linked' : 'unlinked')) return failedRelationWrite('sessionLinksSourceWriteNotApplied');
                    // A previously persisted duplicate is removed explicitly through
                    // its relation owner after the authoritative source commit.
                    const reconciled = await unlinkEntryFromSession({ collections, entryRef: input.entryRef, sessionId: input.sessionId, signal: context.signal });
                    return reconciled.status === 'unlinked' ? { status: input.linked ? 'linked' : 'unlinked' }
                        : failedRelationWrite(reconciled.status === 'failed' ? reconciled.failure ?? 'sessionLinksCorpusWriteNotApplied'
                            : 'sessionLinksCorpusWriteNotApplied');
                }
                if (!input.linked) {
                    const result = await unlinkEntryFromSession({ collections, entryRef: input.entryRef, sessionId: input.sessionId, signal: context.signal });
                    return result.status === 'failed' ? failedRelationWrite(result.failure ?? 'sessionLinksCorpusWriteNotApplied') : result;
                }
                if (input.display === undefined) return failedRelationWrite('sessionLinksDisplayRequired', false);
                const result = await linkEntryToSession({ collections, entryRef: input.entryRef, sessionId: input.sessionId,
                    display: input.display, nowMs: Date.now(), signal: context.signal });
                return result.status === 'failed' ? failedRelationWrite(result.failure ?? 'sessionLinksCorpusWriteNotApplied') : result;
            } catch (error) {
                if (isPluginError(error)) throw error;
                return failedRelationWrite('sessionLinksWriteFailed');
            }
        },
        async read(input: Readonly<{ entryRef?: TriageEntryRefV1; sourceInstanceId?: string; sessionId?: string;
            paged?: boolean; cursor?: string;
            /** Detail preparation requires an authoritative page and preserves the original transport refusal. */
            readFailure?: 'throw' }>, corpusRead?: () => Promise<readonly CorpusSessionLinkRowV1[]>): Promise<TriageReadSourceSessionLinksResultV1> {
            const { sources, configured } = await readView();
            const links: TriageSourceSessionLinkV1[] = [];
            const lanes: TriageSourceSessionLinksLaneV1[] = [];
            const corpusLanes: TriageSourceSessionLinksLaneV1[] = [];
            const scopes = await readScopes(input);
            const corpusKindsBySource = corpusKindsFor(input, scopes, sources);
            const noSourceScopes = hasNoSessionSourceScopes(input, scopes, sources);
            const instanceRevisions = new Map(configured.records.map((record) => [record.value.configured.instance.sourceInstanceId, record.revision]));
            const linkIndexes = new Map<string, number>();
            let nextCursor: string | undefined;
            let unknownCorpusCoverage = false;
            function addLink(link: TriageSourceSessionLinkV1) {
                const key = JSON.stringify([entryReferenceComponents(link.entryRef), link.sessionId]);
                const index = linkIndexes.get(key);
                if (index === undefined) { linkIndexes.set(key, links.length); links.push(link); }
                else if (links[index]!.sourceInstanceId !== link.sourceInstanceId) {
                    // The relationship is known, but no selected configured
                    // authority is established by an unscoped duplicate.
                    const unqualified = { ...links[index]! };
                    delete unqualified.sourceInstanceId;
                    delete unqualified.sourceInstanceRevision;
                    links[index] = unqualified;
                }
            }
            for (const scope of scopes) {
                if (scope.kind === 'diagnostic') { lanes.push({ ...scope.lane, health: scope.health }); continue; }
                const { row, source, lane, roleKinds, fallbackKinds } = scope;
                if (fallbackKinds.length > 0) {
                    const corpusLane: TriageSourceSessionLinksLaneV1 = { ...lane, kindIds: fallbackKinds, health: { kind: 'complete' } };
                    lanes.push(corpusLane); corpusLanes.push(corpusLane);
                }
                if (roleKinds.length === 0) continue;
                const roleLane = { ...lane, kindIds: roleKinds };
                const operation = source?.operations?.readSessionLinks;
                if (operation === undefined || source.operations?.linkSession === undefined) {
                    lanes.push({ ...roleLane, health: { kind: 'failed', failure: { class: 'unsupportedContract', code: 'sessionLinksRolesUnsupported' } } });
                    continue;
                }
                try {
                    const entry = input.entryRef;
                    const parsed = TriageSourceReadSessionLinksResultV1Schema.safeParse(await context.services.actions.executeAdmittedTargetedOperation(operation, {
                        v: 1, instance: row.configured,
                        ...(entry === undefined ? {} : { localRef: { kindId: entry.kindId, collisionScope: entry.collisionScope, entryId: entry.entryId } }),
                        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
                    }, options));
                    if (!parsed.success) {
                        lanes.push({ ...roleLane, health: { kind: 'failed', failure: { class: 'unsupportedContract', code: 'sessionLinksInvalidResult' } } });
                        continue;
                    }
                    const result = parsed.data;
                    if (result.kind === 'failed') { lanes.push({ ...roleLane, health: result }); continue; }
                    if (result.links.some((link) => {
                        const entryRef = { source: row.configured.instance.source, ...link.localRef };
                        return !roleKinds.includes(entryRef.kindId)
                            || (entry !== undefined && !sameTriageEntryReference(entry, entryRef))
                            || (input.sessionId !== undefined && input.sessionId !== link.sessionId);
                    }) || result.kind === 'partial' && result.unavailableRefs.some(localRef => !roleKinds.includes(localRef.kindId)
                        || entry !== undefined && !sameTriageEntryReference(entry, { source: lane.source, ...localRef }))) {
                        lanes.push({ ...roleLane, health: { kind: 'failed', failure: { class: 'unsupportedContract', code: 'sessionLinksInvalidResult' } } });
                        continue;
                    }
                    lanes.push({ ...roleLane, health: result.kind === 'partial'
                        ? { kind: 'partial', unavailableRefs: result.unavailableRefs.map(localRef => ({ source: lane.source, ...localRef })) }
                        : { kind: 'complete' } });
                    for (const link of result.links) {
                        const entryRef = { source: row.configured.instance.source, ...link.localRef };
                        addLink({ entryRef, sessionId: link.sessionId, sourceInstanceId: lane.sourceInstanceId,
                            sourceInstanceRevision: instanceRevisions.get(lane.sourceInstanceId),
                            linkedAtMs: link.linkedAtMs, displayPath: link.displayPath,
                            ...(link.locator === undefined ? {} : { locator: link.locator }) });
                    }
                } catch (error) {
                    if (input.readFailure === 'throw') throw isPluginError(error) ? error
                        : new PluginError({ code: 'sessionLinksReadFailed', retryable: true });
                    const diagnostic = isPluginError(error) ? TriageListInvocationErrorV1Schema.safeParse({ code: error.code, retryable: error.retryable }) : null;
                    lanes.push({ ...roleLane, health: { kind: 'failed', failure: { class: 'transient', code: 'sessionLinksReadFailed' },
                        ...(diagnostic?.success ? { invocationError: diagnostic.data } : {}),
                    } });
                }
            }
            if (corpusKindsBySource.size > 0 || hasUnscopedSessionDemand(input)) {
                try {
                    // The incumbent index selects the exact entry or Session;
                    // kind identity remains private. Decode its pages once and
                    // admit only corpus-owned kinds, never a scan per kind.
                    const relation = input.entryRef !== undefined ? { entryRef: input.entryRef }
                        : input.sessionId !== undefined ? { sessionId: input.sessionId } : undefined;
                    let cursor = input.cursor;
                    const seen = new Set<string>();
                    do {
                        const page = corpusRead === undefined
                            ? await readTriageSessionLinksPageV1(collections.sessionLinks, { relation, cursor }, options)
                            : { links: await corpusRead(), nextCursor: undefined };
                        for (const link of page.links) {
                            if (input.entryRef !== undefined && !sameTriageEntryReference(input.entryRef, link.entryRef)) continue;
                            if (input.sessionId !== undefined && link.sessionId !== input.sessionId) continue;
                            // Unknown retained identities are not proof of absence,
                            // even beside healthy configured sources. Keep them
                            // undisclosed without weakening a selected owner's scope.
                            if (noSourceScopes) { unknownCorpusCoverage = true; continue; }
                            const admittedSource = sources.get(renderSourceQualifiedId(link.entryRef.source));
                            if (input.sourceInstanceId === undefined && (admittedSource === undefined
                                || !admittedSource.descriptor.kinds.some(kind => kind.id === link.entryRef.kindId))) {
                                unknownCorpusCoverage = true;
                                continue;
                            }
                            if (!corpusKindsBySource.get(renderSourceQualifiedId(link.entryRef.source))?.includes(link.entryRef.kindId)) continue;
                            const matchingLanes = corpusLanes.filter((lane) => renderSourceQualifiedId(lane.source) === renderSourceQualifiedId(link.entryRef.source)
                                && lane.kindIds?.includes(link.entryRef.kindId));
                            if (matchingLanes.length === 0) unknownCorpusCoverage = true;
                            addLink({ entryRef: link.entryRef, sessionId: link.sessionId,
                                ...(matchingLanes.length === 1 ? { sourceInstanceId: matchingLanes[0]!.sourceInstanceId,
                                    sourceInstanceRevision: instanceRevisions.get(matchingLanes[0]!.sourceInstanceId) } : {}),
                                linkedAtMs: link.linkedAtMs, displayPath: link.displayPathAtLink });
                        }
                        if (page.nextCursor !== undefined && seen.has(page.nextCursor)) throw new Error('triage:sessionLinks:cursorDidNotAdvance');
                        if (page.nextCursor !== undefined) seen.add(page.nextCursor);
                        cursor = page.nextCursor;
                        if (input.paged) { nextCursor = cursor; break; }
                    } while (cursor !== undefined);
                    if (nextCursor !== undefined) {
                        for (const lane of corpusLanes) lanes[lanes.indexOf(lane)] = { ...lane,
                            health: { kind: 'failed', failure: { class: 'transient', code: 'sessionLinksIncomplete' } } };
                    }
                } catch (error) {
                    if (input.readFailure === 'throw') throw isPluginError(error) ? error
                        : new PluginError({ code: 'sessionLinksReadFailed', retryable: true });
                    unknownCorpusCoverage = true;
                    for (const lane of corpusLanes) lanes[lanes.indexOf(lane)] = { ...lane,
                        health: { kind: 'failed', failure: { class: 'transient', code: 'sessionLinksReadFailed' } } };
                }
            }
            const complete = lanes.filter((lane) => lane.kindIds !== undefined && lane.health.kind === 'complete').length;
            const completeEmpty = noSourceScopes && !unknownCorpusCoverage && nextCursor === undefined;
            const configureSources = hasUnscopedSessionDemand(input) ? [...sources.values()].flatMap(source => {
                if (!source.descriptor.kinds.some(kind => kind.workflowSubject === 'pullRequest')) return [];
                const offer = createTriageConfigureSourceOfferV1(source.contributor.pluginId, source.descriptor);
                return offer === undefined ? [] : [offer];
            }) : [];
            const result: TriageReadSourceSessionLinksResultV1 = { kind: completeEmpty || (lanes.length > 0 && complete === lanes.length && !unknownCorpusCoverage) ? 'complete'
                : complete > 0 || lanes.some(lane => lane.health.kind === 'partial') || links.length > 0 || nextCursor !== undefined ? 'partial' : 'failed', links, lanes,
                ...(configureSources.length === 0 ? {} : { configureSources }),
                ...(nextCursor === undefined ? {} : { nextCursor }) };
            if (input.readFailure === 'throw' && result.kind !== 'complete' && result.nextCursor === undefined) {
                const health = lanes.find(lane => lane.health.kind === 'failed')?.health;
                throw new PluginError(health?.kind === 'failed'
                    ? { code: health.failure.code, retryable: health.failure.class === 'transient' }
                    : { code: 'sessionLinksReadFailed', retryable: true });
            }
            return result;
        },
    };
    return { ...relations,
        async readEntries(entries: readonly Readonly<{ entryRef: TriageEntryRefV1; sourceInstanceId?: string }>[]) {
            const { sources } = await readView();
            const demands = await Promise.all(entries.map(async selection => ({ selection,
                corpus: corpusKindsFor(selection, await readScopes(selection), sources).size > 0,
            })));
            // Gather before awaiting storage; source-owned roles still execute
            // per selection through their admitted authority and health path.
            let corpusRead: Promise<ReadonlyMap<string, readonly CorpusSessionLinkRowV1[]>> | undefined;
            const entryKey = (entry: TriageEntryRefV1) => JSON.stringify(entryReferenceComponents(entry));
            const readCorpus = () => corpusRead ??= readTriageSessionLinksForEntriesV1(collections.sessionLinks,
                demands.filter(demand => demand.corpus).map(demand => demand.selection.entryRef), options).then(links => {
                    const byEntry = new Map<string, CorpusSessionLinkRowV1[]>();
                    for (const link of links) {
                        const key = entryKey(link.entryRef);
                        const existing = byEntry.get(key);
                        if (existing === undefined) byEntry.set(key, [link]);
                        else existing.push(link);
                    }
                    return byEntry;
                });
            return await Promise.all(demands.map(async ({ selection }) => {
                let result: TriageReadSourceSessionLinksResultV1;
                try { result = await relations.read(selection, async () => (await readCorpus()).get(entryKey(selection.entryRef)) ?? []); }
                catch { result = { kind: 'failed', links: [] }; }
                return { ...selection, result };
            }));
        },
    };
}
