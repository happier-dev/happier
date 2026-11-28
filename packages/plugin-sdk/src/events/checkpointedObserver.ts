/** @moduleRealm daemon */
import type { PluginActionInputById, PluginActionResultById } from '../actions/index.js';
import type { BackgroundServiceContext } from '../backgroundServices.js';
import { admitPluginEventObservationUnderScopeV1, readCurrentSourceDefinitions, readPluginEventFailureV1, reportPluginEventSourceCatalogStatus, reportPluginEventSourceStatus, type CurrentSourceCatalog, type PluginEventAdmissionScope, type PluginEventDispositionV1, type PluginEventObservationV1 } from '../eventAutomation.js';
import { arePluginMachineMaterializationRefsEqual } from '../executionOrigin.js';
import { createCanonicalJsonSigningInput } from '../identity.js';
import type { PluginInvocationContext } from '../invocation.js';
import type { Disposable } from '../lifecycle.js';
import type { HostEventEnvelope } from '../events.js';

export type PluginCheckpointedEventSourceDefinitionV1 = Extract<
    PluginActionResultById['automation.event.sources.list'], { kind: 'page' }
>['definitions'][number];

export type PluginCheckpointedEventSourceCatalogV1 = CurrentSourceCatalog;

/** The same strict pager used by observer adoption and admission, for finite recovery Actions. */
export async function readCheckpointedPluginEventSourcesV1(
    context: PluginInvocationContext,
): Promise<PluginCheckpointedEventSourceCatalogV1 | null> {
    return readCurrentSourceDefinitions(context, { kind: 'checkpointedPull' });
}

export type PluginCheckpointedEventAttemptContextV1<TSource> = Readonly<{
    context: BackgroundServiceContext;
    definition: PluginCheckpointedEventSourceDefinitionV1;
    definitions: readonly PluginCheckpointedEventSourceDefinitionV1[];
    source: TSource;
    /** Local cancellation for this admitted finite cycle; new definitions apply next cycle. */
    isCurrent(): Promise<boolean>;
}>;

export type PluginCheckpointedEventAttemptResultV1<TCheckpoint> = Readonly<{
    observations: readonly PluginEventObservationV1[];
    /** Opaque provider-owned cursor/CAS witness; the SDK never changes its format. */
    checkpoint?: TCheckpoint;
    complete: boolean;
    /** Provider/configuration-owned eligibility; null waits for an authenticated wake. */
    nextEligibleAt: number | null;
    /** Finite provider classification, projected through the existing source-status owner. */
    status?: Pick<Extract<PluginActionInputById['automation.event.source.status.report'], { kind: 'source' }>, 'state' | 'code'>;
}>;

export type PluginCheckpointedEventSourceAdapterV1<TSource, TCheckpoint> = Readonly<{
    decode(definition: PluginCheckpointedEventSourceDefinitionV1): TSource | null;
    observe(input: PluginCheckpointedEventAttemptContextV1<TSource>): Promise<PluginCheckpointedEventAttemptResultV1<TCheckpoint>>;
    /** Continue advancing provider deadlines during admission; observe must preserve the retained candidate until save. */
    observeWhileAdmissionPending?: boolean;
    /** Set only when a recurring observation intentionally shares the first occurrence's ID after local history is cleared. */
    checkpointOnOccurrenceConflict?: true;
    save(input: PluginCheckpointedEventAttemptContextV1<TSource> & Readonly<{
        checkpoint: TCheckpoint;
        /** Supplied after all observations are safe and this admitted cycle was not cancelled. */
        disposition?: PluginEventDispositionV1;
    }>): Promise<void>;
    /** Finite provider-owned cursor retirement using the host's existing classification. */
    retire?(input: Readonly<{ context: BackgroundServiceContext; definitions: readonly PluginCheckpointedEventSourceDefinitionV1[]; revision: string; isCurrent(): Promise<boolean> }>): Promise<Readonly<{ complete: boolean }>>;
    retryAt(input: Readonly<{ error: unknown; now: number; definition?: PluginCheckpointedEventSourceDefinitionV1 }>): number | null;
    /** Only an already authenticated provider ingress may supply this wake. */
    subscribeWake?(wake: (sourceInstanceId?: string) => Promise<void>): Disposable;
}>;

