// Initialize the public schema root before the host testkit's current eager catalog assertion.
// This is not a mock or a production fix for the catalog TDZ reported to Coordination.
import '@happier-dev/protocol';
import { createTestResourceInvocationContext } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it, vi } from 'vitest';
import { PluginError, type Disposable, type PluginContributionRef } from '@happier-dev/plugin-sdk';
import type { AdmittedTargetedOperationIdentity } from '@happier-dev/plugin-sdk/actions';
import type { PluginDynamicResourceInvocationOptionsV1, ResourcesService } from '@happier-dev/plugin-sdk/resources';
import { SessionPullRequestWatchReadResultV1Schema } from '@happier-dev/channels-protocol/v1';
import { SessionPullRequestStatusResourceResultV1Schema, TriagePullRequestStatusV1Schema,
    TriageSourceCredentialInputsV1, TriageSourceReadSessionLinksResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';

import { TriageReadSourceSessionLinksResultV1Schema } from '../actions/sessionLinksProtocol.js';
import { TriageReobserveEntryInputV1Schema } from '../actions/reobserveEntryProtocol.js';
import { createTriageReadPullRequestStatusActionHandler, createTriageReadPullRequestStatusObserver } from '../actions/readPullRequestStatus.js';
import type { TriageDataActionContext } from '../actions/dataContext.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import { CORPUS_SOURCE_INSTANCES_COLLECTION_ID, CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import type { PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk/collections';
import { TESTKIT_SOURCE_INSTANCE_ID, testkitEntryRef, testkitLocator } from '../corpus/testkit/observations.test-support.js';
import { TRIAGE_SESSION_PULL_REQUEST_STATUS_RESOURCE_RUNTIME as runtime } from './sessionPullRequestResource.js';
import { createTriageSourceSessionRelations } from './sourceSessionRelations.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';

const url = 'https://github.com/example/repository/pull/17';
const entryRef = testkitEntryRef();
const locator = testkitLocator({ webUrl: url });
const failure = { class: 'permission', code: 'credentialsExpired' } as const;

function status(observedAtMs: number, headRevision = 'sha-one') {
    return TriagePullRequestStatusV1Schema.parse({ kind: 'status', observedAtMs,
        checks: { state: 'complete', passed: 1, failed: 0, pending: 0, total: 1, incomplete: false,
            rows: [{ id: 'check:1', name: 'Tests', state: 'passed' }] },
        review: null, merge: null, branch: { head: 'feature', base: 'main', headRevision }, facts: [],
    });
}

function metadata(revision = 1) {
    return SessionPullRequestWatchReadResultV1Schema.parse({ kind: 'ready', sessionId: 'session-a', bindings: [{
        bindingId: 'binding-a', revision,
        link: { provider: 'github', repository: 'example/repository', number: 17, url },
        watch: { policy: { mode: 'notify', archiveAfterMerge: false }, reason: null,
            fixAttemptLimit: 3, roundsStarted: 0, watchingMachine: null }, latestUpdate: null,
    }] });
}

function relations(revision = 1) {
    return TriageReadSourceSessionLinksResultV1Schema.parse({ kind: 'complete', links: [{ entryRef,
        sessionId: 'session-a', sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID, sourceInstanceRevision: revision,
        locator, linkedAtMs: 1, displayPath: 'Display text is not a routing identity',
    }], lanes: [] });
}

/** Actions and Resource bytes are real host transport boundaries; domain admission/reconciliation stays real. */
function boundary(settings: { nativeObserverUnavailable?: boolean; metadataObserverUnavailable?: boolean;
    observeInitially?: boolean;
    readRelations?: () => Promise<ReturnType<typeof relations>>;
    accountStorage?: PluginDynamicResourceInvocationOptionsV1['accountStorage'];
    metadataAttachment?: Promise<Disposable>; relationObserverUnavailable?: boolean; relationAttachment?: Promise<Disposable>;
    nativeDispose?: () => Promise<void>; relationDispose?: () => Promise<void>;
    bindActions?: (options: PluginDynamicResourceInvocationOptionsV1, retire: () => void) => Pick<PluginDynamicResourceInvocationOptionsV1, 'readAction' | 'observeAction'>;
    context?: PluginDynamicResourceInvocationOptionsV1['context'] } = {}) {
    let watch = metadata();
    let links = relations();
    let native: unknown = status(100);
    let nativeReads = 0;
    let nativeObservations = 0;
    let invalidations = 0;
    let metadataReads = 0;
    let relationReads = 0;
    let nativeInput: unknown;
    const observers = new Map<string, Set<() => void>>();
    let relationChanged: (() => void) | undefined;
    const controller = new AbortController();
    const resources: ResourcesService = {
        describe() { throw new Error('No descriptor demand'); },
        async read(id) {
            if (id !== 'session-links-v1') throw new PluginError({
                code: 'plugin_resource_not_found', message: 'Own-plugin Resources are addressed by declared local id',
            });
            relationReads += 1;
            return { kind: 'config', contentType: 'application/json', digest: 'relations', bytes: new TextEncoder().encode(JSON.stringify(
                settings.readRelations ? await settings.readRelations() : links)) };
        },
        async watch(id, listener) {
            if (id !== 'session-links-v1') throw new PluginError({
                code: 'plugin_resource_not_found', message: 'Own-plugin Resources are addressed by declared local id',
            });
            if (settings.relationObserverUnavailable) throw new PluginError({
                code: 'plugin_resource_unavailable', message: 'Relation dependency unavailable',
            });
            if (settings.relationAttachment) return await settings.relationAttachment;
            relationChanged = () => listener({ digest: 'changed' });
            return { async dispose() { relationChanged = undefined; await settings.relationDispose?.(); } };
        },
    };
    const options: PluginDynamicResourceInvocationOptionsV1 = createTestResourceInvocationContext({
        context: settings.context ?? Object.freeze({ kind: 'session', sessionId: 'session-a' }), signal: controller.signal, resources,
        ...(settings.accountStorage === undefined ? {} : { accountStorage: settings.accountStorage }),
        async readAction(ref, input) {
            if (ref.pluginId === 'happier.channels') { metadataReads += 1; return { ok: true, result: watch }; }
            nativeReads += 1;
            nativeInput = input;
            return { ok: true, result: native };
        },
        async observeAction(ref: PluginContributionRef, _input, invalidate) {
            if (ref.pluginId === 'happier.triage') nativeObservations += 1;
            if (settings.nativeObserverUnavailable && ref.pluginId === 'happier.triage') throw new Error('plugin_action_read_observation_unavailable');
            if (settings.metadataObserverUnavailable && ref.pluginId === 'happier.channels') throw new PluginError({
                code: 'plugin_action_read_observation_unavailable', message: 'Metadata dependency unavailable',
            });
            if (settings.metadataAttachment && ref.pluginId === 'happier.channels') return await settings.metadataAttachment;
            const key = ref.pluginId;
            const listeners = observers.get(key) ?? new Set<() => void>();
            observers.set(key, listeners);
            listeners.add(invalidate);
            return { async dispose() { listeners.delete(invalidate); if (ref.pluginId === 'happier.triage') await settings.nativeDispose?.(); } };
        },
    });
    const invocationOptions = settings.bindActions ? { ...options, ...settings.bindActions(options, () => controller.abort()) } : options;
    let observation: Disposable | undefined;
    let ready: Promise<Disposable | undefined> = Promise.resolve(undefined);
    const observe = () => {
        ready = Promise.resolve(runtime.observe(() => { invalidations += 1; }, invocationOptions)).then(handle => {
            observation = handle;
            return handle;
        });
        // Tests can inspect a rejected attachment through ready without an unrelated unhandled rejection.
        void ready.catch(() => {});
        return ready;
    };
    if (settings.observeInitially !== false) observe();
    return {
        options: invocationOptions,
        get ready() { return ready; },
        observe,
        async read() {
            await ready;
            const bytes = await runtime.read(invocationOptions);
            if (invocationOptions.signal.aborted) throw new DOMException('Read authority retired', 'AbortError');
            return SessionPullRequestStatusResourceResultV1Schema.parse(JSON.parse(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes)));
        },
        counts: () => ({ nativeReads, metadataReads, relationReads }),
        input: () => nativeInput,
        nativeObservationCount: () => nativeObservations,
        invalidationCount: () => invalidations,
        setNative(value: unknown) { native = value; },
        setMetadata(value: ReturnType<typeof metadata>) { watch = value; },
        setRelations(value: ReturnType<typeof relations>) { links = value; },
        changed(kind: 'metadata' | 'native' | 'relations') {
            if (kind === 'relations') relationChanged?.();
            else for (const notify of observers.get(kind === 'metadata' ? 'happier.channels' : 'happier.triage') ?? []) notify();
        },
        dispose() { controller.abort(); return observation?.dispose(); },
        observerCount: () => [...observers.values()].reduce((sum, listeners) => sum + listeners.size, 0),
        hasRelationObservation: () => relationChanged !== undefined,
    };
}

