import type { PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk/collections';
import type { AdmittedTargetedOperationIdentity } from '@happier-dev/plugin-sdk/actions';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { TriagePullRequestStatusV1Schema, TriagePullRequestStatusResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it, vi } from 'vitest';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import { CORPUS_SOURCE_INSTANCES_COLLECTION_ID, CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { createTriageReadPullRequestStatusActionHandler } from './readPullRequestStatus.js';
import { createTriageReadPullRequestStatusObserver } from './readPullRequestStatus.js';
import type { TriageDataActionContext } from './dataContext.js';

const fixture = createTriageSourceV1Fixture();
const status = TriagePullRequestStatusV1Schema.parse({
    kind: 'status', observedAtMs: 1000,
    checks: { state: 'complete', passed: 1, failed: 0, pending: 0, total: 1, incomplete: false,
        rows: [{ id: 'check:1', name: 'Unit tests', state: 'passed', required: true }] },
    review: { decision: 'approved', incomplete: false,
        reviewers: [{ id: 'user:reviewer', name: 'Reviewer', verb: 'approved' }] },
    merge: { state: 'mergeable', blocker: null, draft: false, nativeState: 'CLEAN',
        queue: null, autoMerge: { enabled: false, method: null }, canMergeWithoutWaiting: null },
    branch: { head: 'feature', base: 'main', headRevision: 'head-sha' }, facts: [],
});

function nativeOperation(occurrenceId = 'selected-source-a') {
    return { handle: 'exact-admitted-status', identity: {
        target: { pluginId: 'happier.triage' },
        point: { pointId: 'sources', protocol: { id: 'happier.triage/sources', version: 1 } },
        contributor: { pluginId: fixture.configuredInstance.instance.source.pluginId,
            contributionId: fixture.configuredInstance.instance.source.localId, occurrenceId,
            sourceCustody: { kind: 'development', registeredRootId: occurrenceId } },
        role: 'readPullRequestStatus',
    } satisfies AdmittedTargetedOperationIdentity };
}

async function boundary(options: Readonly<{ retired?: boolean; otherSource?: boolean; unsupported?: boolean; foreignCaller?: boolean; hostAgent?: boolean;
    replaceDuringRead?: boolean; removeDuringRead?: boolean; invalidateDuringRead?: boolean; unrelatedSourceChurnDuringRead?: boolean;
    removeSelectedDuringRead?: boolean; relabelDuringRead?: boolean; replaceBeforeWatch?: boolean; disposeNative?: () => Promise<void> }> = {}) {
    const { collections, control, watchableCollections } = createTestkitCorpusCollections();
    const configured = fixture.configuredInstance;
    const stored = toCorpusStoredValue({
        instanceTag: 'a'.repeat(43), sourceQualifiedId: `${configured.instance.source.pluginId}/${configured.instance.source.localId}`,
        lifecycle: options.retired ? CORPUS_SOURCE_INSTANCE_LIFECYCLE.retired : CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1000,
        configured: options.otherSource ? { ...configured, instance: { ...configured.instance, source: { pluginId: 'happier.other.forge', localId: 'other' } } } : configured,
        ...(options.retired ? { retiredReason: 'userRemoved' } : {}),
    });
    const seeded = control.sourceInstances.seed(stored);
    const controller = new AbortController();
    const sourceRows = { ...watchableCollections.sourceInstances,
        watch: ((selection, listener) => {
            if (options.replaceBeforeWatch) control.sourceInstances.seed(toCorpusStoredValue({ ...stored,
                configured: { ...configured, configuration: { ...configured.configuration, token: `${configured.configuration.token}-updated` } },
            }));
            return watchableCollections.sourceInstances.watch(selection, listener);
        }) satisfies typeof watchableCollections.sourceInstances.watch,
    };
    const requests: unknown[] = [];
    let disposed = false;
    let invalidate: (() => void) | undefined;
    const observed: unknown[] = [];
    let operationDisposed = false;
    let selectedOperation = nativeOperation();
    let unrelatedSourcePresent = false;
    let selectedSourcePresent = true;
    // Host-stamped context, Account persistence, admission and dispatch are genuine system boundaries.
    const context = {
        signal: controller.signal,
        surface: options.hostAgent ? 'agent' : 'plugin',
        ...(options.hostAgent ? {} : { caller: { kind: 'plugin', pluginId: options.foreignCaller ? 'happier.other.forge' : 'happier.triage' } }),
        services: {
            storage: { account: { collection: (definition: PluginAccountCollectionDefinition) => definition.id === CORPUS_SOURCE_INSTANCES_COLLECTION_ID ? sourceRows : collections.userMarks } },
            targetedContributions: { observeForSelf: (_point: unknown, observer: { onInvalidated(): void }) => {
                invalidate = observer.onInvalidated;
                return {
                readCurrent: async () => ({ contributions: [...(selectedSourcePresent ? [{
                    contributor: { pluginId: configured.instance.source.pluginId, contributionId: configured.instance.source.localId },
                    descriptor: fixture.descriptor,
                    operations: options.unsupported ? {} : { readPullRequestStatus: { ...selectedOperation,
                        identity: structuredClone(selectedOperation.identity) } },
                }] : []), ...(unrelatedSourcePresent ? [{
                    contributor: { pluginId: 'happier.other.forge', contributionId: 'other-forge' },
                    descriptor: fixture.descriptor, operations: {},
                }] : [])] }),
                dispose: () => { disposed = true; },
            }; } },
            actions: { observeAdmittedTargetedOperation: async (operation: unknown, input: unknown) => {
                observed.push({ operation, input });
                return { async dispose() { await options.disposeNative?.(); operationDisposed = true; } };
            }, executeAdmittedTargetedOperation: async (operation: unknown, input: unknown) => {
                requests.push({ operation, input });
                if (options.replaceDuringRead) control.sourceInstances.seed(toCorpusStoredValue({ ...stored,
                    configured: { ...configured, configuration: { ...configured.configuration, token: `${configured.configuration.token}-updated` } },
                }));
                if (options.relabelDuringRead) control.sourceInstances.seed(toCorpusStoredValue({ ...stored,
                    configured: { ...configured, locator: { ...configured.locator, v: 1, displayLabel: 'Renamed source' } },
                }));
                if (options.removeDuringRead) control.sourceInstances.tombstone(seeded.rowId);
                if (options.invalidateDuringRead) { selectedOperation = nativeOperation('selected-source-b'); invalidate?.(); }
                if (options.unrelatedSourceChurnDuringRead) { unrelatedSourcePresent = true; invalidate?.(); }
                if (options.removeSelectedDuringRead) { selectedSourcePresent = false; invalidate?.(); }
                return status;
            } },
        },
    } as unknown as TriageDataActionContext;
    const result = TriagePullRequestStatusResultV1Schema.parse(await createTriageReadPullRequestStatusActionHandler()({
        v: 1, entryRef: fixture.detailInput.observation.entryRef,
        sourceInstanceId: configured.instance.sourceInstanceId, lastKnownLocator: fixture.getInput.lastKnownLocator,
    }, context));
    return { result, requests, disposed, context, observed, operationDisposed: () => operationDisposed,
        sourceInstances: watchableCollections.sourceInstances, sourceInstanceRow: stored, sourceInstanceRowId: seeded.rowId,
        sourceGetCount: control.sourceInstances.getCallCount, abort: () => controller.abort() };
}

describe('the mounted PR-status action', () => {
    it.each([false, true])('uses one exact admitted source operation with the existing configured get input (host agent: %s)', async (hostAgent) => {
        const actual = await boundary({ hostAgent });
        expect(actual.result).toEqual(status);
        expect(actual.requests).toEqual([{ operation: nativeOperation(), input: fixture.getInput }]);
        expect(actual.disposed).toBe(true);
    });
    it.each([{ retired: true }, { otherSource: true }, { unsupported: true }, { foreignCaller: true }])('refuses unavailable or foreign authority without provider dispatch: %j', async (options) => {
        const actual = await boundary(options);
        expect(actual.result.kind).toBe('unavailable');
        expect(actual.requests).toEqual([]);
    });
    it.each([{ replaceDuringRead: true }, { removeDuringRead: true }, { invalidateDuringRead: true }, { removeSelectedDuringRead: true }])('finishes an admitted status read when source authority changes during the provider await: %j', async (options) => {
        const actual = await boundary(options);
        expect(actual.requests).toHaveLength(1);
        expect(actual.result).toEqual(status);
        expect(actual.sourceGetCount()).toBe(0);
        expect(actual.disposed).toBe(true);
    });
    it('refuses the next status request after source removal without dispatching another native read', async () => {
        const actual = await boundary({ removeDuringRead: true });
        expect(actual.result).toEqual(status);
        const result = await createTriageReadPullRequestStatusActionHandler()({
            v: 1, entryRef: fixture.detailInput.observation.entryRef,
            sourceInstanceId: fixture.configuredInstance.instance.sourceInstanceId,
        }, actual.context);
        expect(result).toEqual({ kind: 'unavailable', failure: { class: 'unsupportedContract', code: 'statusUnavailable' } });
        expect(actual.requests).toHaveLength(1);
    });
    it('admits the same selected operation after unrelated source registry churn during the provider read', async () => {
        const actual = await boundary({ unrelatedSourceChurnDuringRead: true });
        expect(actual.requests).toEqual([{ operation: nativeOperation(), input: fixture.getInput }]);
        expect(actual.result).toEqual(status);
        expect(actual.disposed).toBe(true);
    });
    it('admits the same configured authority after its presentation label changes during the provider read', async () => {
        const actual = await boundary({ relabelDuringRead: true });
        expect(actual.requests).toEqual([{ operation: nativeOperation(), input: fixture.getInput }]);
        expect(actual.result).toEqual(status);
        expect(actual.disposed).toBe(true);
    });
    it('attaches the exact source-native dependency without reading native status to observe it', async () => {
        const actual = await boundary();
        actual.requests.length = 0;
        const observation = await createTriageReadPullRequestStatusObserver()({ v: 1,
            entryRef: fixture.detailInput.observation.entryRef, sourceInstanceId: fixture.configuredInstance.instance.sourceInstanceId,
            lastKnownLocator: fixture.getInput.lastKnownLocator,
        }, Object.assign(() => {}, { retire() {} }), actual.context);
        expect(actual.requests).toEqual([]);
        expect(actual.observed).toEqual([{ operation: nativeOperation(), input: fixture.getInput }]);
        await observation.dispose();
        expect(actual.operationDisposed()).toBe(true);
    });
    it('awaits the native dependency cleanup and preserves its rejection for the public observer disposer', async () => {
        const error = new Error('native observer cleanup failed');
        let cleanupStarted = false;
        const actual = await boundary({ disposeNative: async () => { cleanupStarted = true; throw error; } });
        const observation = await createTriageReadPullRequestStatusObserver()({ v: 1,
            entryRef: fixture.detailInput.observation.entryRef, sourceInstanceId: fixture.configuredInstance.instance.sourceInstanceId,
        }, Object.assign(() => {}, { retire() {} }), actual.context);
        const cleanup = observation.dispose();
        expect(cleanupStarted).toBe(true);
        await expect(Promise.resolve(cleanup)).rejects.toBe(error);
    });
    it.each(['replace', 'remove'] as const)('retires only the exact configured authority on %s without reading native status', async change => {
        const actual = await boundary();
        actual.requests.length = 0;
        const invalidate = Object.assign(vi.fn(), { retire: vi.fn(() => actual.abort()) });
        const observation = await createTriageReadPullRequestStatusObserver()({ v: 1,
            entryRef: fixture.detailInput.observation.entryRef, sourceInstanceId: fixture.configuredInstance.instance.sourceInstanceId,
        }, invalidate, actual.context);
        try {
            const getCount = actual.sourceGetCount();
            await actual.sourceInstances.put(toCorpusStoredValue({ ...actual.sourceInstanceRow, instanceTag: 'b'.repeat(43),
                configured: { ...fixture.configuredInstance, instance: { ...fixture.configuredInstance.instance,
                    sourceInstanceId: '00000000-0000-4000-8000-000000000002' } },
            }), { expectedRevision: 'absent' });
            expect(actual.sourceGetCount()).toBe(getCount);
            expect(invalidate).not.toHaveBeenCalled();
            expect(invalidate.retire).not.toHaveBeenCalled();
            const current = await actual.sourceInstances.get(actual.sourceInstanceRowId);
            if (!current) throw new Error('The admitted source row must exist');
            if (change === 'remove') await actual.sourceInstances.delete(current.rowId, { expectedRevision: current.revision });
            else await actual.sourceInstances.put(toCorpusStoredValue({ ...actual.sourceInstanceRow,
                configured: { ...fixture.configuredInstance, configuration: { ...fixture.configuredInstance.configuration,
                    token: `${fixture.configuredInstance.configuration.token}-updated` } },
            }), { expectedRevision: current.revision });
            await vi.waitFor(() => expect(invalidate.retire).toHaveBeenCalledOnce());
            expect(actual.requests).toEqual([]);
        } finally { await observation.dispose(); }
    });
    it('ignores selected source presentation changes without invalidating native facts', async () => {
        const actual = await boundary();
        actual.requests.length = 0;
        const invalidate = Object.assign(vi.fn(), { retire: vi.fn(() => actual.abort()) });
        const observation = await createTriageReadPullRequestStatusObserver()({ v: 1,
            entryRef: fixture.detailInput.observation.entryRef, sourceInstanceId: fixture.configuredInstance.instance.sourceInstanceId,
        }, invalidate, actual.context);
        try {
            const getCount = actual.sourceGetCount();
            const row = await actual.sourceInstances.get(actual.sourceInstanceRowId);
            if (!row) throw new Error('The admitted source row must exist');
            await actual.sourceInstances.put(toCorpusStoredValue({ ...actual.sourceInstanceRow, configuredAtMs: 2000,
                configured: { ...fixture.configuredInstance, locator: { ...fixture.configuredInstance.locator,
                    v: 1, displayLabel: 'Renamed source' } },
            }), { expectedRevision: row.revision });
            await vi.waitFor(() => expect(actual.sourceGetCount()).toBeGreaterThan(getCount + 1));
            expect(invalidate).not.toHaveBeenCalled();
            expect(invalidate.retire).not.toHaveBeenCalled();
            expect(actual.requests).toEqual([]);
        } finally { await observation.dispose(); }
    });
    it('retires a source replaced between query admission and exact row-watch attachment before native observation', async () => {
        const actual = await boundary({ replaceBeforeWatch: true });
        actual.requests.length = 0;
        const invalidate = Object.assign(vi.fn(), { retire: vi.fn(() => actual.abort()) });
        await expect(createTriageReadPullRequestStatusObserver()({ v: 1,
            entryRef: fixture.detailInput.observation.entryRef, sourceInstanceId: fixture.configuredInstance.instance.sourceInstanceId,
        }, invalidate, actual.context)).rejects.toMatchObject({ name: 'AbortError' });
        expect(invalidate.retire).toHaveBeenCalledOnce();
        expect(actual.observed).toEqual([]);
        expect(actual.requests).toEqual([]);
    });
});
