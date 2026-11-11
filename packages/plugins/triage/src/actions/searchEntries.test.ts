import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk/collections';
import { PluginSearchResultV1Schema } from '@happier-dev/protocol';
import {
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    TriageConfiguredSourceInstanceV1Schema,
    type TriageScanResultV1,
    type TriageScanInputV1,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it, vi } from 'vitest';

import { CORPUS_SOURCE_INSTANCES_COLLECTION_ID, CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { createTestkitEmptyInternalTaskSource } from '../corpus/testkit/internalTaskSource.test-support.js';
import { testkitLocator, testkitSnapshot, testkitViewer } from '../corpus/testkit/observations.test-support.js';
import { parseTriageEntryDetailLaunchInput } from '../composer/entryDetailLaunchInput.js';
import { TRIAGE_APP_PAGE_LOCAL_ID_V1 } from '../composer/openEntryDetails.js';
import { createTriageSearchEntriesActionHandler } from './searchEntries.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { activate as activateAccount } from '../accountRuntime.js';
import { activate } from '../activate.js';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { TriageAdmittedSourceV1 } from './listEntries.js';

/**
 * The first real producer of `contributes.searchProviders`.
 *
 * It proves the whole vertical from the plugin's side: the declared query
 * Action answers the canonical `{ query, limit }` input with rows that satisfy
 * the canonical result schema, the rows come from the SAME canonical matcher
 * the list and Composer picker use, and each row's activation is the incumbent
 * open owner's exact launch input rather than a route the host would have to
 * understand.
 */

const SOURCE = Object.freeze({ pluginId: 'happier.example.source', localId: 'example-forge' });
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_DESCRIPTOR = {
    v: 1, purpose: 'triage-source', displayName: 'Example forge',
    kinds: [
        { id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Pull request' },
        { id: 'issue', workflowSubject: 'issue', displayName: 'Issue' },
    ],
};

type SearchEntryFixture = Readonly<{
    entryId: string;
    title: string;
    collisionScope?: string;
    scopeLabel?: string;
    present?: boolean;
    kindId?: string;
    designation?: string;
}>;

function createContext(snapshots: readonly SearchEntryFixture[], remoteQueries?: string[]): PluginAccountActionContext {
    const { collections, control } = createTestkitCorpusCollections();
    control.sourceInstances.seed(toCorpusStoredValue({
        instanceTag: `a${'0'.repeat(42)}`,
        sourceQualifiedId: `${SOURCE.pluginId}/${SOURCE.localId}`,
        lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
        configuredAtMs: 1,
        configured: TriageConfiguredSourceInstanceV1Schema.parse({
            v: 1,
            instance: { source: SOURCE, sourceInstanceId: INSTANCE_ID },
            binding: {
                purpose: 'triage-source',
                account: { service: { pluginId: SOURCE.pluginId, localId: 'accounts' }, accountId: 'account-1' },
            },
            localInstanceKey: 'example/repository',
            configuration: { v: 1, token: 'routing-token' },
        }),
    }));

    const internal = createTestkitEmptyInternalTaskSource();
    const internalScan = internal.contribution.operations.scan;
    // Host-created operation handles are the genuine admission/RPC boundary.
    const admitted = [{
        contributor: {
            pluginId: SOURCE.pluginId,
            contributionId: SOURCE.localId,
            immutableGenerationId: 'generation-1',
        },
        protocol: {
            id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
            version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
        },
        descriptor: SOURCE_DESCRIPTOR,
        operations: { listInstances: {}, scan: { role: 'scan' }, get: {} },
        surfaces: { detail: {} },
    } as unknown as TriageAdmittedSourceV1, internal.contribution];

    return {
        signal: new AbortController().signal,
        services: {
            storage: {
                account: {
                    collection: (definition: PluginAccountCollectionDefinition) => (
                        definition.id === CORPUS_SOURCE_INSTANCES_COLLECTION_ID
                            ? collections.sourceInstances
                            : collections.userMarks
                    ),
                },
            },
            targetedContributions: {
                observeForSelf: () => ({
                    readCurrent: async () => ({ generation: 'generation-1', contributions: admitted }),
                    dispose: () => {},
                }),
            },
            actions: {
                execute: async (action: string) => {
                    if (action !== 'tasks.internal.list') throw new Error(`Unexpected Action: ${action}`);
                    return internal.read();
                },
                // The source honours the page limit it is asked for, the way a
                // real one must: a page larger than requested breaks the scan
                // contract and the lane is refused, not silently truncated.
                executeAdmittedTargetedOperation: async (
                    operation: unknown,
                    scanInput: TriageScanInputV1,
                ): Promise<TriageScanResultV1> => {
                    if (operation === internalScan) return await internal.scan(internalScan, scanInput);
                    const pageLimit = scanInput.page.kind === 'initial'
                        ? scanInput.page.limit ?? snapshots.length
                        : snapshots.length;
                    const query = 'query' in scanInput && typeof scanInput.query === 'string' ? scanInput.query : '';
                    remoteQueries?.push(query);
                    const matching = remoteQueries === undefined || query === '' ? snapshots
                        : snapshots.filter(entry => entry.title.toLowerCase().includes(query.toLowerCase()));
                    const page = matching.slice(0, pageLimit);
                    return {
                        kind: 'complete',
                        observations: page.map((entry) => {
                            const localRef = {
                                kindId: entry.kindId ?? 'pull-request',
                                collisionScope: entry.collisionScope ?? 'example/repository',
                                entryId: entry.entryId,
                            };
                            return entry.present === false
                                ? { kind: 'absent' as const, localRef }
                                : {
                                    kind: 'present' as const,
                                    localRef,
                                    locator: testkitLocator(),
                                    snapshot: testkitSnapshot({
                                        title: entry.title,
                                        ...(entry.designation === undefined ? {} : { designation: entry.designation }),
                                        ...(entry.scopeLabel === undefined ? {} : { scopeLabel: entry.scopeLabel }),
                                    }),
                                    viewer: testkitViewer(),
                                };
                        }),
                        // A source that stopped at the page bound has NOT walked
                        // to the end, and saying otherwise here would let the
                        // window claim a coverage the reader does not have.
                        evidence: page.length === matching.length
                            ? { kind: 'walkFinished' }
                            : { kind: 'partial', reason: 'page-bound' },
                    };
                },
            },
        },
    } as unknown as PluginAccountActionContext;
}

describe('the Triage universal-search query Action', () => {
    it('finds a provider text match beyond the loaded page with one source search', async () => {
        const queries: string[] = [];
        const context = createContext([
            ...Array.from({ length: 8 }, (_, index) => ({ entryId: `${index}`, title: 'Recent change' })),
            { entryId: 'older', title: 'Older crash' },
        ], queries);
        const result = await createTriageSearchEntriesActionHandler()({ query: 'crash', limit: 8 }, context);
        expect(result.items.map(item => item.title)).toEqual(['Older crash']);
        expect(queries).toEqual(['crash']);
        expect(result.truncated).toBe(false);
    });

    it('declares and runs Account search without a client window or Machine', async () => {
        expect(PLUGIN_MANIFEST.contributes.actions.find(action => action.id === 'entries/search-v1')?.execution.target).toBe('account');
        const context = createContext([{ entryId: '17', title: 'Fix the transcript crash' }]);
        const result = PluginSearchResultV1Schema.parse(await createTriageSearchEntriesActionHandler()({ query: 'crash', limit: 8 }, context));
        expect(result.items).toEqual([expect.objectContaining({ title: 'Fix the transcript crash', icon: 'change-open' })]);
    });

    it('reads current Account entries on every query without retaining a client window', async () => {
        const entries = [{ entryId: '17', title: 'Old transcript title' }];
        const context = createContext(entries);
        const search = createTriageSearchEntriesActionHandler();
        expect((await search({ query: 'Old', limit: 8 }, context)).items).toHaveLength(1);
        entries[0] = { entryId: '17', title: 'New transcript title' };
        expect((await search({ query: 'Old', limit: 8 }, context)).items).toEqual([]);
        expect((await search({ query: 'New', limit: 8 }, context)).items).toEqual([
            expect.objectContaining({ title: 'New transcript title' }),
        ]);
    });

    it('uses the source-declared kind glyph and designation through the strict search consumer', async () => {
        const result = PluginSearchResultV1Schema.parse(await createTriageSearchEntriesActionHandler()({ query: 'cedar', limit: 8 },
            createContext([
                { entryId: '554', title: 'Cedar issue', kindId: 'issue', designation: '#554', scopeLabel: 'happier-dev/happier' },
                { entryId: '555', title: 'Cedar change', designation: '#555', scopeLabel: 'happier-dev/happier' },
            ])));
        expect(result.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ title: 'Cedar issue', icon: 'issue', subtitle: 'happier-dev/happier · #554' }),
            expect.objectContaining({ title: 'Cedar change', icon: 'change-open', subtitle: 'happier-dev/happier · #555' }),
        ]));
    });
    it.each(['root_not_found', 'ROOT_NOT_FOUND', 'unavailable', 'auth_required'])(
        'preserves a typed %s Account acquisition failure in the search result', async (code) => {
            const base = createContext([]);
            const context = { ...base, services: { ...base.services,
                storage: { account: { ...base.services.storage.account,
                    collection: () => { throw new PluginError({ code }); },
                } },
            } };
            const result = await createTriageSearchEntriesActionHandler()({ query: 'needle', limit: 8 }, context);
            expect(result).toEqual({ items: [], truncated: false,
                failure: { code: code === 'ROOT_NOT_FOUND' ? 'root_not_found' : code } });
            expect(PluginSearchResultV1Schema.safeParse(result).success).toBe(true);
        },
    );

    it('activates its declared Account search handler before any plugin page opens', async () => {
        const context = createContext([
            { entryId: '17', title: 'Fix the transcript crash' },
            { entryId: '18', title: 'Document the release flow' },
        ]);

        const action = PLUGIN_MANIFEST.contributes.actions.find(entry => entry.id === 'entries/search-v1');
        if (action?.execution.target !== 'account') throw new Error('Missing declared Account search Action');
        const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount } });
        try {
            const handler = plugin.registration('actions', action.id);
            if (!handler) throw new Error('Account search handler was not registered');
            const result = PluginSearchResultV1Schema.parse(await handler({ query: 'crash', limit: 8 }, context));
            expect(result.items.map(item => item.title)).toEqual(['Fix the transcript crash']);
            expect(result.truncated).toBe(false);
        } finally { await plugin.dispose(); }
    });

    it('activates through the incumbent open owner, carrying its exact launch input', async () => {
        const context = createContext([{ entryId: '17', title: 'Fix the transcript crash' }]);

        const result = await createTriageSearchEntriesActionHandler()({
            query: 'crash',
            limit: 8,
        }, context);

        const command = result.items[0]!.command;
        expect(command.kind).toBe('openSurface');
        if (command.kind !== 'openSurface') throw new Error('unreachable');
        // The one Triage destination, spelled as a same-plugin local id that the
        // host qualifies. No route, URL or callback crosses the wire.
        expect(command.destination).toBe(TRIAGE_APP_PAGE_LOCAL_ID_V1);
        // Admitted by the SAME parser `openTriageEntryDetails` uses.
        const parsed = parseTriageEntryDetailLaunchInput(command.input);
        expect(parsed.status).toBe('valid');
        if (parsed.status !== 'valid') throw new Error('unreachable');
        expect(parsed.input.entryRef.entryId).toBe('17');
        expect(parsed.input.sourceInstance.sourceInstanceId).toBe(INSTANCE_ID);
    });

    it('reports a bounded answer as bounded rather than complete', async () => {
        const context = createContext([
            { entryId: '17', title: 'Crash one' },
            { entryId: '18', title: 'Crash two' },
            { entryId: '19', title: 'Crash three' },
        ]);

        const result = await createTriageSearchEntriesActionHandler()({
            query: 'crash',
            limit: 1,
        }, context);

        expect(result.items).toHaveLength(1);
        expect(result.truncated).toBe(true);
    });

    it('derives fixed digest ids while preserving full search display text', async () => {
        const context = createContext([
            {
                entryId: 'e'.repeat(128),
                collisionScope: 's'.repeat(192),
                title: 'needle identity',
            },
            {
                entryId: 'display-entry',
                title: `needle ${'😀'.repeat(100)}${'a'.repeat(100)}`,
                scopeLabel: `scope ${'z'.repeat(300)}`,
            },
        ]);

        const result = await createTriageSearchEntriesActionHandler()({
            query: 'needle',
            limit: 8,
        }, context);

        expect(result.items).toHaveLength(2);
        expect(result.items.map((item) => item.id)).toEqual([
            expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
            expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        ]);
        expect(new Set(result.items.map((item) => item.id))).toHaveProperty('size', 2);
        expect(result.items).toContainEqual(expect.objectContaining({
            title: `needle ${'😀'.repeat(100)}${'a'.repeat(100)}`,
            subtitle: `scope ${'z'.repeat(300)}`,
        }));
        expect(PluginSearchResultV1Schema.safeParse(result).success).toBe(true);
        expect(result.truncated).toBe(false);
    });

    it('does not call a complete window truncated merely because an unopenable row is omitted', async () => {
        const context = createContext([{
            entryId: 'unopenable-entry',
            title: 'unused',
            present: false,
        }]);

        const result = await createTriageSearchEntriesActionHandler()({
            query: 'unopenable-entry',
            limit: 8,
        }, context);

        expect(result.items).toEqual([]);
        expect(result.truncated).toBe(false);
    });

    it('returns no rows for a query nothing matches', async () => {
        const context = createContext([{ entryId: '17', title: 'Fix the transcript crash' }]);

        const result = await createTriageSearchEntriesActionHandler()({
            query: 'nothing-matches-this',
            limit: 8,
        }, context);

        expect(result.items).toEqual([]);
    });

    it('forwards Account query cancellation to the scan and rejects its late result', async () => {
        const base = createContext([{ entryId: '17', title: 'Crash' }]);
        const cancellation = new AbortController();
        let scanSignal: AbortSignal | undefined;
        let settleScan!: () => void;
        const scanWait = new Promise<void>(resolve => { settleScan = resolve; });
        const execute = base.services.actions.executeAdmittedTargetedOperation;
        const pending = createTriageSearchEntriesActionHandler()({ query: 'crash', limit: 8 }, {
            ...base,
            signal: cancellation.signal,
            services: { ...base.services, actions: { ...base.services.actions,
                executeAdmittedTargetedOperation: async (operation, input, options) => {
                    scanSignal = options?.signal;
                    await scanWait;
                    return execute(operation, input, options);
                },
            } },
        });
        const rejected = expect(pending).rejects.toMatchObject({ code: 'plugin_action_aborted' });
        await vi.waitFor(() => expect(scanSignal).toBeDefined());
        expect(scanSignal).toBe(cancellation.signal);
        cancellation.abort();
        settleScan();
        await rejected;
    });
});