export type PluginCheckpointedEventObserverOptionsV1<TSource, TCheckpoint> = Readonly<{
    context: BackgroundServiceContext;
    source: PluginCheckpointedEventSourceAdapterV1<TSource, TCheckpoint>;
    mode?: 'once' | 'continuous';
    now?: () => number;
    sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
    transportKinds?: readonly ('checkpointedPull' | 'durablePush')[];
}>;

export type PluginCheckpointedEventAttemptProcessingV1 = Readonly<{
    context: PluginInvocationContext;
    definitions: readonly PluginCheckpointedEventSourceDefinitionV1[];
    observations: readonly PluginEventObservationV1[];
    complete: boolean;
    isCurrent(): Promise<boolean>;
    save(disposition: PluginEventDispositionV1): Promise<void>;
}>;

/**
 * Finite half of the runner, also used inside GitHub's existing Account-bound
 * target Action so credential, notice and cursor custody never escapes that Action.
 */
export async function processCheckpointedPluginEventAttemptV1(
    input: PluginCheckpointedEventAttemptProcessingV1,
): Promise<PluginEventDispositionV1> {
    return processCheckpointedAttempt(input);
}

async function processCheckpointedAttempt(
    input: PluginCheckpointedEventAttemptProcessingV1,
    pendingObservations?: Set<string>,
    checkpointOnOccurrenceConflict?: true,
): Promise<PluginEventDispositionV1> {
    const admissions: NonNullable<PluginEventDispositionV1['admissions']>[number][] = [];
    input.context.signal.throwIfAborted();
    if (!(await input.isCurrent())) return { kind: 'unsettled', admissions };
    for (const observation of input.observations) {
        input.context.signal.throwIfAborted();
        const matching = input.definitions.filter(definition => (
            definition.eventRef.pluginId === observation.eventRef.pluginId
            && definition.eventRef.localId === observation.eventRef.localId
            && definition.sourceInstanceId === observation.sourceInstanceId
            && definition.sourceContractVersion === observation.sourceContractVersion
        ));
        if (matching.length === 0) return { kind: 'unsettled', admissions };
        const occurrenceKey = JSON.stringify([observation.eventRef.localId, observation.occurrenceId]);
        const accountedObservation = pendingObservations?.has(occurrenceKey)
            ? { ...observation, observedDelta: 0 as const } : observation;
        const scopes = new Map<string, PluginEventAdmissionScope>();
        for (const definition of matching) {
            const transport = definition.observationTransport;
            if (transport.kind === 'socket') return { kind: 'unsettled', admissions };
            const scope: PluginEventAdmissionScope = transport.kind === 'durablePush'
                ? { kind: 'durablePush', webhookEndpointId: transport.webhookEndpointId }
                : { kind: 'checkpointedPull' };
            scopes.set(JSON.stringify(scope), scope);
        }
        for (const scope of scopes.values()) {
            pendingObservations?.add(occurrenceKey);
            const disposition = await admitPluginEventObservationUnderScopeV1(accountedObservation, input.context, scope, matching, {
                reportCatalogCurrent: false, checkpointOnOccurrenceConflict,
            });
            if (disposition.admissions !== undefined) admissions.push(...disposition.admissions);
            if (disposition.kind !== 'checkpointSafe') return { ...disposition, admissions };
        }
    }
    input.context.signal.throwIfAborted();
    if (!input.complete) return { kind: 'unsettled', admissions };
    input.context.signal.throwIfAborted();
    const disposition: PluginEventDispositionV1 = { kind: 'checkpointSafe', admissions };
    await input.save(disposition);
    input.context.signal.throwIfAborted();
    return disposition;
}

type ObserverSourceState = {
    nextEligibleAt: number | null | undefined;
    status?: NonNullable<PluginCheckpointedEventAttemptResultV1<unknown>['status']>;
};

type ObserverState = {
    catalogs: Map<string, CurrentSourceCatalog>;
    sources: Map<string, ObserverSourceState>;
    pendingObservations: Map<string, Set<string>>;
    retiredRevision: string | null;
    owner: string | null;
    adoptedRevision: string | null;
    reconciliationStartedAt: number | null;
};

