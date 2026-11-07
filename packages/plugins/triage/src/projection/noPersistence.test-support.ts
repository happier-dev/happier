import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
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
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { testkitLocator, testkitSnapshot, testkitViewer } from '../corpus/testkit/observations.test-support.js';
import { INTERNAL_TASK_DESCRIPTOR_V1 } from '../internalTasks/contribution.js';
import { INTERNAL_TASK_SOURCE_RECORD_V1 } from '../internalTasks/configuration.js';
import type { TaskList } from '../internalTasks/source.js';
import { createTestkitAccountKv } from '../settings/testkit/accountKv.test-support.js';

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
export function createNoPersistenceTriageFixture() {
    const { collections, control } = createTestkitCorpusCollections();
    const source = { pluginId: 'happier.example.source', localId: 'example-forge' };
    for (const [index, sourceInstanceId] of NO_PERSISTENCE_EXTERNAL_INSTANCE_IDS.entries()) {
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
        batch: () => rejectDurableWrite('Collection batch'),
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
        durableWriteAttempts, scannedPages, actionInputs, defaultScan,
        setScan(next: TriageAdmittedOperationExecutorV1) { scan = next; },
        async readEntries(input: TriageListEntriesInputV1) {
            actionInputs.push(input);
            return await handler(input, context);
        },
    };
}
