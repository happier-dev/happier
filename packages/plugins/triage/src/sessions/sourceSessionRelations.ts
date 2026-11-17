import { readAccountDataSourceRecordsV1 } from '../corpus/configuration/accountDataSources.js';
import type { TriageDataActionContext } from '../actions/dataContext.js';
import { isPluginError, PluginError, readPluginErrorRequestIdV1 } from '@happier-dev/plugin-sdk';
import type { PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
import {
    TriageSourceLinkSessionResultV1Schema,
    TriageSourceReadSessionLinksResultV1Schema,
    isTriageSourceConnectedAccountInstanceV1,
    type TriageEntryRefV1,
    type TriageEntryLocatorV1,
} from '@happier-dev/triage-protocol/v1';
import { indexTriageAdmittedSourcesV1, type TriageAdmittedSourceV1 } from '../actions/listEntries.js';
import { TriageListInvocationErrorV1Schema } from '../actions/listEntriesProtocol.js';
import type { TriageReadSourceSessionLinksResultV1, TriageSourceSessionLinksLaneV1 } from '../actions/sessionLinksProtocol.js';
import type { CorpusCollectionsV1 } from '../corpus/collections/bindCorpusCollections.js';
import type { CorpusSessionLinkRowV1, CorpusSourceInstanceRowV1 } from '../corpus/collections/rows.js';
import type { CorpusRowV1 } from '../corpus/collections/rowCodec.js';
import { readActiveConfiguredSourceRows } from '../corpus/configuration/readConfiguredSourceRows.js';
import { configuredSourceInstanceIsOwnedBy } from '../corpus/configuration/administerConfiguredSourceInstance.js';
import { createTriageConfigureSourceOfferV1 } from '../corpus/configuration/sourceSetupOffer.js';
import { entryReferenceComponents, renderSourceQualifiedId, sameTriageEntryReference } from '../corpus/identity/components.js';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../targetedContributions.js';
import { linkEntryToSession, unlinkEntryFromSession, type TriageEntrySessionLinkDisplayV1 } from './entrySessionLinks.js';
import { readTriageSessionLinksPageV1, readTriageSessionLinksForEntriesV1, readTriageSessionLinksForSessionsV1 } from './readEntrySessionLinks.js';
import { INTERNAL_TASK_SOURCE_RECORD_V1, isInternalTaskConfiguredInstanceV1 } from '../internalTasks/configuration.js';
import { isInternalTaskReferenceV1 } from '../internalTasks/identity.js';
import { INTERNAL_TASK_DESCRIPTOR_V1 } from '../internalTasks/contribution.js';
import { readInternalTaskSessionLinks, type TaskList } from '../internalTasks/source.js';

export type TriageSourceSessionLinkV1 = Readonly<{
    entryRef: TriageEntryRefV1; sessionId: string; linkedAtMs: number; displayPath: string;
    sourceInstanceId?: string;
    sourceInstanceRevision?: number;
    sourceInstanceRowId?: string;
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
type RelationSelection = Readonly<{ entryRef?: TriageEntryRefV1; sourceInstanceId?: string; sessionId?: string; sessionIds?: readonly string[]; kindId?: string }>;
type RelationLaneIdentity = Pick<TriageSourceSessionLinksLaneV1, 'source' | 'sourceInstanceId' | 'displayLabel'>;
type RelationScope =
    | Readonly<{ kind: 'ready'; row: CorpusSourceInstanceRowV1; source: TriageAdmittedSourceV1 | undefined; lane: RelationLaneIdentity;
        roleKinds: readonly string[]; fallbackKinds: readonly string[] }>
    | Readonly<{ kind: 'diagnostic'; lane: RelationLaneIdentity; health: TriageSourceSessionLinksLaneV1['health'] }>;

function hasUnscopedSessionDemand(input: RelationSelection) {
    return (input.sessionId !== undefined || input.sessionIds !== undefined) && input.entryRef === undefined && input.sourceInstanceId === undefined;
}

function hasNoSessionSourceScopes(input: RelationSelection, scopes: readonly RelationScope[], sources: ReadonlyMap<string, TriageAdmittedSourceV1>) {
    return hasUnscopedSessionDemand(input) && sources.size === 0 && scopes.length === 0;
}

function corpusKindsFor(input: RelationSelection, scopes: readonly RelationScope[], sources: ReadonlyMap<string, TriageAdmittedSourceV1>) {
    const kindsBySource = new Map<string, readonly string[]>();
    const requestedKind = input.entryRef?.kindId ?? input.kindId;
    if (input.sourceInstanceId === undefined) {
        for (const [sourceId, source] of sources) {
            if (input.entryRef !== undefined && sourceId !== renderSourceQualifiedId(input.entryRef.source)) continue;
            const ownedKinds = sourceRelationKinds(source);
            const kinds = source.descriptor.kinds.map(kind => kind.id).filter(kindId => !ownedKinds.includes(kindId)
                && (requestedKind === undefined || requestedKind === kindId));
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
    context: Pick<TriageDataActionContext, 'signal' | 'invocationId'> & Readonly<{
        services: Pick<TriageDataActionContext['services'], 'actions' | 'targetedContributions'>;
    }>,
    collections: Pick<CorpusCollectionsV1, 'sourceInstances' | 'sessionLinks'>,
    /** An exact row and optional admitted source view already resolved for this entry. */
    selected?: Readonly<{ entryRef: TriageEntryRefV1; record: CorpusRowV1<CorpusSourceInstanceRowV1> | null;
        sources?: ReadonlyMap<string, TriageAdmittedSourceV1> }>,
    readTaskList?: () => Promise<TaskList | null>,
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
    let sourcesView: ReturnType<typeof current> | undefined = selected?.sources === undefined
        ? undefined : Promise.resolve(selected.sources);
    let configuredView: ReturnType<typeof readActiveConfiguredSourceRows> | undefined;
    const accountViews = new Map<string, Promise<PluginActionResultById['connectedServices.accounts.list']['accounts'] | undefined>>();
    async function selectConfiguredInstance(instances: readonly CorpusSourceInstanceRowV1[], readEntryRef?: TriageEntryRefV1) {
        if (instances.length < 2) return instances[0];
        const host = instances[0]!.configured.localInstanceKey;
        if (instances.some(instance => instance.configured.localInstanceKey !== host)) return undefined;
        const source = readEntryRef === undefined ? undefined
            : (await readView({ entryRef: readEntryRef })).sources.get(renderSourceQualifiedId(readEntryRef.source));
        const connected = instances.filter(instance => isTriageSourceConnectedAccountInstanceV1(instance.configured));
        // Unknown identity is not a conflicting subject. PR reads prefer
        // a connected binding; writes never supply a read entry and stay strict.
        const pullRequestRead = source?.descriptor.kinds.some(kind => kind.id === readEntryRef?.kindId
            && kind.workflowSubject === 'pullRequest') === true;
        const candidates = pullRequestRead && connected.length > 0 ? connected : instances;
        const identities = await Promise.all(candidates.map(async instance => {
            if (!isTriageSourceConnectedAccountInstanceV1(instance.configured)) return undefined;
            const ref = instance.configured.binding.account;
            const serviceKey = JSON.stringify([ref.service.pluginId, ref.service.localId]);
            let accounts = accountViews.get(serviceKey);
            if (accounts === undefined) {
                // This existing host projection retains authenticated identity;
                // choosing a relation never acquires a provider credential.
                accounts = Promise.resolve().then(() => context.services.actions.execute('connectedServices.accounts.list', { service: ref.service }, options))
                    .then(result => 'accounts' in result ? result.accounts : undefined, () => undefined);
                accountViews.set(serviceKey, accounts);
            }
            return (await accounts)?.find(({ account }) => account.ref.accountId === ref.accountId
                && account.ref.service.pluginId === ref.service.pluginId
                && account.ref.service.localId === ref.service.localId)?.account.providerIdentity?.accountId;
        }));
        const knownIdentities = identities.filter((identity): identity is string => typeof identity === 'string' && identity.length > 0);
        if ((!pullRequestRead && knownIdentities.length !== candidates.length)
            || knownIdentities.some(identity => identity !== knownIdentities[0])) return undefined;
        return candidates.reduce((selected, instance) => instance.configured.instance.sourceInstanceId < selected.configured.instance.sourceInstanceId
            ? instance : selected);
    }
    function isBuiltinSelection(input: RelationSelection | undefined) {
        return input?.entryRef !== undefined && configuredSourceInstanceIsOwnedBy(INTERNAL_TASK_SOURCE_RECORD_V1.value, input.entryRef.source);
    }
    function readView(input?: RelationSelection) {
        // This immutable source is already configured by its canonical owner.
        // An exact native record never needs the configured-source inventory.
        const selectedEntry = input?.entryRef !== undefined && selected !== undefined
            && renderSourceQualifiedId(input.entryRef.source) === renderSourceQualifiedId(selected.entryRef.source);
        const selectedRecords = selected?.record == null ? [] : [selected.record];
        const configured = selectedEntry
            ? Promise.resolve({ rows: selectedRecords.map(record => record.value), records: selectedRecords, status: 'complete' as const })
            : isBuiltinSelection(input)
            ? Promise.resolve({ rows: [INTERNAL_TASK_SOURCE_RECORD_V1.value], records: [INTERNAL_TASK_SOURCE_RECORD_V1], status: 'complete' as const })
            : configuredView ??= (sourcesView ??= current()).then(sources => readActiveConfiguredSourceRows(collections.sourceInstances, {
                ...options, accountDataSources: readAccountDataSourceRecordsV1(sources),
            }));
        return Promise.all([sourcesView ??= current(), configured])
            .then(([sources, configured]) => ({ sources, configured }));
    }
    async function ownership(entryRef: TriageEntryRefV1): Promise<'source' | 'corpus' | 'unavailable'> {
        const { sources } = await readView({ entryRef });
        const source = sources.get(renderSourceQualifiedId(entryRef.source));
        if (source === undefined || !source.descriptor.kinds.some((kind) => kind.id === entryRef.kindId)) return 'unavailable';
        return sourceRelationKinds(source).includes(entryRef.kindId) ? 'source' : 'corpus';
    }
    /** The read and its dependency observer consume the same admitted slices. */
    async function readScopes(input: RelationSelection): Promise<readonly RelationScope[]> {
        const { sources, configured } = await readView(input);
        return configured.rows.filter(row => (input.sourceInstanceId === undefined || row.configured.instance.sourceInstanceId === input.sourceInstanceId)
            && (input.entryRef === undefined || configuredSourceInstanceIsOwnedBy(row, input.entryRef.source))).map((row): RelationScope => {
            const source = sources.get(row.sourceQualifiedId);
            const lane = { source: row.configured.instance.source, sourceInstanceId: row.configured.instance.sourceInstanceId,
                displayLabel: row.configured.locator?.displayLabel ?? source?.descriptor.displayName ?? row.sourceQualifiedId };
            if (row.sourceQualifiedId !== renderSourceQualifiedId(lane.source)) return { kind: 'diagnostic', lane,
                health: { kind: 'failed', failure: { class: 'unsupportedContract', code: 'sourceIdentityMismatch' } } };
            // Native task relations are Account data, not a daemon operation.
            const descriptor = isInternalTaskConfiguredInstanceV1(row.configured) ? INTERNAL_TASK_DESCRIPTOR_V1 : source?.descriptor;
            if (descriptor === undefined) return { kind: 'diagnostic', lane, health: {
                kind: 'failed', failure: { class: 'unsupportedContract', code: 'sessionLinksSourceNotAdmitted' },
            } };
            const requestedKind = input.entryRef?.kindId ?? input.kindId;
            const requestedKinds = descriptor.kinds.map(kind => kind.id).filter(kindId => requestedKind === undefined || requestedKind === kindId);
            if (requestedKinds.length === 0) return { kind: 'diagnostic', lane,
                health: { kind: 'failed', failure: { class: 'unsupportedContract', code: 'sessionLinksKindUnsupported' } } };
            const ownedKinds = source === undefined ? descriptor.sessionRelations?.kindIds ?? [] : sourceRelationKinds(source);
            return { kind: 'ready', row, source, lane, roleKinds: requestedKinds.filter(kindId => ownedKinds.includes(kindId)),
                fallbackKinds: requestedKinds.filter(kindId => !ownedKinds.includes(kindId)) };
        });
    }
    const relations = {
        readSources: readView,
        ownership,
        readScopes,
        async hasCorpusReadDemand(input: RelationSelection) {
            const [{ sources }, scopes] = await Promise.all([readView(input), readScopes(input)]);
            return corpusKindsFor(input, scopes, sources).size > 0 || hasUnscopedSessionDemand(input);
        },
        async findConfiguredInstance(sourceInstanceId: string, entryRef?: TriageEntryRefV1) {
            const { configured } = await readView(entryRef === undefined ? undefined : { entryRef });
            return configured.records.find((record) => record.value.configured.instance.sourceInstanceId === sourceInstanceId) ?? null;
        },
        async write(input: TriageSessionRelationWriteV1): Promise<Readonly<{ status: 'linked' | 'unlinked' | 'conflict' }>
            | Readonly<{ status: 'failed'; failure: PluginError }>> {
            try {
                const { sources, configured } = await readView(input);
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
                    const selected = await selectConfiguredInstance(instances);
                    if (selected === undefined) return failedRelationWrite(instances.length > 1
                        ? 'sessionLinksSourceInstanceRequired' : 'sessionLinksSourceInstanceUnavailable', false);
                    const entry = input.entryRef;
                    const result = TriageSourceLinkSessionResultV1Schema.parse(await context.services.actions.executeAdmittedTargetedOperation(operation, {
                        v: 1, instance: selected.configured,
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
        async read(input: Readonly<{ entryRef?: TriageEntryRefV1; sourceInstanceId?: string; sessionId?: string; sessionIds?: readonly string[]; kindId?: string;
            paged?: boolean; cursor?: string;
            /** Detail preparation requires an authoritative page and preserves the original transport refusal. */
            readFailure?: 'throw' }>, corpusRead?: () => Promise<readonly CorpusSessionLinkRowV1[]>): Promise<TriageReadSourceSessionLinksResultV1> {
            const { sources, configured } = await readView(input);
            const sessionIds = input.sessionIds === undefined ? undefined : new Set(input.sessionIds);
            const links: TriageSourceSessionLinkV1[] = [];
            const lanes: TriageSourceSessionLinksLaneV1[] = [];
            const corpusLanes: TriageSourceSessionLinksLaneV1[] = [];
            const scopes = await readScopes(input);
            const corpusKindsBySource = corpusKindsFor(input, scopes, sources);
            const noSourceScopes = hasNoSessionSourceScopes(input, scopes, sources);
            const instanceRevisions = new Map(configured.records.map((record) => [record.value.configured.instance.sourceInstanceId, record.revision]));
            const instancesById = new Map(configured.rows.map(row => [row.configured.instance.sourceInstanceId, row]));
            const linkIndexes = new Map<string, number>();
            const duplicateInstances = new Map<number, Set<string>>();
            let nextCursor: string | undefined;
            let unknownCorpusCoverage = false;
            function addLink(link: TriageSourceSessionLinkV1) {
                const key = JSON.stringify([entryReferenceComponents(link.entryRef), link.sessionId]);
                const index = linkIndexes.get(key);
                if (index === undefined) { linkIndexes.set(key, links.length); links.push(link); }
                else if (links[index]!.sourceInstanceId !== link.sourceInstanceId) {
                    const candidates = duplicateInstances.get(index) ?? new Set<string>();
                    const existing = links[index]!.sourceInstanceId;
                    if (existing !== undefined) candidates.add(existing);
                    if (link.sourceInstanceId !== undefined) candidates.add(link.sourceInstanceId);
                    duplicateInstances.set(index, candidates);
                    // The relationship is known, but no selected configured
                    // authority is established by an unscoped duplicate.
                    const unqualified = { ...links[index]! };
                    delete unqualified.sourceInstanceId;
                    delete unqualified.sourceInstanceRevision;
                    delete unqualified.sourceInstanceRowId;
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
                const nativeAccountRead = isInternalTaskConfiguredInstanceV1(row.configured);
                if (!nativeAccountRead && (operation === undefined || source?.operations?.linkSession === undefined)) {
                    lanes.push({ ...roleLane, health: { kind: 'failed', failure: { class: 'unsupportedContract', code: 'sessionLinksRolesUnsupported' } } });
                    continue;
                }
                try {
                    const entry = input.entryRef;
                    const sourceInput = {
                        v: 1, instance: row.configured,
                        ...(entry === undefined ? {} : { localRef: { kindId: entry.kindId, collisionScope: entry.collisionScope, entryId: entry.entryId } }),
                        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
                    } as const;
                    const parsed = TriageSourceReadSessionLinksResultV1Schema.safeParse(nativeAccountRead
                        ? await readInternalTaskSessionLinks(sourceInput, context, await readTaskList?.())
                        : await context.services.actions.executeAdmittedTargetedOperation(operation!, sourceInput, options));
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
                    const nativeLinks = result.links.filter(link => sessionIds === undefined || sessionIds.has(link.sessionId)).map(link => ({
                        entryRef: { source: row.configured.instance.source, ...link.localRef },
                        sessionId: link.sessionId, sourceInstanceId: lane.sourceInstanceId,
                        sourceInstanceRevision: instanceRevisions.get(lane.sourceInstanceId),
                        sourceInstanceRowId: row.instanceTag,
                        linkedAtMs: link.linkedAtMs, displayPath: link.displayPath,
                        ...(link.locator === undefined ? {} : { locator: link.locator }),
                    }));
                    const unavailableRefs = new Map<string, TriageEntryRefV1>();
                    for (const ref of [
                        ...(result.kind === 'partial' ? result.unavailableRefs.map(localRef => ({ source: lane.source, ...localRef })) : []),
                    ]) unavailableRefs.set(JSON.stringify(entryReferenceComponents(ref)), ref);
                    lanes.push({ ...roleLane, health: unavailableRefs.size > 0 ? { kind: 'partial', unavailableRefs: [...unavailableRefs.values()] }
                            : { kind: 'complete' } });
                    for (const link of nativeLinks) addLink(link);
                } catch (error) {
                    if (input.readFailure === 'throw') throw isPluginError(error) ? error
                        : new PluginError({ code: 'sessionLinksReadFailed', retryable: true });
                    const requestId = readPluginErrorRequestIdV1(error);
                    const diagnostic = isPluginError(error) ? TriageListInvocationErrorV1Schema.safeParse({
                        code: error.code, retryable: error.retryable,
                        ...(requestId === undefined ? {} : { requestId }),
                    }) : null;
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
                            if (sessionIds !== undefined && !sessionIds.has(link.sessionId)) continue;
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
                            const selected = await selectConfiguredInstance(matchingLanes.flatMap(lane => {
                                const row = instancesById.get(lane.sourceInstanceId);
                                return row === undefined ? [] : [row];
                            }), link.entryRef);
                            addLink({ entryRef: link.entryRef, sessionId: link.sessionId,
                                ...(selected === undefined ? {} : { sourceInstanceId: selected.configured.instance.sourceInstanceId,
                                    sourceInstanceRevision: instanceRevisions.get(selected.configured.instance.sourceInstanceId),
                                    sourceInstanceRowId: selected.instanceTag }),
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
                    const requestId = readPluginErrorRequestIdV1(error);
                    const diagnostic = isPluginError(error) ? TriageListInvocationErrorV1Schema.safeParse({
                        code: error.code, retryable: error.retryable,
                        ...(requestId === undefined ? {} : { requestId }),
                    }) : null;
                    for (const lane of corpusLanes) lanes[lanes.indexOf(lane)] = { ...lane,
                        health: { kind: 'failed', failure: { class: 'transient', code: 'sessionLinksReadFailed' },
                            ...(diagnostic?.success ? { invocationError: diagnostic.data } : {}),
                        } };
                }
            }
            for (const [index, candidates] of duplicateInstances) {
                const selected = await selectConfiguredInstance([...candidates].flatMap(id => {
                    const row = instancesById.get(id);
                    return row === undefined ? [] : [row];
                }), links[index]!.entryRef);
                if (selected !== undefined) links[index] = { ...links[index]!, sourceInstanceId: selected.configured.instance.sourceInstanceId,
                    sourceInstanceRevision: instanceRevisions.get(selected.configured.instance.sourceInstanceId), sourceInstanceRowId: selected.instanceTag };
            }
            let complete = 0;
            for (const [index, lane] of lanes.entries()) {
                if (lane.kindIds !== undefined && lane.health.kind === 'complete') complete++;
                if (context.invocationId !== undefined && lane.health.kind === 'failed' && lane.health.invocationError?.requestId === undefined) {
                    // A setup refusal has no source invocation; correlate the host's real read instead.
                    lanes[index] = { ...lane, health: { ...lane.health, invocationError: {
                        code: lane.health.failure.code, ...lane.health.invocationError, requestId: context.invocationId,
                    } } };
                }
            }
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
            if (input.readFailure === 'throw' && result.nextCursor === undefined && (result.kind === 'failed'
                || unknownCorpusCoverage || lanes.some(lane => lane.health.kind === 'failed' || lane.health.kind === 'unavailable'))) {
                const health = lanes.find(lane => lane.health.kind === 'failed')?.health;
                throw new PluginError(health?.kind === 'failed'
                    ? { code: health.failure.code, retryable: health.failure.class === 'transient',
                        ...(health.failure.requestId === undefined ? {} : { details: { requestId: health.failure.requestId } }) }
                    : { code: 'sessionLinksReadFailed', retryable: true });
            }
            return result;
        },
    };
    return { ...relations,
        readSessions(sessionIds: readonly string[]) {
            return relations.read({ sessionIds }, () => readTriageSessionLinksForSessionsV1(collections.sessionLinks, sessionIds, options));
        },
        async readEntries(entries: readonly Readonly<{ entryRef: TriageEntryRefV1; sourceInstanceId?: string }>[]) {
            const { sources } = await readView();
            const taskInstanceId = INTERNAL_TASK_SOURCE_RECORD_V1.value.configured.instance.sourceInstanceId;
            const taskSelections = new Set(entries.filter(selection => isInternalTaskReferenceV1(selection.entryRef)
                && (selection.sourceInstanceId === undefined || selection.sourceInstanceId === taskInstanceId)));
            // The built-in source already owns an Account-wide task/link read.
            // Admit it once for the set; never turn its rows into exact task reads.
            const taskResult = taskSelections.size === 0 ? undefined
                : await relations.read({ sourceInstanceId: taskInstanceId, kindId: 'task' }).catch((): TriageReadSourceSessionLinksResultV1 => ({ kind: 'failed', links: [] }));
            const entryKey = (entry: TriageEntryRefV1) => JSON.stringify(entryReferenceComponents(entry));
            const taskLinks = new Map<string, TriageSourceSessionLinkV1[]>();
            for (const link of taskResult?.links ?? []) {
                const key = entryKey(link.entryRef);
                const existing = taskLinks.get(key);
                if (existing === undefined) taskLinks.set(key, [link]);
                else existing.push(link);
            }
            const unavailableTasks = new Set(taskResult?.lanes?.flatMap(lane => lane.health.kind === 'partial'
                ? lane.health.unavailableRefs.map(entryKey) : []));
            const demands = await Promise.all(entries.filter(selection => !taskSelections.has(selection)).map(async selection => ({ selection,
                corpus: corpusKindsFor(selection, await readScopes(selection), sources).size > 0,
            })));
            // Other source-owned roles retain exact selected-entry demand;
            // corpus-owned relations use their existing indexed set read.
            let corpusRead: Promise<ReadonlyMap<string, readonly CorpusSessionLinkRowV1[]>> | undefined;
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
            return await Promise.all(entries.map(async selection => {
                if (taskSelections.has(selection) && taskResult !== undefined) {
                    const key = entryKey(selection.entryRef);
                    const lanes = taskResult.lanes?.map(lane => lane.health.kind !== 'partial' ? lane : { ...lane,
                        health: unavailableTasks.has(key) ? { kind: 'partial' as const, unavailableRefs: [selection.entryRef] }
                            : { kind: 'complete' as const } });
                    const result: TriageReadSourceSessionLinksResultV1 = { ...taskResult,
                        kind: taskResult.kind === 'partial' && lanes?.every(lane => lane.health.kind === 'complete') ? 'complete' : taskResult.kind,
                        links: taskLinks.get(key) ?? [], ...(lanes === undefined ? {} : { lanes }) };
                    return { ...selection, result };
                }
                let result: TriageReadSourceSessionLinksResultV1;
                try { result = await relations.read(selection, async () => (await readCorpus()).get(entryKey(selection.entryRef)) ?? []); }
                catch { result = { kind: 'failed', links: [] }; }
                return { ...selection, result };
            }));
        },
    };
}
