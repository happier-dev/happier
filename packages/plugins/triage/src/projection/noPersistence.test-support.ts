import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import type { PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk/collections';
import type { AccountKvService, StorageScopeService } from '@happier-dev/plugin-sdk/storage';
import {
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    TriageConfiguredSourceInstanceV1Schema,
} from '@happier-dev/triage-protocol/v1';

import {
    createTriageListEntriesActionHandler,
    type TriageAdmittedOperationExecutorV1,
    type TriageAdmittedSourceV1,
} from '../actions/listEntries.js';
import type { TriageListEntriesInputV1 } from '../actions/listEntriesProtocol.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE, CORPUS_SOURCE_INSTANCES_COLLECTION_ID,
    CORPUS_SESSION_LINKS_COLLECTION_ID, CORPUS_USER_MARKS_COLLECTION_ID } from '../corpus/collections/ids.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import { createTestkitCorpusCollections, selectTestkitExternalSourceInput } from '../corpus/testkit/corpusCollections.test-support.js';
import { testkitLocator, testkitSnapshot, testkitViewer } from '../corpus/testkit/observations.test-support.js';
import { INTERNAL_TASK_DESCRIPTOR_V1 } from '../internalTasks/contribution.js';
import { INTERNAL_TASK_SOURCE_RECORD_V1 } from '../internalTasks/configuration.js';
import type { TaskList } from '../internalTasks/source.js';
import { createTestkitAccountKv } from '../settings/testkit/accountKv.test-support.js';

/** Trap actual persistence APIs in the calling realm, preserving their reads.
 * UI Vitest callers pass the adapter their module loader supplies; child-process
 * callers use the installed package API. All internal read owners remain real. */
export function installDeviceWriteTraps(options?: Readonly<{ asyncStorage?: object }>) {
    const attempts: string[] = [];
    const restorers: Array<() => void> = [];
    const refuse = (port: string): never => {
        attempts.push(port);
        throw new Error(`Provider-derived durable write: ${port}`);
    };
    const replace = (target: object, key: string, value: unknown) => {
        const previous = Object.getOwnPropertyDescriptor(target, key);
        Object.defineProperty(target, key, { configurable: true, writable: true, value });
        restorers.push(() => {
            if (previous) Object.defineProperty(target, key, previous);
            else Reflect.deleteProperty(target, key);
        });
    };
    const fallbackStorage = { length: 0, key: () => null, getItem: () => null };
    const windowValue: unknown = Reflect.get(globalThis, 'window');
    const existingWindow = typeof windowValue === 'object' && windowValue !== null ? windowValue : undefined;
    const globalStorage: unknown = Reflect.get(globalThis, 'localStorage');
    const windowStorage: unknown = existingWindow ? Reflect.get(existingWindow, 'localStorage') : undefined;
    const localStorage = typeof globalStorage === 'object' && globalStorage !== null ? globalStorage
        : typeof windowStorage === 'object' && windowStorage !== null ? windowStorage : fallbackStorage;
    if (globalStorage !== localStorage) replace(globalThis, 'localStorage', localStorage);
    if (existingWindow) {
        if (!windowStorage) replace(existingWindow, 'localStorage', localStorage);
    } else {
        replace(globalThis, 'window', { localStorage });
    }
    for (const storage of new Set([localStorage, ...(typeof windowStorage === 'object' && windowStorage !== null ? [windowStorage] : [])])) {
        for (const method of ['setItem', 'removeItem', 'clear']) {
            replace(storage, method, () => refuse(`localStorage.${method}`));
        }
    }

    const require = createRequire(new URL('../../../../../apps/ui/package.json', import.meta.url));
    // createRequire bypasses Vitest's module mocks: inject its actual UI adapter
    // when the calling realm uses the canonical native-storage boundary fixture.
    const asyncStorage = options?.asyncStorage
        ?? (require('@react-native-async-storage/async-storage') as { default: object }).default;
    for (const method of ['setItem', 'mergeItem', 'multiSet', 'multiMerge', 'removeItem', 'multiRemove', 'clear']) {
        replace(asyncStorage, method, () => refuse(`AsyncStorage.${method}`));
    }
    for (const method of ['writeFile', 'appendFile', 'writeFileSync', 'appendFileSync', 'createWriteStream']) {
        replace(fs, method, () => refuse(`fs.${method}`));
    }
    for (const method of ['writeFile', 'appendFile']) {
        replace(fs.promises, method, () => refuse(`fs.promises.${method}`));
    }
    syncBuiltinESMExports();

    // A disconnected trap must not let a no-write claim pass vacuously.
    const localSetItem: unknown = Reflect.get(localStorage, 'setItem');
    assert.ok(typeof localSetItem === 'function');
    assert.throws(() => Reflect.apply(localSetItem, localStorage, ['probe', 'probe']), /Provider-derived durable write/);
    const setItem: unknown = Reflect.get(asyncStorage, 'setItem');
    assert.ok(typeof setItem === 'function');
    assert.throws(() => Reflect.apply(setItem, asyncStorage, ['probe', 'probe']), /Provider-derived durable write/);
    assert.throws(() => fs.writeFileSync('qb84-write-must-never-exist', 'probe'), /Provider-derived durable write/);
    assert.deepEqual(attempts, ['localStorage.setItem', 'AsyncStorage.setItem', 'fs.writeFileSync']);
    attempts.length = 0;
    return {
        attempts,
        restore() {
            for (const restore of restorers.reverse()) restore();
            syncBuiltinESMExports();
        },
    };
}