function assignment(definition: PluginCheckpointedEventSourceDefinitionV1) {
    return definition.observationTransport.kind === 'durablePush'
        ? definition.observationTransport.endpointMaterializationRef
        : definition.observationTransport.watcherMaterializationRef;
}

function sourceKey(definition: PluginCheckpointedEventSourceDefinitionV1): string {
    return createCanonicalJsonSigningInput({ pluginId: definition.eventRef.pluginId, sourceInstanceId: definition.sourceInstanceId,
        sourceContractVersion: definition.sourceContractVersion, sourceConfig: definition.sourceConfig,
        materialization: assignment(definition) });
}

function eligibility(value: number | null): number | null {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new RangeError('Event source eligibility must be an absolute timestamp or null');
    return value;
}

async function sleepUntilEligible(delayMs: number, signal: AbortSignal): Promise<void> {
    const deadline = Math.min(Number.MAX_SAFE_INTEGER, Date.now() + delayMs);
    while (!signal.aborted) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return;
        await new Promise<void>(resolve => {
            // A signed-int32 timer segment preserves long provider deadlines;
            // passing a longer duration directly makes Node fire after 1ms.
            const timer = setTimeout(done, Math.min(remaining, 2_147_483_647));
            function done() {
                clearTimeout(timer);
                signal.removeEventListener('abort', done);
                resolve();
            }
            signal.addEventListener('abort', done, { once: true });
            if (signal.aborted) done();
        });
    }
}