describe('the composed Session PR Resource', () => {
    it.each(['observation', 'relations'] as const)('retains the typed %s dependency refusal alongside the known linked PR', async stage => {
        let refused = true;
        const refuse = () => { throw new PluginError({ code: 'plugin_resource_not_found',
            message: 'The requested dependency is not available.', retryable: false }); };
        const host = boundary({
            ...(stage === 'relations' ? { readRelations: async () => refused ? refuse() : relations() } : {}),
            bindActions: options => ({ readAction: options.readAction,
                async observeAction(ref, input, invalidate, requestOptions) {
                    if (refused && stage === 'observation' && ref.pluginId === 'happier.triage') refuse();
                    return options.observeAction(ref, input, invalidate, requestOptions);
                },
            }),
        });
        try {
            expect(await host.read()).toMatchObject({ kind: 'ready', pullRequests: [{
                link: { url }, nativeStatus: { kind: 'unavailable', failure: { code: 'plugin_resource_not_found' } },
            }] });
            refused = false;
            if (stage === 'relations') host.changed('relations');
            expect(await host.read()).toMatchObject({ kind: 'ready', pullRequests: [{
                link: { url }, nativeStatus: { kind: 'current' },
            }] });
        } finally { await host.dispose(); }
    });

    it.each([
        { stage: 'metadata', thrown: false }, { stage: 'metadata', thrown: true },
        { stage: 'native', thrown: false }, { stage: 'native', thrown: true },
    ] as const)('preserves the typed $stage Action refusal (thrown=$thrown) in the shared PR result', async ({ stage, thrown }) => {
        const host = boundary({ bindActions: options => ({
            observeAction: options.observeAction,
            async readAction(ref, input, requestOptions) {
                if (ref.pluginId === (stage === 'metadata' ? 'happier.channels' : 'happier.triage')) {
                    if (thrown) throw new PluginError({ code: 'plugin_action_generation_retired',
                        message: 'The mounted generation retired.', retryable: false });
                    return { ok: false, errorCode: 'plugin_action_generation_retired', error: 'The mounted generation retired.' };
                }
                return options.readAction(ref, input, requestOptions);
            },
        }) });
        try {
            const result = await host.read();
            expect(stage === 'metadata' ? result : result.kind === 'ready' ? result.pullRequests[0]?.nativeStatus : null)
                .toMatchObject({ kind: 'unavailable', failure: { code: 'plugin_action_generation_retired' } });
        } finally { await host.dispose(); }
    });

    it('refreshes once on the source hint, keeps metadata reads separate, and stops when the terminal read withdraws the hint', async () => {
        vi.useFakeTimers();
        const host = boundary();
        const refreshAfterMs = 12_000;
        try {
            host.setNative({ ...status(100), refreshAfterMs });
            expect(await host.read()).toMatchObject({ pullRequests: [{ nativeStatus: { kind: 'current' } }] });
            expect(vi.getTimerCount()).toBe(1);
            await vi.advanceTimersByTimeAsync(refreshAfterMs - 1);
            expect(host.invalidationCount()).toBe(0);
            host.setMetadata(metadata(2));
            host.changed('metadata');
            await host.read();
            expect(host.counts().nativeReads).toBe(1);
            expect(host.invalidationCount()).toBe(1);
            await vi.advanceTimersByTimeAsync(1);
            expect(host.invalidationCount()).toBe(2);
            host.setNative({ ...status(200), refreshAfterMs: refreshAfterMs * 2 });
            expect(await host.read()).toMatchObject({ pullRequests: [{ nativeStatus: {
                kind: 'current', checkedAtMs: 200, value: { observedAtMs: 100 },
            } }] });
            expect(host.counts().nativeReads).toBe(2);
            await vi.advanceTimersByTimeAsync(refreshAfterMs);
            expect(host.invalidationCount()).toBe(2);
            await vi.advanceTimersByTimeAsync(refreshAfterMs);
            expect(host.invalidationCount()).toBe(3);
            host.setNative(status(300)); // Terminal sources omit their scheduling hint.
            await host.read();
            expect(vi.getTimerCount()).toBe(0);
            await vi.advanceTimersByTimeAsync(refreshAfterMs * 3);
            expect(host.invalidationCount()).toBe(3);
            expect(host.counts().nativeReads).toBe(3);
        } finally { await host.dispose(); vi.useRealTimers(); }
    });

    it.each(['dispose', 'unlink', 'finite read'] as const)('does no hinted refresh after demand ends: %s', async end => {
        vi.useFakeTimers();
        const host = boundary({ observeInitially: end !== 'finite read' });
        const refreshAfterMs = 12_000;
        try {
            host.setNative({ ...status(100), refreshAfterMs });
            expect(await host.read()).toMatchObject({ pullRequests: [{ nativeStatus: { kind: 'current' } }] });
            if (end === 'dispose') await host.dispose();
            if (end === 'unlink') {
                const watch = metadata();
                if (watch.kind !== 'ready') throw new Error('ready fixture');
                host.setMetadata({ ...watch, bindings: [] });
                host.changed('metadata');
                await host.read();
            }
            const before = host.invalidationCount();
            expect(vi.getTimerCount()).toBe(0);
            await vi.advanceTimersByTimeAsync(refreshAfterMs * 3);
            expect(host.invalidationCount()).toBe(before);
            expect(host.counts().nativeReads).toBe(1);
        } finally { await host.dispose(); vi.useRealTimers(); }
    });

    it('finishes a one-shot status read without attaching an open-ended authority observation', async () => {
        const host = boundary({ observeInitially: false, nativeObserverUnavailable: true });
        try {
            expect(await host.read()).toMatchObject({ kind: 'ready', pullRequests: [{ nativeStatus: {
                kind: 'current', value: { observedAtMs: 100 },
            } }] });
            expect(host.counts()).toEqual({ nativeReads: 1, metadataReads: 1, relationReads: 1 });
            expect(host.nativeObservationCount()).toBe(0);
            expect(host.observerCount()).toBe(0);
        } finally { await host.dispose(); }
    });

    it.each(['outside configured selection', 'without a configured source', 'deselected while native observation is unavailable'] as const)(
        'offers existing source setup for a PR %s without reading native status or widening configuration', async scenario => {
        const [{ encodeGithubTriageConfiguration }, { readGithubTriageSessionLinks }, { createStubGithubTransport, GITHUB_TEST_ACCOUNT }] = await Promise.all([
            import('../../../scm-github/src/triage/configuration.js'),
            import('../../../scm-github/src/triage/sessionRelations.js'),
            import('../../../scm-github/src/triage/testkit/githubTriage.test-support.js'),
        ]);
        const source = createTriageSourceV1Fixture();
        const descriptor = { ...source.descriptor, purpose: 'github-connected-account', displayName: 'GitHub',
            settingsPageId: 'triage-sources', sessionRelations: { kindIds: ['pull-request'] } };
        const initiallySelected = scenario === 'deselected while native observation is unavailable';
        const token = encodeGithubTriageConfiguration({ v: 1, selection: { kind: 'selected', unitIds: initiallySelected
            ? ['example/selected', 'example/outside-selection'] : ['example/selected'] } });
        if (token === null) throw new Error('Expected valid source configuration');
        const configured = { ...source.configuredInstance,
            instance: { ...source.configuredInstance.instance, source: { pluginId: 'happier.scm.forge.github', localId: 'github-forge' } },
            binding: { purpose: 'github-connected-account', account: GITHUB_TEST_ACCOUNT },
            localInstanceKey: 'github.com', configuration: { v: 1 as const, token },
        };
        const corpus = createTestkitCorpusCollections();
        if (scenario !== 'without a configured source') corpus.control.sourceInstances.seed(toCorpusStoredValue({
            instanceTag: 'a'.repeat(43), sourceQualifiedId: 'happier.scm.forge.github/github-forge',
            lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1, configured,
        }));
        const transport = createStubGithubTransport({ respond() { throw new Error('Setup recovery must not acquire native PR status'); } });
        let relationRequests = 0;
        // The Channels Action transport and Account persistence are the system boundaries.
        // GitHub's real configured-selection filter, Triage relations and both Resource schemas run unchanged.
        const nativeContext = { ...transport.context, services: { ...transport.context.services, actions: {
            ...transport.context.services.actions,
            async execute() {
                relationRequests++;
                return { kind: 'relations', links: [{ sessionId: 'session-a', bindingId: 'binding-a', revision: 1,
                    pullRequest: { repository: 'example/outside-selection', number: 17 }, repositoryId: '4210', linkedAtMs: 1 }] };
            },
        } } };
        let admitted = true;
        const relationOperation = { handle: 'admitted-github-session-links' };
        const context = { signal: new AbortController().signal, services: {
            targetedContributions: { observeForSelf: () => ({ readCurrent: async () => ({ contributions: admitted ? [{
                contributor: { pluginId: configured.instance.source.pluginId, contributionId: configured.instance.source.localId },
                descriptor,
                operations: { readSessionLinks: relationOperation, linkSession: { handle: 'admitted-github-link' } },
            }] : [] }), dispose() {} }) },
            actions: { async executeAdmittedTargetedOperation(operation: unknown, input: unknown) {
                expect(operation).toBe(relationOperation);
                return await readGithubTriageSessionLinks(input, nativeContext);
            } },
        } } as unknown as TriageDataActionContext;
        const readRelations = () => createTriageSourceSessionRelations(context, corpus.collections).read({ sessionId: 'session-a' });
        const host = boundary({ nativeObserverUnavailable: true, readRelations });
        const watch = metadata();
        if (watch.kind !== 'ready') throw new Error('Expected metadata fixture');
        const link = { ...watch.bindings[0]!.link, repository: 'example/outside-selection',
            url: 'https://github.com/example/outside-selection/pull/17' };
        host.setMetadata({ ...watch, bindings: [{ ...watch.bindings[0]!, link }] });
        try {
            if (initiallySelected) {
                const selected = await host.read();
                expect(selected).toMatchObject({ kind: 'ready', pullRequests: [{ nativeStatus: {
                    kind: 'unavailable', failure: { code: 'nativeObservationUnavailable' },
                } }] });
                expect(selected.kind === 'ready' && selected.pullRequests[0]?.nativeStatus).not.toHaveProperty('recovery');
                const deselectedToken = encodeGithubTriageConfiguration({ v: 1, selection: { kind: 'selected', unitIds: ['example/selected'] } });
                if (deselectedToken === null) throw new Error('Expected valid selection');
                corpus.control.sourceInstances.seed(toCorpusStoredValue({
                    instanceTag: 'a'.repeat(43), sourceQualifiedId: 'happier.scm.forge.github/github-forge',
                    lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1,
                    configured: { ...configured, configuration: { v: 1, token: deselectedToken } },
                }));
            }
            const configuredBefore = await corpus.collections.sourceInstances.get('a'.repeat(43));
            const result = await host.read();
            expect(result).toMatchObject({ kind: 'ready', pullRequests: [{ link, nativeStatus: { kind: 'unavailable',
                failure: { class: 'unsupportedContract', code: 'configuredSourceUnavailable' },
                recovery: { kind: 'configureSources', offers: [{
                    destination: { pluginId: 'happier.scm.forge.github', localId: descriptor.settingsPageId },
                    displayName: descriptor.displayName,
                }] },
            } }] });
            expect(result.kind === 'ready' && result.pullRequests[0]?.entry).toBeUndefined();
            expect(host.counts()).toEqual({ metadataReads: 1, relationReads: initiallySelected ? 2 : 1, nativeReads: 0 });
            expect(host.nativeObservationCount()).toBe(initiallySelected ? 1 : 0);
            expect(relationRequests).toBe(scenario === 'without a configured source' ? 0 : initiallySelected ? 2 : 1);
            expect(transport.requests).toEqual([]);
            expect(transport.materializeCount()).toBe(0);
            admitted = false;
            host.changed('relations');
            const retired = await host.read();
            expect(retired.kind === 'ready' && retired.pullRequests[0]?.nativeStatus).toEqual({
                kind: 'unavailable', failure: { class: 'unsupportedContract', code: 'configuredSourceUnavailable' },
            });
            expect(await corpus.collections.sourceInstances.get('a'.repeat(43))).toEqual(configuredBefore);
        } finally { await host.dispose(); }
    });

    it('forwards original source operation offers with the same native demand and lifetime', async () => {
        const host = boundary();
        const operations = { readiness: 'unknown', unmetRequirements: [], primary: {
            id: 'enqueue', title: 'Add to merge queue', disabledReason: null,
            actionRef: { pluginId: entryRef.source.pluginId, localId: 'source-native/enqueue' },
            variants: [{ id: 'direct', input: { expectedHeadSha: 'sha-one', sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID } }],
        }, alternatives: [] };
        host.setNative(TriagePullRequestStatusV1Schema.parse({ ...status(100), operations }));
        try {
            const first = await host.read();
            const second = await host.read();
            expect(first).toMatchObject({ kind: 'ready', pullRequests: [{ nativeStatus: { kind: 'current', value: { operations } } }] });
            expect(second).toMatchObject({ kind: 'ready', pullRequests: [{ nativeStatus: { kind: 'current', value: { operations } } }] });
            expect(host.counts()).toEqual({ nativeReads: 2, metadataReads: 1, relationReads: 1 });
            // A warm native failure retains display offers but never promotes them to a current execution choice.
            host.setNative({ kind: 'unavailable', failure });
            host.changed('native');
            expect(await host.read()).toMatchObject({ kind: 'ready', pullRequests: [{ nativeStatus: {
                kind: 'stale', failure, value: { operations },
            } }] });
            expect(host.counts()).toEqual({ nativeReads: 3, metadataReads: 1, relationReads: 1 });
        } finally { await host.dispose(); }
    });

    it.each(['watched refresh', 'standalone unchanged', 'standalone source replaced', 'standalone cancelled'] as const)(
        'keeps finite reads separate from live source observation: %s', async initialDemand => {
        const source = createTriageSourceV1Fixture();
        let configured = source.configuredInstance;
        const corpus = createTestkitCorpusCollections();
        const sourceRow = { instanceTag: 'a'.repeat(43),
            sourceQualifiedId: `${configured.instance.source.pluginId}/${configured.instance.source.localId}`,
            lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1, configured,
        };
        corpus.control.sourceInstances.seed(toCorpusStoredValue(sourceRow));
        let externalReads = 0;
        let nativeResult: unknown = { ...status(123), title: 'Keep the source-admitted PR title' };
        let pendingNative: Promise<unknown> | undefined;
        let nativeStarted: (() => void) | undefined;
        let nativeEnvelopeDelivery: Promise<void> | undefined;
        let nativeEnvelopeAdmitted: (() => void) | undefined;
        let deliverNativeEnvelope: (() => void) | undefined;
        let activeNativeObservers = 0;
        const localRefs = [source.getInput.localRef];
        const sourceRows = corpus.watchableCollections.sourceInstances;
        const nativeOperation = { handle: 'original-admitted-native-status', identity: {
            target: { pluginId: 'happier.triage' },
            point: { pointId: 'sources', protocol: { id: 'happier.triage/sources', version: 1 } },
            contributor: { pluginId: configured.instance.source.pluginId,
                contributionId: configured.instance.source.localId, occurrenceId: 'selected-source',
                sourceCustody: { kind: 'development', registeredRootId: 'selected-source' } },
            role: 'readPullRequestStatus',
        } satisfies AdmittedTargetedOperationIdentity };
        const relationOperation = { handle: 'original-admitted-session-relations' };
        // The host's admitted-operation capability and persistent Account store are the replaced system boundaries.
        const context = { surface: 'plugin', caller: { kind: 'plugin', pluginId: 'happier.triage' }, signal: new AbortController().signal,
            services: { storage: { account: { collection: (definition: PluginAccountCollectionDefinition) => definition.id === CORPUS_SOURCE_INSTANCES_COLLECTION_ID
                ? sourceRows : corpus.collections.userMarks } },
                targetedContributions: { observeForSelf: () => ({ readCurrent: async () => ({ contributions: [{
                    contributor: { pluginId: configured.instance.source.pluginId, contributionId: configured.instance.source.localId },
                    descriptor: { ...source.descriptor, sessionRelations: { kindIds: [source.getInput.localRef.kindId] } },
                    operations: { readPullRequestStatus: nativeOperation, readSessionLinks: relationOperation, linkSession: { handle: 'link-session' } },
                }] }), dispose() {} }) },
                actions: { observeAdmittedTargetedOperation: async (_operation: unknown, _input: unknown, _invalidate: () => void,
                    request: Readonly<{ signal?: AbortSignal }>) => {
                    activeNativeObservers += 1;
                    let disposed = false;
                    return { async dispose() {
                        if (disposed) return;
                        disposed = true;
                        activeNativeObservers -= 1;
                    } };
                },
                    executeAdmittedTargetedOperation: async (operation: unknown, input: unknown) => {
                    if (operation === relationOperation) {
                        expect(input).toEqual({ v: 1, instance: configured, sessionId: 'session-a' });
                        return TriageSourceReadSessionLinksResultV1Schema.parse({ kind: 'complete', links: localRefs.map((localRef, index) => ({
                            localRef, sessionId: 'session-a', linkedAtMs: 1, displayPath: 'Native PR', locator: locator,
                        })) });
                    }
                    expect(operation).toBe(nativeOperation);
                    const request = TriageSourceCredentialInputsV1.readPullRequestStatus.parse(input);
                    const index = localRefs.findIndex(localRef => localRef.entryId === request.localRef.entryId);
                    expect(index).toBeGreaterThanOrEqual(0);
                    expect(input).toEqual({ ...source.getInput, instance: configured, localRef: localRefs[index],
                        lastKnownLocator: locator });
                    externalReads += 1;
                    nativeStarted?.();
                    return pendingNative ? await pendingNative : nativeResult;
                } },
            },
        } as unknown as TriageDataActionContext;
        const bindActions = (options: PluginDynamicResourceInvocationOptionsV1, retire: () => void): Pick<PluginDynamicResourceInvocationOptionsV1, 'readAction' | 'observeAction'> => {
            const invocation = { ...context, signal: options.signal };
            return {
                async readAction(ref, input, request) {
                    if (ref.pluginId !== 'happier.triage') return await options.readAction(ref, input, request);
                    const signal = request?.signal ?? options.signal;
                    const result = await createTriageReadPullRequestStatusActionHandler()(TriageReobserveEntryInputV1Schema.parse(input),
                        { ...invocation, signal });
                    // Hold the real admitted HTTP response, not an internal decision.
                    nativeEnvelopeAdmitted?.();
                    await nativeEnvelopeDelivery;
                    if (signal.aborted) throw new DOMException('Read authority retired', 'AbortError');
                    return { ok: true, result };
                },
                async observeAction(ref, input, invalidate, request) {
                    if (ref.pluginId !== 'happier.triage') return await options.observeAction(ref, input, invalidate, request);
                    // The host gives each Action observer a child lifetime; public disposal aborts it synchronously.
                    const controller = new AbortController();
                    const parents = new Set([options.signal, request?.signal ?? options.signal]);
                    const abort = () => controller.abort();
                    for (const signal of parents) signal.addEventListener('abort', abort, { once: true });
                    if ([...parents].some(signal => signal.aborted)) abort();
                    const detach = () => { for (const signal of parents) signal.removeEventListener('abort', abort); };
                    try {
                        const observation = await createTriageReadPullRequestStatusObserver()(TriageReobserveEntryInputV1Schema.parse(input),
                            Object.assign(invalidate, { retire }), { ...invocation, signal: controller.signal });
                        let cleanup: Promise<void> | undefined;
                        return { dispose() {
                            abort();
                            detach();
                            return cleanup ??= (async () => { await observation.dispose(); })();
                        } };
                    } catch (error) { abort(); detach(); throw error; }
                },
            };
        };
        const host = boundary({ bindActions, accountStorage: requireTriageAccountStorage(context), observeInitially: initialDemand === 'watched refresh' });
        const bind = async (target: ReturnType<typeof boundary>) => {
            target.setRelations(await createTriageSourceSessionRelations({ ...context, signal: target.options.signal }, corpus.collections).read({ sessionId: 'session-a' }));
            await target.ready;
        };
        let release: ((value: unknown) => void) | undefined;
        let oldRead: Promise<unknown> | undefined;
        let replacement: ReturnType<typeof boundary> | undefined;
        const replaceSource = async () => {
            configured = { ...configured, configuration: { ...configured.configuration, token: `${configured.configuration.token}-updated` } };
            const row = await corpus.watchableCollections.sourceInstances.get(sourceRow.instanceTag);
            if (!row) throw new Error('The admitted source row must exist');
            await corpus.watchableCollections.sourceInstances.put(toCorpusStoredValue({ ...sourceRow, configured }), { expectedRevision: row.revision });
        };
        try {
            await bind(host);
            if (initialDemand !== 'watched refresh') {
                nativeEnvelopeDelivery = new Promise<void>(resolve => { deliverNativeEnvelope = resolve; });
                const admitted = new Promise<void>(resolve => { nativeEnvelopeAdmitted = resolve; });
                oldRead = host.read();
                void oldRead.catch(() => {});
                await admitted;
                expect(activeNativeObservers).toBe(0);
                if (initialDemand === 'standalone cancelled') await host.dispose();
                if (initialDemand === 'standalone source replaced') await replaceSource();
                deliverNativeEnvelope?.();
                if (initialDemand === 'standalone cancelled') await expect(oldRead).rejects.toMatchObject({ name: 'AbortError' });
                else expect(await oldRead).toMatchObject({ kind: 'ready', pullRequests: [{ nativeStatus: { kind: 'current', checkedAtMs: 123 } }] });
                expect(externalReads).toBe(1);
                return;
            }
            const result = await host.read();
            expect(result.kind === 'ready' && result.pullRequests[0]?.nativeStatus).toMatchObject({ kind: 'current', checkedAtMs: 123,
                value: { title: 'Keep the source-admitted PR title' } });
            expect(result.kind === 'ready' && result.pullRequests[0]).toMatchObject({ entry: {
                entryRef: { source: configured.instance.source, ...source.getInput.localRef },
                sourceInstanceId: configured.instance.sourceInstanceId,
            } });
            expect(externalReads).toBe(1);
            const getCount = corpus.control.sourceInstances.getCallCount();
            const presentation = await corpus.watchableCollections.sourceInstances.get(sourceRow.instanceTag);
            if (!presentation) throw new Error('The admitted source row must exist');
            configured = { ...configured, locator: { ...configured.locator, v: 1, displayLabel: 'Renamed source' } };
            await corpus.watchableCollections.sourceInstances.put(toCorpusStoredValue({ ...sourceRow, configuredAtMs: 2, configured }),
                { expectedRevision: presentation.revision });
            await vi.waitFor(() => expect(corpus.control.sourceInstances.getCallCount()).toBeGreaterThan(getCount + 1));
            host.setRelations(await createTriageSourceSessionRelations(context, corpus.collections).read({ sessionId: 'session-a' }));
            host.changed('relations');
            const presentationOnly = await host.read();
            expect(presentationOnly.kind === 'ready' && presentationOnly.pullRequests[0]?.nativeStatus).toMatchObject({
                kind: 'current', checkedAtMs: 123, value: { observedAtMs: 123 },
            });
            expect(externalReads).toBe(1);
            expect(host.options.signal.aborted).toBe(false);
            pendingNative = new Promise(resolve => { release = resolve; });
            const started = new Promise<void>(resolve => { nativeStarted = resolve; });
            oldRead = host.read();
            void oldRead.catch(() => {});
            await started;
            configured = { ...configured, configuration: { ...configured.configuration, token: `${configured.configuration.token}-updated` } };
            const row = await corpus.watchableCollections.sourceInstances.get(sourceRow.instanceTag);
            if (!row) throw new Error('The admitted source row must exist');
            await corpus.watchableCollections.sourceInstances.put(toCorpusStoredValue({ ...sourceRow, configured }), { expectedRevision: row.revision });
            await vi.waitFor(() => expect(host.options.signal.aborted).toBe(true));
            release?.(status(456));
            await expect(oldRead).rejects.toMatchObject({ name: 'AbortError' });
            pendingNative = undefined;
            nativeResult = { kind: 'unavailable', failure };
            replacement = boundary({ context: host.options.context, bindActions });
            await bind(replacement);
            const rebound = await replacement.read();
            expect(rebound.kind === 'ready' && rebound.pullRequests[0]?.nativeStatus).toEqual({ kind: 'unavailable', failure });
            expect(externalReads).toBe(3);
        } finally {
            deliverNativeEnvelope?.();
            release?.(status(456));
            await oldRead?.catch(() => {});
            await host.dispose();
            await replacement?.dispose();
            expect(activeNativeObservers).toBe(0);
        }
    });

    it('uses the exact configured relation and performs one native acquisition for duplicate bindings', async () => {
        const host = boundary();
        const same = metadata();
        if (same.kind !== 'ready') throw new Error('ready fixture');
        host.setMetadata({ ...same, bindings: [...same.bindings, { ...same.bindings[0]!, bindingId: 'binding-b' }] });
        try {
            const result = await host.read();
            expect(result.kind).toBe('ready');
            if (result.kind !== 'ready') return;
            expect(result.pullRequests).toHaveLength(2);
            for (const binding of result.pullRequests) expect(binding).toMatchObject({ entry: {
                entryRef, sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID,
            } });
            expect(result.pullRequests[0]?.nativeStatus.kind === 'current' && result.pullRequests[0].nativeStatus.value)
                .not.toHaveProperty('title');
            expect(host.counts()).toEqual({ nativeReads: 1, metadataReads: 1, relationReads: 1 });
            expect(host.input()).toEqual({ v: 1, entryRef, sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID, lastKnownLocator: locator });
        } finally { host.dispose(); }
    });

    it('loads source relations when a previously empty Session becomes linked', async () => {
        const host = boundary();
        const empty = metadata();
        if (empty.kind !== 'ready') throw new Error('ready fixture');
        host.setMetadata({ ...empty, bindings: [] });
        try {
            expect(await host.read()).toEqual({ kind: 'ready', sessionId: 'session-a', pullRequests: [] });
            expect(host.counts()).toEqual({ nativeReads: 0, metadataReads: 1, relationReads: 0 });
            host.setMetadata(metadata());
            host.changed('metadata');
            const result = await host.read();
            expect(result.kind === 'ready' && result.pullRequests[0]?.nativeStatus.kind).toBe('current');
            expect(host.counts()).toEqual({ nativeReads: 1, metadataReads: 2, relationReads: 1 });
        } finally { host.dispose(); }
    });

    it('keeps metadata refresh separate from native refresh and keeps the last successful check clock on failure', async () => {
        const host = boundary();
        try {
            await host.read();
            const nextMetadata = metadata(2);
            if (nextMetadata.kind !== 'ready') throw new Error('ready fixture');
            host.setMetadata(SessionPullRequestWatchReadResultV1Schema.parse({ ...nextMetadata,
                bindings: nextMetadata.bindings.map(binding => ({ ...binding,
                    watch: { ...binding.watch, roundsStarted: 1, progress: { roundsStarted: 1, continuationRounds: 0,
                        cause: { kind: 'feedback' }, sourceHeadSha: 'sha-one' } },
                    latestUpdate: { occurrenceId: 'occurrence-a', occurredAtMs: 110, kinds: ['comment'], summary: 'New feedback',
                        summaryTruncated: false, location: { kind: 'provider', url } },
                })),
            }));
            host.changed('metadata');
            const metadataOnly = await host.read();
            expect(host.counts().nativeReads).toBe(1);
            expect(metadataOnly.kind === 'ready' && metadataOnly.pullRequests[0]).toMatchObject({ revision: 2,
                watch: { roundsStarted: 1, progress: { roundsStarted: 1, continuationRounds: 0, cause: { kind: 'feedback' } } },
                latestUpdate: { occurrenceId: 'occurrence-a', kinds: ['comment'], location: { kind: 'provider', url } },
            });
            host.setNative(status(200));
            host.changed('native');
            const success = await host.read();
            expect(success.kind === 'ready' && success.pullRequests[0]?.nativeStatus).toMatchObject({ kind: 'current', checkedAtMs: 200,
                value: { observedAtMs: 100 } });
            host.setNative({ kind: 'unavailable', failure });
            host.changed('native');
            const stale = await host.read();
            expect(stale.kind === 'ready' && stale.pullRequests[0]?.nativeStatus).toMatchObject({ kind: 'stale', checkedAtMs: 200,
                value: { observedAtMs: 100 }, failure });
            expect(host.counts()).toEqual({ nativeReads: 3, metadataReads: 2, relationReads: 1 });
        } finally { host.dispose(); }
    });

    it('retains equal same-demand facts when neither successful observation establishes a head revision', async () => {
        for (const branch of [null, { head: 'feature', base: 'main' }]) {
            const host = boundary();
            try {
                host.setNative({ ...status(100), branch });
                await host.read();
                host.setNative({ ...status(200), branch });
                host.changed('native');
                const result = await host.read();
                expect(result.kind === 'ready' && result.pullRequests[0]?.nativeStatus).toMatchObject({ kind: 'current',
                    checkedAtMs: 200, value: { observedAtMs: 100, branch } });
            } finally { await host.dispose(); }
        }
    });

    it('requires exact source relations for native status and recovers when they are restored', async () => {
        for (const invalid of [
            { ...relations(), links: [] },
            { ...relations(), links: relations().links.map(link => ({ ...link, sessionId: 'other-session' })) },
            { ...relations(), links: relations().links.map(link => ({ ...link, locator: testkitLocator({ webUrl: undefined, displayPath: url }) })) },
            { ...relations(), links: [...relations().links, ...relations().links] },
            { ...relations(), links: relations().links.map(({ sourceInstanceId: _id, ...link }) => link) },
        ]) {
            const host = boundary();
            host.setRelations(invalid);
            try {
                const result = await host.read();
                expect(result.kind === 'ready' && result.pullRequests[0]?.nativeStatus).toEqual({
                    kind: 'unavailable', failure: { class: 'unsupportedContract', code: 'configuredSourceUnavailable' },
                });
                expect(result.kind === 'ready' && result.pullRequests[0]).not.toHaveProperty('entry');
                expect(host.counts().nativeReads).toBe(0);
                host.setRelations(relations());
                host.changed('relations');
                const recovered = await host.read();
                expect(recovered.kind === 'ready' && recovered.pullRequests[0]?.nativeStatus).toMatchObject({
                    kind: 'current', checkedAtMs: 100, value: { checks: { passed: 1 }, branch: { headRevision: 'sha-one' } },
                });
                expect(host.input()).toEqual({ v: 1, entryRef, sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID, lastKnownLocator: locator });
                expect(host.counts()).toEqual({ metadataReads: 1, relationReads: 2, nativeReads: 1 });
            } finally { host.dispose(); }
        }
    });

    it('retires a prior success on source replacement and does not invent a clock on its failed first read', async () => {
        const host = boundary();
        try {
            await host.read();
            host.setRelations({ ...relations(2), links: relations(2).links.map(link => ({ ...link,
                sourceInstanceId: '00000000-0000-4000-8000-000000000002' })) });
            host.changed('relations');
            host.setNative({ kind: 'unavailable', failure });
            const result = await host.read();
            expect(result.kind === 'ready' && result.pullRequests[0]?.nativeStatus).toEqual({ kind: 'unavailable', failure });
        } finally { host.dispose(); }
        await Promise.resolve();
        expect(host.observerCount()).toBe(0);
    });

    it('does not carry native bytes across host authority retirement when the same Session context is rebound', async () => {
        const context = Object.freeze({ kind: 'session' as const, sessionId: 'session-a' });
        const previous = boundary({ context });
        const success = await previous.read();
        expect(success.kind === 'ready' && success.pullRequests[0]?.nativeStatus).toMatchObject({ kind: 'current', checkedAtMs: 100 });
        await previous.dispose();
        const replacement = boundary({ context });
        replacement.setNative({ kind: 'unavailable', failure });
        try {
            const result = await replacement.read();
            expect(result.kind === 'ready' && result.pullRequests[0]?.nativeStatus).toEqual({ kind: 'unavailable', failure });
            expect(previous.observerCount()).toBe(0);
        } finally { await replacement.dispose(); }
    });

    it('keeps the successor baseline when an aborted prior read settles after the same context is rebound', async () => {
        const context = Object.freeze({ kind: 'session' as const, sessionId: 'session-a' });
        const previous = boundary({ context });
        await previous.read();
        const original = previous.options.readAction;
        let release: (() => void) | undefined;
        let acquired: (() => void) | undefined;
        const pending = new Promise<void>(resolve => { release = resolve; });
        const started = new Promise<void>(resolve => { acquired = resolve; });
        previous.changed('native');
        const priorRead = runtime.read(createTestResourceInvocationContext({ ...previous.options, async readAction(...args: Parameters<typeof original>) {
            if (args[0].pluginId === 'happier.triage') { acquired?.(); await pending; }
            return await original(...args);
        } }));
        void priorRead.catch(() => {});
        await started;
        await previous.dispose();
        const replacement = boundary({ context });
        replacement.setNative(status(200));
        try {
            await replacement.read();
            release?.();
            await expect(priorRead).rejects.toMatchObject({ name: 'AbortError' });
            replacement.setNative({ kind: 'unavailable', failure });
            replacement.changed('native');
            const result = await replacement.read();
            expect(result.kind === 'ready' && result.pullRequests[0]?.nativeStatus).toMatchObject({
                kind: 'stale', checkedAtMs: 200, failure,
            });
            expect(replacement.counts()).toEqual({ nativeReads: 2, metadataReads: 1, relationReads: 1 });
        } finally { release?.(); await priorRead.catch(() => {}); await replacement.dispose(); }
    });

    it('does not reveal prior Account bytes after a denied metadata read or an expired native authority', async () => {
        const host = boundary();
        try {
            await host.read();
            host.changed('metadata');
            const refused = await runtime.read(createTestResourceInvocationContext({ ...host.options, readAction: async () => ({ ok: false,
                errorCode: 'denied', error: 'Account denied' }) }));
            expect(JSON.parse(typeof refused === 'string' ? refused : new TextDecoder().decode(refused)).kind).toBe('unavailable');
            host.setMetadata(SessionPullRequestWatchReadResultV1Schema.parse({ kind: 'unavailable', sessionId: 'session-a', reason: 'locked' }));
            expect((await host.read()).kind).toBe('unavailable');
        } finally { host.dispose(); }
        const authority = boundary();
        try {
            await authority.read();
            authority.setNative({ kind: 'unavailable', failure: { class: 'permission', code: 'sourceAuthorityChanged' } });
            authority.changed('native');
            const result = await authority.read();
            expect(result.kind === 'ready' && result.pullRequests[0]?.nativeStatus).toEqual({ kind: 'unavailable',
                failure: { class: 'permission', code: 'sourceAuthorityChanged' } });
        } finally { authority.dispose(); }
    });

    it('reports an unsupported native dependency observer without a native read or refresh loop', async () => {
        const host = boundary({ nativeObserverUnavailable: true });
        try {
            await host.ready;
            const result = await runtime.read(host.options);
            const admitted = SessionPullRequestStatusResourceResultV1Schema.parse(JSON.parse(typeof result === 'string' ? result : new TextDecoder().decode(result)));
            expect(admitted.kind === 'ready' && admitted.pullRequests[0]?.nativeStatus).toMatchObject({ kind: 'unavailable',
                failure: { class: 'unsupportedContract', code: 'nativeObservationUnavailable' } });
            expect(host.counts().nativeReads).toBe(0);
        } finally { host.dispose(); }
    });

    it('retries unavailable native observation on explicit refresh, but not on metadata invalidation', async () => {
        const settings = { nativeObserverUnavailable: true };
        const host = boundary(settings);
        try {
            const initial = await host.read();
            expect(initial.kind === 'ready' && initial.pullRequests[0]?.nativeStatus.kind).toBe('unavailable');
            settings.nativeObserverUnavailable = false;
            host.changed('metadata');
            const metadataOnly = await host.read();
            expect(metadataOnly.kind === 'ready' && metadataOnly.pullRequests[0]?.nativeStatus.kind).toBe('unavailable');
            expect(host.nativeObservationCount()).toBe(1);
            expect(host.counts().nativeReads).toBe(0);
            const refreshed = await host.read();
            expect(refreshed.kind === 'ready' && refreshed.pullRequests[0]?.nativeStatus).toMatchObject({ kind: 'current', checkedAtMs: 100 });
            expect(host.nativeObservationCount()).toBe(2);
            expect(host.counts().nativeReads).toBe(1);
        } finally { await host.dispose(); }
    });

    it('rejects attachment through the host watch error path when metadata observation is unavailable', async () => {
        const host = boundary({ metadataObserverUnavailable: true });
        try {
            await expect(host.ready).rejects.toMatchObject({ code: 'plugin_action_read_observation_unavailable' });
            expect(host.counts()).toEqual({ nativeReads: 0, metadataReads: 0, relationReads: 0 });
            expect(host.hasRelationObservation()).toBe(false);
            expect(host.observerCount()).toBe(0);
        } finally { host.dispose(); }
    });

    it('propagates relation watch admission failure before attaching metadata or acquiring native status', async () => {
        const host = boundary({ relationObserverUnavailable: true });
        try {
            await expect(host.ready).rejects.toMatchObject({ code: 'plugin_resource_unavailable' });
            expect(host.counts()).toEqual({ nativeReads: 0, metadataReads: 0, relationReads: 0 });
            expect(host.observerCount()).toBe(0);
        } finally { host.dispose(); }
    });

    it('disposes a relation watch resolving after cancellation without attaching the next dependency', async () => {
        let attach: ((handle: Disposable) => void) | undefined;
        const relationAttachment = new Promise<Disposable>(resolve => { attach = resolve; });
        const host = boundary({ relationAttachment });
        let lateDisposals = 0;
        host.dispose();
        attach?.({ dispose() { lateDisposals += 1; } });
        await host.ready;
        expect(lateDisposals).toBe(1);
        expect(host.observerCount()).toBe(0);
        expect(host.counts()).toEqual({ nativeReads: 0, metadataReads: 0, relationReads: 0 });
    });

    it('retires demand synchronously while public disposal awaits all asynchronous dependency cleanup', async () => {
        let release: (() => void) | undefined;
        const cleanup = new Promise<void>(resolve => { release = resolve; });
        let nativeDisposed = false;
        let relationDisposed = false;
        const host = boundary({ nativeDispose: async () => { await cleanup; nativeDisposed = true; },
            relationDispose: async () => { await cleanup; relationDisposed = true; } });
        await host.read();
        let settled = false;
        const disposing = Promise.resolve(host.dispose()).then(() => { settled = true; });
        await Promise.resolve();
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(nativeDisposed).toBe(false);
        expect(relationDisposed).toBe(false);
        release?.();
        await disposing;
        expect(nativeDisposed).toBe(true);
        expect(relationDisposed).toBe(true);
        expect(host.observerCount()).toBe(0);
    });

    it('returns dependency cleanup rejection through explicit disposal after abort', async () => {
        const failure = new Error('native dependency cleanup failed');
        const host = boundary({ nativeDispose: async () => { throw failure; } });
        await host.read();
        await expect(Promise.resolve(host.dispose())).rejects.toBe(failure);
    });

    it('awaits metadata attachment and disposes a dependency that resolves after demand cancellation', async () => {
        let attach: ((handle: Disposable) => void) | undefined;
        const metadataAttachment = new Promise<Disposable>(resolve => { attach = resolve; });
        const host = boundary({ metadataAttachment });
        let lateDisposals = 0;
        let attached = false;
        void host.ready.then(() => { attached = true; });
        await Promise.resolve();
        await Promise.resolve();
        expect(attached).toBe(false);
        expect(host.hasRelationObservation()).toBe(true);
        expect(host.counts()).toEqual({ nativeReads: 0, metadataReads: 0, relationReads: 0 });
        host.dispose();
        expect(host.hasRelationObservation()).toBe(false);
        attach?.({ dispose() { lateDisposals += 1; } });
        await host.ready;
        expect(lateDisposals).toBe(1);
        expect(host.observerCount()).toBe(0);
    });

    it('keeps an invalidation arriving during a metadata await dirty for the next read', async () => {
        const host = boundary();
        try {
            await host.read();
            const original = host.options.readAction;
            let release: (() => void) | undefined;
            const pending = new Promise<void>(resolve => { release = resolve; });
            const options = { ...host.options, async readAction(...args: Parameters<typeof original>) {
                if (args[0].pluginId === 'happier.channels') await pending;
                return await original(...args);
            } };
            host.changed('metadata');
            const read = runtime.read(options);
            await Promise.resolve();
            host.changed('metadata');
            release?.();
            await read;
            await host.read();
            expect(host.counts().metadataReads).toBe(3);
            expect(host.counts().nativeReads).toBe(1);
        } finally { host.dispose(); }
    });

    it('keeps native invalidation arriving during an in-flight source read for the next demand', async () => {
        const host = boundary();
        try {
            await host.read();
            const original = host.options.readAction;
            let release: (() => void) | undefined;
            const pending = new Promise<void>(resolve => { release = resolve; });
            const options = { ...host.options, async readAction(...args: Parameters<typeof original>) {
                if (args[0].pluginId === 'happier.triage') await pending;
                return await original(...args);
            } };
            host.changed('native');
            const read = runtime.read(options);
            await Promise.resolve();
            await Promise.resolve();
            host.changed('native');
            release?.();
            await read;
            await host.read();
            expect(host.counts()).toEqual({ nativeReads: 3, metadataReads: 1, relationReads: 1 });
        } finally { host.dispose(); }
    });
});