export const NO_PERSISTENCE_EXTERNAL_INSTANCE_IDS = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
] as const;
export const NO_PERSISTENCE_INSTANCE_IDS = [
    ...NO_PERSISTENCE_EXTERNAL_INSTANCE_IDS,
    INTERNAL_TASK_SOURCE_RECORD_V1.value.configured.instance.sourceInstanceId,
] as const;

/** The existing composed Action fixture: only host admission, dispatch and
 * durable storage ports are replaced. All list/fold/refresh logic remains real. */
export function createNoPersistenceTriageFixture(options?: Readonly<{
    taskRead?: () => Promise<TaskList>;
    sourceInstanceIds?: readonly string[];
    seedSourceInstances?: boolean;
    externalOnly?: boolean;
}>) {
    const { collections, control } = createTestkitCorpusCollections();
    const source = { pluginId: 'happier.example.source', localId: 'example-forge' };
    for (const [index, sourceInstanceId] of (options?.seedSourceInstances === false ? [] : options?.sourceInstanceIds ?? NO_PERSISTENCE_EXTERNAL_INSTANCE_IDS).entries()) {
        control.sourceInstances.seed(toCorpusStoredValue({
            instanceTag: `${index === 0 ? 'a' : 'b'}${'0'.repeat(42)}`,
            sourceQualifiedId: `${source.pluginId}/${source.localId}`,
            lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
            configuredAtMs: index + 1,
            configured: TriageConfiguredSourceInstanceV1Schema.parse({
                v: 1,
                instance: { source, sourceInstanceId },
                binding: { purpose: 'triage-source', account: {
                    service: { pluginId: source.pluginId, localId: 'accounts' }, accountId: `account-${index + 1}`,
                } },
                localInstanceKey: `example/repository-${index + 1}`,
                configuration: { v: 1, token: 'routing-token' },
            }),
        }));
    }

    const durableWriteAttempts: string[] = [];
    const rejectDurableWrite = (boundary: string): never => {
        durableWriteAttempts.push(boundary);
        throw new Error(`The list pass attempted durable storage: ${boundary}`);
    };
    const rejectWrites = (handle: (typeof collections)[keyof typeof collections]) => ({
        ...handle,
        get: handle.get.bind(handle),
        query: handle.query.bind(handle),
        put: () => rejectDurableWrite('Collection put'),
        delete: () => rejectDurableWrite('Collection delete'),
        batch: () => rejectDurableWrite('Collection batch'),
        forget: () => rejectDurableWrite('Collection forget'),
    });
    const allowedCollections = new Map([
        [CORPUS_SOURCE_INSTANCES_COLLECTION_ID, rejectWrites(collections.sourceInstances)],
        [CORPUS_SESSION_LINKS_COLLECTION_ID, rejectWrites(collections.sessionLinks)],
        [CORPUS_USER_MARKS_COLLECTION_ID, rejectWrites(collections.userMarks)],
    ]);
    const { kv } = createTestkitAccountKv();
    const accountKv: AccountKvService = {
        ...kv,
        set: () => rejectDurableWrite('Account KV set'),
        delete: () => rejectDurableWrite('Account KV delete'),
        transaction: async operation => operation(accountKv),
    };
    const daemonKv: StorageScopeService = {
        get: async () => null,
        list: async () => ({ items: [] }),
        consistency: () => ({ kind: 'authoritativeSerializable' }),
        set: () => rejectDurableWrite('daemon KV set'),
        delete: () => rejectDurableWrite('daemon KV delete'),
        transaction: async operation => operation(daemonKv),
    };
    const scannedPages = new Map<string, string[]>();
    const defaultScan: TriageAdmittedOperationExecutorV1 = async (_operation, input) => {
        const sourceInstanceId = input.instance.instance.sourceInstanceId;
        const observation = {
            kind: 'present',
            localRef: {
                kindId: sourceInstanceId === NO_PERSISTENCE_INSTANCE_IDS[2] ? 'task' : 'pull-request',
                collisionScope: 'example/repository', entryId: `${sourceInstanceId}-${input.page.kind}`,
            },
            locator: testkitLocator(), snapshot: testkitSnapshot(), viewer: testkitViewer(),
        } as const;
        return input.page.kind === 'initial'
            ? { kind: 'page', observations: [observation], evidence: { kind: 'partial', reason: 'more-pages' },
                continuation: { v: 1, token: `page-2-${sourceInstanceId}` } }
            : { kind: 'complete', observations: [observation], evidence: { kind: 'walkFinished' } };
    };
    let scan = defaultScan;
    // Admitted handles are issued by the host, not constructible by plugin code.
    const admitted = {
        contributor: { pluginId: source.pluginId, contributionId: source.localId, immutableGenerationId: 'generation-1' },
        protocol: { id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1 },
        descriptor: { v: 1, purpose: 'triage-source', displayName: 'Example forge',
            kinds: [{ id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Pull request' }] },
        operations: { listInstances: {}, scan: {}, get: {} }, surfaces: { detail: {} },
    } as unknown as TriageAdmittedSourceV1;
    const actionInputs: TriageListEntriesInputV1[] = [];
    const context = {
        signal: new AbortController().signal,
        services: {
            storage: {
                daemonSession: daemonKv,
                daemon: { ...daemonKv, database: () => rejectDurableWrite('daemon database') },
                account: {
                    kv: accountKv,
                    collection: (definition: PluginAccountCollectionDefinition) =>
                        allowedCollections.get(definition.id) ?? rejectDurableWrite(`undeclared Collection ${definition.id}`),
                },
            },
            targetedContributions: { observeForSelf: () => ({
                readCurrent: async () => ({ generation: 'generation-1', contributions: [admitted, {
                    ...admitted,
                    contributor: { ...admitted.contributor,
                        pluginId: INTERNAL_TASK_SOURCE_RECORD_V1.value.configured.instance.source.pluginId,
                        contributionId: INTERNAL_TASK_SOURCE_RECORD_V1.value.configured.instance.source.localId },
                    descriptor: INTERNAL_TASK_DESCRIPTOR_V1,
                }] }),
                dispose: () => {},
            }) },
            actions: { execute: async (id: string) => {
                if (id !== 'tasks.internal.list') throw new Error(`Unexpected host Action ${id}`);
                if (options?.taskRead !== undefined) return options.taskRead();
                const taskId = `${NO_PERSISTENCE_INSTANCE_IDS[2]}-initial`;
                // Native Tasks now consume one host TaskList, rather than a second
                // source-dispatch read. Only that genuine host RPC port is replaced.
                return { status: 'ok', scope: { serverId: 'home', accountId: 'account' },
                    todos: [{ id: taskId, title: 'Native Task', done: false, state: 'unstarted', createdAt: 1, updatedAt: 1 }],
                    undoneOrder: [taskId], completedOrder: [],
                } satisfies TaskList;
            }, executeAdmittedTargetedOperation: async (...args: Parameters<TriageAdmittedOperationExecutorV1>) => {
                const sourceInstanceId = args[1].instance.instance.sourceInstanceId;
                const pages = scannedPages.get(sourceInstanceId) ?? [];
                pages.push(args[1].page.kind);
                scannedPages.set(sourceInstanceId, pages);
                return await scan(...args);
            } },
        },
    } as unknown as PluginAccountActionContext;
    const handler = createTriageListEntriesActionHandler();
    return {
        durableWriteAttempts, scannedPages, actionInputs, defaultScan, collections, control, admitted,
        async verifyDurableWriteTraps() {
            for (const handle of allowedCollections.values()) {
                for (const method of ['put', 'delete', 'batch', 'forget'] as const) {
                    await assert.rejects(async () => Reflect.apply(handle[method], handle, []),
                        new RegExp(`The list pass attempted durable storage: Collection ${method}`));
                }
            }
            assert.deepEqual(durableWriteAttempts, [...allowedCollections.values()].flatMap(() =>
                ['Collection put', 'Collection delete', 'Collection batch', 'Collection forget']));
            durableWriteAttempts.length = 0;
        },
        setScan(next: TriageAdmittedOperationExecutorV1) { scan = next; },
        async readEntries(input: TriageListEntriesInputV1, cancellation?: Readonly<{ signal?: AbortSignal }>) {
            const selected = options?.externalOnly
                ? await selectTestkitExternalSourceInput(input, collections.sourceInstances) : input;
            actionInputs.push(selected);
            return await handler(selected, { ...context, signal: cancellation?.signal ?? context.signal });
        },
    };
}