/** One host-owned lifecycle and wake for all currently assigned provider sources. */
export async function runCheckpointedPluginEventObserverV1<TSource, TCheckpoint>(
    input: PluginCheckpointedEventObserverOptionsV1<TSource, TCheckpoint>,
): Promise<void> {
    const { context, source } = input;
    const now = input.now ?? Date.now;
    const sleep = input.sleep ?? sleepUntilEligible;
    const transports: readonly ('checkpointedPull' | 'durablePush')[] = input.transportKinds ?? ['checkpointedPull'];
    const own = context.materialization;
    const ownKey = own === undefined ? null : JSON.stringify(own);
    const state: ObserverState = { catalogs: new Map(), sources: new Map(), pendingObservations: new Map(), retiredRevision: null, owner: null,
        adoptedRevision: null, reconciliationStartedAt: null };
    let assignedSources: {
        definitions: readonly PluginCheckpointedEventSourceDefinitionV1[];
        groups: Map<string, PluginCheckpointedEventSourceDefinitionV1[]>;
    } | undefined;
    // Admission can await a person's approval. Keep its original candidate in
    // custody while the same source's advancing provider schedule keeps running.
    const admitting = new Map<string, {
        context: PluginCheckpointedEventAttemptContextV1<TSource>;
        result: PluginCheckpointedEventAttemptResultV1<TCheckpoint>;
        nextEligibleAt: number | null;
        outcome?: { disposition: PluginEventDispositionV1 } | { error: unknown };
    }>();
    let changed = false;
    let definitionsInvalidated = true;
    let catalogRefresh: PluginActionInputById['automation.event.sources.list']['catalogRefresh'] = { kind: 'refresh' };
    let catalogReadController: AbortController | undefined;
    // Only acknowledged zero-delta status is retained. Provider polling is
    // liveness; equal successful scans are not durable status changes.
    const reportedStatuses = new Map<string, string>();
    const statusKey = (definition: PluginCheckpointedEventSourceDefinitionV1) =>
        createCanonicalJsonSigningInput({ automationId: definition.automationId, triggerId: definition.triggerId });
    let wake: (() => void) | undefined;
    let pendingWake: Readonly<{ promise: Promise<void>; resolve(): void; reject(error: unknown): void }> | undefined;
    const wokenSources = new Set<string | undefined>();
    const invalidated = (event: HostEventEnvelope<'@happier/automation/event-sources-invalidated'>) => {
        // Scoped to other plugins' definitions (their availability/webhook change): nothing here changed.
        if (event.payload.pluginIds !== undefined && !event.payload.pluginIds.includes(context.plugin.id)) return;
        if (event.payload.definitionsChanged !== false) {
            definitionsInvalidated = true;
            catalogRefresh = { kind: 'refresh' };
            catalogReadController?.abort();
        }
        changed = true;
        // Credential/endpoint changes can unpark an unavailable source. They
        // do not shorten an unchanged source's numeric provider deadline;
        // changed configuration/assignment naturally creates a new key.
        for (const source of state.sources.values()) if (source.nextEligibleAt === null) source.nextEligibleAt = undefined;
        wake?.();
    };
    const hostSubscription = context.services.events.host.subscribe({ eventId: '@happier/automation/event-sources-invalidated', scope: { kind: 'account' } }, invalidated);
    let providerSubscription: Disposable | undefined;
    try {
        providerSubscription = source.subscribeWake?.(sourceInstanceId => {
        wokenSources.add(sourceInstanceId);
        if (pendingWake === undefined) {
            let resolve!: () => void;
            let reject!: (error: unknown) => void;
            const promise = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
            pendingWake = { promise, resolve, reject };
        }
        wake?.();
        return pendingWake.promise;
        });
        do {
            changed = false;
            const refreshDefinitions = definitionsInvalidated;
            definitionsInvalidated = false;
            const cycleWake = pendingWake;
            pendingWake = undefined;
            const requestedSources = new Set(wokenSources);
            wokenSources.clear();
            const cycleContext = context;
            let wakeAt: number | null = null;
            let catalogFailed = false;
            try {
                let revision: string | undefined;
                const reportCatalog = async (observedRevision: string, knownDefinitions: readonly PluginCheckpointedEventSourceDefinitionV1[], current: boolean) => {
                    if (!current) state.reconciliationStartedAt ??= now();
                    const scopes = new Map<string, PluginEventAdmissionScope>();
                    if (transports.includes('checkpointedPull')) scopes.set('checkpointedPull', { kind: 'checkpointedPull' });
                    for (const definition of knownDefinitions) if (definition.observationTransport.kind === 'durablePush') {
                        const webhookEndpointId = definition.observationTransport.webhookEndpointId;
                        scopes.set(webhookEndpointId, { kind: 'durablePush', webhookEndpointId });
                    }
                    for (const scope of scopes.values()) await reportPluginEventSourceCatalogStatus(cycleContext, {
                        kind: 'catalogReconciliation', scope, observedRevision, adoptedRevision: state.adoptedRevision,
                        state: current ? 'current' : 'reconciling',
                        scanStartedAt: current ? null : state.reconciliationStartedAt,
                        nextRetryAt: current ? null : eligibility(source.retryAt({ error: new Error('Event source catalog is reconciling'), now: now() })),
                    });
                };
                try {
                    let readContext: BackgroundServiceContext | undefined;
                    for (const kind of transports) {
                        const adopted = state.catalogs.get(kind);
                        let catalog = adopted;
                        if (refreshDefinitions || catalog === undefined) {
                            if (readContext === undefined) {
                                catalogReadController = new AbortController();
                                readContext = { ...cycleContext, signal: AbortSignal.any([cycleContext.signal, catalogReadController.signal]) };
                            }
                            const read = await readCurrentSourceDefinitions(readContext, { kind }, adopted, async (observedRevision, pageDefinitions) => {
                                if (state.retiredRevision !== observedRevision) await reportCatalog(observedRevision, pageDefinitions, false);
                            }, catalogRefresh);
                            if (read === null) throw new Error('Event source catalog is not current');
                            catalog = read;
                        }
                        if (revision !== undefined && catalog.revision !== revision) throw new Error('Event source catalog is not current');
                        revision = catalog.revision;
                        if (catalog !== adopted) {
                            state.catalogs.set(kind, catalog);
                            assignedSources = undefined;
                        }
                    }
                } catch (error) {
                    definitionsInvalidated = true;
                    catalogFailed = true;
                    throw error;
                } finally {
                    catalogReadController = undefined;
                }
                const currentRevision = revision;
                if (currentRevision === undefined) throw new Error('Event observer requires a source transport');
                state.adoptedRevision = currentRevision;
                if (assignedSources === undefined) {
                    const definitions = [...state.catalogs.values()].flatMap(catalog => catalog.definitions);
                    const groups = new Map<string, PluginCheckpointedEventSourceDefinitionV1[]>();
                    if (own?.pluginId === context.plugin.id) {
                        for (const definition of definitions) {
                            if (definition.eventRef.pluginId !== context.plugin.id || !arePluginMachineMaterializationRefsEqual(own, assignment(definition))) continue;
                            const key = sourceKey(definition);
                            const group = groups.get(key);
                            if (group) group.push(definition);
                            else groups.set(key, [definition]);
                        }
                    }
                    assignedSources = { definitions, groups };
                }
                const { definitions, groups } = assignedSources;
                if (refreshDefinitions) {
                    const currentStatusKeys = new Set(definitions.map(statusKey));
                    for (const key of reportedStatuses.keys()) if (!currentStatusKeys.has(key)) reportedStatuses.delete(key);
                }
                const isCurrent = async () => !cycleContext.signal.aborted;
                for (const key of state.sources.keys()) if (!groups.has(key)) {
                    state.sources.delete(key);
                }
                for (const key of state.pendingObservations.keys()) if (!groups.has(key)) state.pendingObservations.delete(key);
                for (const key of admitting.keys()) if (!groups.has(key)) admitting.delete(key);
                const canRetire = ownKey !== null && own?.pluginId === context.plugin.id
                    && (groups.size > 0 || state.owner === ownKey || definitions.length === 0);
                if (canRetire && state.retiredRevision !== currentRevision && source.retire !== undefined && await isCurrent()) {
                    const retirement = await source.retire({ context: cycleContext, definitions, revision: currentRevision, isCurrent });
                    if (retirement.complete) state.retiredRevision = currentRevision;
                    else wakeAt = eligibility(source.retryAt({ error: new Error('Event checkpoint retirement is incomplete'), now: now() }));
                }
                if (source.retire === undefined || !canRetire) state.retiredRevision = currentRevision;
                if (state.retiredRevision === currentRevision && state.reconciliationStartedAt !== null && await isCurrent()) {
                    await reportCatalog(currentRevision, definitions, true);
                    state.reconciliationStartedAt = null;
                }
                if (groups.size > 0) state.owner = ownKey;
                for (const [key, group] of groups) {
                    cycleContext.signal.throwIfAborted();
                    const definition = group[0]!;
                    const sourceState: ObserverSourceState = state.sources.get(key) ?? { nextEligibleAt: undefined };
                    state.sources.set(key, sourceState);
                    const requested = requestedSources.has(undefined) || requestedSources.has(definition.sourceInstanceId);
                    const reportSource = async (status: NonNullable<PluginCheckpointedEventAttemptResultV1<TCheckpoint>['status']>, nextRetryAt: number | null) => {
                        sourceState.status = status;
                        for (const member of group) {
                            const report = {
                                kind: 'source', automationId: member.automationId, triggerId: member.triggerId, triggerRevision: member.triggerRevision,
                                eventRef: member.eventRef, sourceSelectorId: member.sourceSelectorId, ...status,
                                nextRetryAt: status.state === 'observing' ? null : nextRetryAt,
                                observedDelta: 0, admittedDelta: 0, skippedDelta: 0,
                            } satisfies PluginActionInputById['automation.event.source.status.report'];
                            const key = statusKey(member);
                            const signature = createCanonicalJsonSigningInput(report);
                            if (reportedStatuses.get(key) === signature) continue;
                            if (await reportPluginEventSourceStatus(cycleContext, report)) reportedStatuses.set(key, signature);
                        }
                    };
                    const finish = async (result: PluginCheckpointedEventAttemptResultV1<TCheckpoint>, disposition: PluginEventDispositionV1,
                        reportedEligibleAt: number | null) => {
                        if (disposition.kind === 'checkpointSafe') state.pendingObservations.delete(key);
                        reportedEligibleAt = disposition.failure?.retryable === false ? null : eligibility(reportedEligibleAt);
                        // An unsettled admission retries on the source's own backoff, never
                        // sooner: a replaying source may report a probe deadline it did not advance.
                        const failureRetryAt = disposition.failure === undefined || reportedEligibleAt === null ? null
                            : eligibility(source.retryAt({ error: Object.assign(new Error(disposition.failure.code), { code: disposition.failure.code }),
                                now: now(), definition }));
                        const nextEligibleAt = disposition.failure === undefined || reportedEligibleAt === null ? reportedEligibleAt
                            : failureRetryAt === null ? null : Math.max(failureRetryAt, reportedEligibleAt);
                        sourceState.nextEligibleAt = nextEligibleAt;
                        if (disposition.failure !== undefined && nextEligibleAt !== null) {
                            await reportSource({ state: 'backingOff', code: disposition.failure.code }, nextEligibleAt);
                        } else if (disposition.failure === undefined && result.status !== undefined) await reportSource(result.status, nextEligibleAt);
                        else if (result.observations.length === 0 && disposition.kind === 'checkpointSafe') await reportSource({ state: 'observing', code: 'none' }, null);
                    };
                    try {
                        const completed = admitting.get(key);
                        if (completed?.outcome !== undefined) {
                            admitting.delete(key);
                            if ('error' in completed.outcome) throw completed.outcome.error;
                            const disposition = completed.outcome.disposition;
                            // The runner serializes checkpoint effects with observations;
                            // an approval callback never writes or retires a newer cursor.
                            if (disposition.kind === 'checkpointSafe' && completed.result.checkpoint !== undefined) {
                                cycleContext.signal.throwIfAborted();
                                await source.save({ ...completed.context, checkpoint: completed.result.checkpoint, disposition });
                            }
                            await finish(completed.result, disposition, completed.nextEligibleAt);
                            continue;
                        }
                        const next = sourceState.nextEligibleAt;
                        if (!requested && (next === null || (next !== undefined && next > now()))) {
                            // A new subscriber inherits this source's last produced status;
                            // per-member acknowledgement signatures only suppress equal writes.
                            if (sourceState.status) await reportSource(sourceState.status, next);
                            continue;
                        }
                        const decoded = source.decode(definition);
                        if (decoded === null) {
                            // A retained group can adopt a definition the adapter cannot consume.
                            // Its old deadline cannot make that definition eligible.
                            sourceState.nextEligibleAt = null;
                            continue;
                        }
                        if (!(await isCurrent())) continue;
                        const attemptContext: PluginCheckpointedEventAttemptContextV1<TSource> = { context: cycleContext, definition, definitions: group, source: decoded, isCurrent };
                        const startedAt = now();
                        const result = await source.observe(attemptContext);
                        cycleContext.signal.throwIfAborted();
                        // Admission publishes its own observation/counter status. The
                        // next empty scan must reconcile against that publication.
                        if (result.observations.length > 0) {
                            delete sourceState.status;
                            for (const member of group) reportedStatuses.delete(statusKey(member));
                        }
                        const retained = admitting.get(key);
                        if (retained !== undefined) {
                            retained.nextEligibleAt = eligibility(result.nextEligibleAt);
                            // A buffered cursor can request an immediate drain without
                            // advancing while admission is pending. Its settlement or an
                            // authenticated wake releases that work; never hot-loop it.
                            sourceState.nextEligibleAt = retained.nextEligibleAt !== null && retained.nextEligibleAt > startedAt
                                ? retained.nextEligibleAt : null;
                            continue;
                        }
                        let pending = state.pendingObservations.get(key);
                        if (pending === undefined && result.observations.length > 0) {
                            pending = new Set(); state.pendingObservations.set(key, pending);
                        }
                        const detached = input.mode !== 'once' && source.observeWhileAdmissionPending === true && result.observations.length > 0;
                        const processing = processCheckpointedAttempt({ context: cycleContext, definitions: group, observations: result.observations, complete: result.complete,
                            isCurrent, save: async disposition => {
                                if (!detached && result.checkpoint !== undefined) await source.save({ ...attemptContext, checkpoint: result.checkpoint, disposition });
                            } }, pending, source.checkpointOnOccurrenceConflict);
                        if (detached) {
                            const attempt: NonNullable<ReturnType<typeof admitting.get>> = { context: attemptContext, result,
                                nextEligibleAt: eligibility(result.nextEligibleAt) };
                            admitting.set(key, attempt);
                            sourceState.nextEligibleAt = attempt.nextEligibleAt !== null && attempt.nextEligibleAt > startedAt
                                ? attempt.nextEligibleAt : null;
                            const settled = () => {
                                if (admitting.get(key) !== attempt || context.signal.aborted) return;
                                changed = true;
                                wake?.();
                            };
                            void processing.then(disposition => { attempt.outcome = { disposition }; settled(); },
                                error => { attempt.outcome = { error }; settled(); });
                        } else {
                            const disposition = await processing;
                            let nextEligibleAt = result.nextEligibleAt;
                            // An unfinished scan without observations cannot use a deadline
                            // already consumed when it started to request another immediate scan.
                            if (input.mode !== 'once' && !result.complete && result.observations.length === 0
                                && nextEligibleAt !== null && nextEligibleAt <= startedAt) {
                                eligibility(nextEligibleAt);
                                const retryFrom = now();
                                const retryAt = eligibility(source.retryAt({
                                    error: new Error('Event source returned an elapsed eligibility deadline'), now: retryFrom, definition,
                                }));
                                nextEligibleAt = retryAt !== null && retryAt > retryFrom ? retryAt : null;
                            }
                            await finish(result, disposition, nextEligibleAt);
                        }
                    } catch (error) {
                        if (cycleContext.signal.aborted) throw error;
                        const nextEligibleAt = eligibility(source.retryAt({ error, now: now(), definition }));
                        sourceState.nextEligibleAt = nextEligibleAt;
                        await reportSource({ state: nextEligibleAt === null ? 'attention' : 'backingOff', code: readPluginEventFailureV1(error).code }, nextEligibleAt);
                    }
                }
                for (const { nextEligibleAt: next } of state.sources.values())
                    if (next !== undefined && next !== null && (wakeAt === null || next < wakeAt)) wakeAt = next;
                cycleWake?.resolve();
            } catch (error) {
                cycleWake?.reject(error);
                if (context.signal.aborted) {
                    if (input.mode === 'once') context.signal.throwIfAborted();
                    return;
                }
                if (!changed) {
                    const retryAt = eligibility(source.retryAt({ error, now: now() }));
                    if (catalogFailed && retryAt !== null && input.mode !== 'once') {
                        // The host coalesces subscribers, but not every Action
                        // transport holds a read until its retry deadline. Always
                        // reach our wait before issuing the retry. A deadline
                        // already consumed by a retry is not a future wake;
                        // park until invalidation rather than spin at delay zero.
                        const expiredRetry = catalogRefresh?.kind === 'retry' && retryAt <= now();
                        catalogRefresh = { kind: 'retry', retryAt };
                        wakeAt = expiredRetry ? null : retryAt;
                    } else wakeAt = retryAt;
                }
            }
            if (input.mode === 'once' || context.signal.aborted) return;
            if (changed || pendingWake !== undefined) continue;
            await new Promise<void>((resolve, reject) => {
                const waiting = wakeAt === null ? undefined : new AbortController();
                const cleanup = () => {
                    context.signal.removeEventListener('abort', done);
                    wake = undefined;
                };
                const done = () => {
                    cleanup();
                    waiting?.abort();
                    resolve();
                };
                wake = done;
                context.signal.addEventListener('abort', done, { once: true });
                if (wakeAt !== null && waiting !== undefined) void sleep(Math.max(0, wakeAt - now()), waiting.signal).then(() => {
                    if (waiting.signal.aborted) return;
                    cleanup();
                    resolve();
                }, error => {
                    if (waiting.signal.aborted) return;
                    cleanup();
                    reject(error);
                });
                if (context.signal.aborted || changed || pendingWake !== undefined) done();
            });
        } while (!context.signal.aborted);
    } finally {
        admitting.clear();
        pendingWake?.reject(context.signal.reason ?? new Error('Event observer retired'));
        await providerSubscription?.dispose();
        await hostSubscription.dispose();
    }
}
