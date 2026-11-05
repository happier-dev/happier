import { PluginError, type JsonValue, type PluginApi, type PluginAccountApi, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk/collections';
import { describe, expect, it } from 'vitest';

import { activate } from '../activate.js';
import { activate as activateAccount } from '../accountRuntime.js';
import type { CorpusCollectionsV1 } from '../corpus/collections/bindCorpusCollections.js';
import {
    CORPUS_SESSION_LINKS_COLLECTION_ID,
    CORPUS_SESSION_LINKS_INDEX_ID,
    CORPUS_SOURCE_INSTANCES_COLLECTION_ID,
    CORPUS_SOURCE_INSTANCE_LIFECYCLE,
} from '../corpus/collections/ids.js';
import { fromCorpusStoredRow } from '../corpus/collections/rowCodec.js';
import type { CorpusSessionLinkRowV1 } from '../corpus/collections/rows.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { testkitEntryRef, testkitLocator } from '../corpus/testkit/observations.test-support.js';
import { TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1, TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1, TriageReadSourceSessionLinksResultV1Schema,
    TriageReadSourceSessionLinksActionResultV1Schema, normalizeTriageSourceSessionLinksCoverageV1 } from './sessionLinksProtocol.js';
import { TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1, TRIAGE_UNLINK_ENTRY_FROM_SESSION_ACTION_LOCAL_ID_V1 } from './entrySessionProtocol.js';
import { TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1, TriageReadEntryDetailResultV1Schema } from './entryDetailProtocol.js';
import { triageEntryDragSourceRuntime, triageEntrySessionDropTargetRuntime } from '../ui/list/entryDragDrop.js';
import { testkitConfiguredInstance, testkitReadOnlySourceSnapshot, TESTKIT_DELIVERY_REQUEST, createTestkitActionInvoker } from '../sessions/testkit/entrySessionTestkit.test-support.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import { linkEntryToSession } from '../sessions/entrySessionLinks.js';

/**
 * The registered writer of `session-links`.
 *
 * A mounted Plugin UI surface holds a Host API with no storage member, so an
 * Action is the only transport between the surface that starts work on an entry
 * and the one canonical link writer. Without a registered one the Collection is
 * declared, admitted, queried by the Session cockpit — and structurally unable
 * to ever hold a row.
 *
 * The seam is exercised through `activate`, not through the handler factory: a
 * handler nothing registers is exactly the defect this proves is gone.
 */

const NOW_BEFORE_MS = 1_760_000_900_000;

function registeredLinkHandler(localId = TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1): ActionHandler<JsonValue, JsonValue> {
    const handlers = new Map<string, ActionHandler<JsonValue, JsonValue>>();
    const api = {
        actions: {
            register: (id: string, handler: ActionHandler<JsonValue, JsonValue>) => {
                handlers.set(id, handler);
            },
        },
        composerAttachments: { register: () => {} },
    } as unknown as PluginApi & PluginAccountApi;

    activate(api);
    activateAccount(api);
    const handler = handlers.get(localId);
    if (handler === undefined) {
        throw new Error(
            `activation registers no handler for "${TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1}"`,
        );
    }
    return handler;
}

function createContext(collections: CorpusCollectionsV1, snapshot = testkitReadOnlySourceSnapshot()): PluginInvocationContext {
    return {
        signal: new AbortController().signal,
        services: {
            targetedContributions: { observeForSelf: () => ({
                readCurrent: async () => snapshot, dispose: () => {},
            }) },
            storage: {
                account: {
                    collection: (definition: PluginAccountCollectionDefinition) => {
                        if (definition.id === CORPUS_SESSION_LINKS_COLLECTION_ID) {
                            return collections.sessionLinks;
                        }
                        return definition.id === CORPUS_SOURCE_INSTANCES_COLLECTION_ID
                            ? collections.sourceInstances
                            : collections.userMarks;
                    },
                },
            },
        },
    } as unknown as PluginInvocationContext;
}

it('preserves a whole-read Collection refusal instead of returning an undiagnosable failed result', async () => {
    const { collections } = createTestkitCorpusCollections();
    const refused = new PluginError({ code: 'plugin_collection_unavailable', retryable: false,
        details: { requestId: 'collection-read-request-1' } });
    // Persistent Collection transport is the only replaced boundary.
    const context = createContext({ ...collections, sourceInstances: { ...collections.sourceInstances,
        query: async () => { throw refused; } } });
    await expect(registeredLinkHandler(TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1)(
        { v: 1, sessionId: 'session-a' }, { ...context, surface: 'ui' })).rejects.toBe(refused);
});

async function readLinkRows(
    collections: CorpusCollectionsV1,
    sessionId: string,
): Promise<readonly CorpusSessionLinkRowV1[]> {
    const page = await collections.sessionLinks.query({
        index: CORPUS_SESSION_LINKS_INDEX_ID.bySession,
        prefix: [sessionId],
        order: 'asc',
        limit: 64,
    });
    return page.rows.map((row) => fromCorpusStoredRow<CorpusSessionLinkRowV1>(row).value);
}

describe('the session-link writer Action', () => {
    it('preserves source setup recovery through the registered Action only for unscoped Session reads', async () => {
        const { collections } = createTestkitCorpusCollections();
        const admitted = testkitReadOnlySourceSnapshot();
        const snapshot = { contributions: admitted.contributions.map(contribution => ({
            ...contribution, descriptor: { ...contribution.descriptor, settingsPageId: 'triage-sources' },
        })) };
        const context = { ...createContext(collections, snapshot), surface: 'api' as const };
        const read = registeredLinkHandler(TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1);
        const unscoped = TriageReadSourceSessionLinksResultV1Schema.parse(await read({ v: 1, sessionId: 'session-a' }, context));
        expect(unscoped.configureSources).toEqual([{
            destination: { pluginId: admitted.contributions[0]!.contributor.pluginId, localId: 'triage-sources' },
            displayName: 'Example source', kindNames: ['Pull request', 'Issue'],
        }]);
        const scoped = TriageReadSourceSessionLinksResultV1Schema.parse(await read({ v: 1, entryRef: testkitEntryRef() }, context));
        expect(scoped).not.toHaveProperty('configureSources');
    });
    it('codes a retained configured source missing from the admitted Machine view without invoking credentials', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        const base = testkitConfiguredInstance();
        const configured = { ...base, instance: { ...base.instance,
            source: { pluginId: 'acme.ledger', localId: 'acme-ledger' } },
            locator: { ...base.locator, displayLabel: 'acme/ledger' } };
        control.sourceInstances.seed(toCorpusStoredValue({ instanceTag: 'z'.repeat(43),
            lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1,
            sourceQualifiedId: 'acme.ledger/acme-ledger', configured }));
        const result = TriageReadSourceSessionLinksResultV1Schema.parse(await registeredLinkHandler(
            TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1)({ v: 1, sessionId: 'session-a' },
                { ...createContext(collections), surface: 'api' }));
        expect(result.lanes).toContainEqual(expect.objectContaining({ source: configured.instance.source,
            displayLabel: 'acme/ledger', health: { kind: 'failed', failure: {
                class: 'unsupportedContract', code: 'sessionLinksSourceNotAdmitted',
            } } }));
    });
    it('reads a list of corpus-owned entry links with one set-shaped storage query', async () => {
        const { collections: backing, control } = createTestkitCorpusCollections();
        const configured = testkitConfiguredInstance();
        control.sourceInstances.seed(toCorpusStoredValue({ instanceTag: 'a'.repeat(43),
            lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1,
            sourceQualifiedId: `${configured.instance.source.pluginId}/${configured.instance.source.localId}`, configured,
        }));
        const entries = Array.from({ length: 64 }, (_, index) => ({ entryRef: {
            ...testkitEntryRef(), entryId: String(index + 1),
        } }));
        for (const { entryRef } of entries) await linkEntryToSession({ collections: backing, entryRef,
            sessionId: `session-${entryRef.entryId}`, display: { locator: testkitLocator(), scopeLabel: 'example/repository' }, nowMs: 1 });
        let reads = 0;
        const collections: CorpusCollectionsV1 = { ...backing, sessionLinks: { ...backing.sessionLinks,
            query: async (...args: Parameters<typeof backing.sessionLinks.query>) => {
                reads++;
                return backing.sessionLinks.query(...args);
            },
        } };
        const context = { ...createContext(collections), surface: 'api' } as PluginInvocationContext;
        const result = TriageReadSourceSessionLinksActionResultV1Schema.parse(await registeredLinkHandler(
            TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1)({ v: 1, entries }, context));
        expect(result.kind).toBe('entries');
        if (result.kind !== 'entries') throw new Error('Expected entry results');
        expect(result.entries.map(entry => entry.result.links.map(link => link.sessionId)))
            .toEqual(entries.map(({ entryRef }) => [`session-${entryRef.entryId}`]));
        expect(reads).toBe(1);
    });
    it('keeps prior source-wide replies explicitly incomplete instead of guessing kind coverage from their rows', () => {
        const configured = testkitConfiguredInstance();
        const prior = TriageReadSourceSessionLinksResultV1Schema.parse({ kind: 'complete', links: [], lanes: [{
            source: configured.instance.source, sourceInstanceId: configured.instance.sourceInstanceId,
            displayLabel: 'Prior source', health: { kind: 'complete' },
        }] });
        expect(normalizeTriageSourceSessionLinksCoverageV1(prior)).toMatchObject({ kind: 'failed',
            lanes: [{ health: { kind: 'unavailable' } }],
        });
        expect(normalizeTriageSourceSessionLinksCoverageV1({ kind: 'complete', links: [] }).kind).toBe('failed');
        expect(normalizeTriageSourceSessionLinksCoverageV1({ kind: 'complete', links: [], lanes: [],
            nextCursor: 'unproven-continuation' }).kind).toBe('failed');
        expect(TriageReadSourceSessionLinksResultV1Schema.safeParse({ ...prior,
            lanes: [{ ...prior.lanes![0], kindIds: ['issue', 'issue'] }],
        }).success).toBe(false);
    });
    it('gathers a demanded entry window through one configured and admitted view with independent coverage', async () => {
        const { collections: backing, control } = createTestkitCorpusCollections();
        const configured = testkitConfiguredInstance();
        control.sourceInstances.seed(toCorpusStoredValue({ instanceTag: `a${'0'.repeat(42)}`,
            lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1,
            sourceQualifiedId: `${configured.instance.source.pluginId}/${configured.instance.source.localId}`, configured,
        }));
        const entries = Array.from({ length: 100 }, (_, index) => ({ ...testkitEntryRef(), entryId: String(index) }));
        for (const entryRef of entries) await linkEntryToSession({ collections: backing, entryRef, sessionId: `session-${entryRef.entryId}`,
            display: { locator: testkitLocator(), scopeLabel: 'example/repository' }, nowMs: 1 });
        let configurationReads = 0;
        let admittedReads = 0;
        let corpusReads = 0;
        const collections: CorpusCollectionsV1 = { ...backing,
            sourceInstances: { ...backing.sourceInstances, query: async (...args: Parameters<typeof backing.sourceInstances.query>) => {
                configurationReads++; return await backing.sourceInstances.query(...args);
            } },
            sessionLinks: { ...backing.sessionLinks, query: async (...args: Parameters<typeof backing.sessionLinks.query>) => {
                corpusReads++; return await backing.sessionLinks.query(...args);
            } },
        };
        const base = createContext(collections);
        const context = { ...base, surface: 'api', services: { ...base.services,
            targetedContributions: { observeForSelf: () => ({ readCurrent: async () => {
                admittedReads++; return testkitReadOnlySourceSnapshot();
            }, dispose: () => {} }) },
        } } as unknown as PluginInvocationContext;
        const result = TriageReadSourceSessionLinksActionResultV1Schema.parse(await registeredLinkHandler(
            TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1)({ v: 1, entries: [
                ...entries.map(entryRef => ({ entryRef, sourceInstanceId: configured.instance.sourceInstanceId })),
                { entryRef: { ...testkitEntryRef(), kindId: 'unknown-kind' }, sourceInstanceId: configured.instance.sourceInstanceId },
            ] }, context));
        expect(result.kind).toBe('entries');
        if (result.kind !== 'entries') throw new Error('Expected independently covered entry relations');
        expect(result.entries.slice(0, 100).map(({ result }) => result)).toEqual(entries.map(entryRef => expect.objectContaining({
            kind: 'complete', links: [expect.objectContaining({ entryRef, sessionId: `session-${entryRef.entryId}` })],
        })));
        expect(result.entries[100]?.result).toMatchObject({ kind: 'failed', links: [] });
        expect({ configurationReads, admittedReads, corpusReads }).toEqual({ configurationReads: 1, admittedReads: 1, corpusReads: 1 });
    });
    it('keeps per-entry source authority and health when a shared corpus set read fails', async () => {
        const { collections: backing, control } = createTestkitCorpusCollections();
        const configured = testkitConfiguredInstance();
        control.sourceInstances.seed(toCorpusStoredValue({ instanceTag: 'a'.repeat(43),
            lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1,
            sourceQualifiedId: `${configured.instance.source.pluginId}/${configured.instance.source.localId}`, configured,
        }));
        const collections = { ...backing, sessionLinks: { ...backing.sessionLinks,
            query: async () => { throw new Error('Corpus temporarily unavailable'); },
        } };
        const base = createContext(collections);
        const context = { ...base, surface: 'api', services: { ...base.services,
            targetedContributions: { observeForSelf: () => ({ readCurrent: async () => ({ contributions: [{
                ...testkitReadOnlySourceSnapshot().contributions[0],
                descriptor: { v: 1, purpose: 'triage-source', displayName: 'Mixed source',
                    kinds: [{ id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'PR' },
                        { id: 'issue', workflowSubject: 'issue', displayName: 'Issue' }],
                    sessionRelations: { kindIds: ['pull-request'] },
                },
                operations: { readSessionLinks: { role: 'readSessionLinks' }, linkSession: { role: 'linkSession' } },
            }] }), dispose() {} }) },
            actions: { executeAdmittedTargetedOperation: async (_operation: unknown, input: { localRef: { entryId: string } }) => {
                if (input.localRef.entryId === 'denied') return { kind: 'failed', failure: { class: 'transient', code: 'sourceDenied' } };
                return { kind: 'complete', links: [{ localRef: { kindId: 'pull-request',
                    collisionScope: testkitEntryRef().collisionScope, entryId: input.localRef.entryId },
                    sessionId: 'session-native', linkedAtMs: 1, displayPath: 'Native PR' }] };
            } },
        } } as unknown as PluginInvocationContext;
        const result = TriageReadSourceSessionLinksActionResultV1Schema.parse(await registeredLinkHandler(
            TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1)({ v: 1, entries: [
                { entryRef: { ...testkitEntryRef(), entryId: 'healthy' } },
                { entryRef: { ...testkitEntryRef(), entryId: 'denied' } },
                { entryRef: { ...testkitEntryRef(), kindId: 'issue' } },
            ] }, context));
        expect(result.kind).toBe('entries');
        if (result.kind !== 'entries') throw new Error('Expected entry results');
        expect(result.entries[0]?.result).toMatchObject({ kind: 'complete', links: [{ sessionId: 'session-native' }] });
        expect(result.entries[1]?.result).toMatchObject({ kind: 'failed', links: [], lanes: [{ health: {
            kind: 'failed', failure: { code: 'sourceDenied' },
        } }] });
        expect(result.entries[2]?.result).toMatchObject({ kind: 'failed', links: [], lanes: [{ health: { kind: 'failed' } }] });
    });
    it('reads exact detail and source links through one current configuration view', async () => {
        const { collections: backing, control } = createTestkitCorpusCollections();
        let configurationReads = 0;
        // Account Collection I/O is the boundary; query admission/decoding and
        // the registered detail/relationship owners still execute unchanged.
        const collections: CorpusCollectionsV1 = { ...backing, sourceInstances: {
            ...backing.sourceInstances,
            query: async (input, options) => {
                configurationReads++;
                return await backing.sourceInstances.query(input, options);
            },
        } };
        const configured = testkitConfiguredInstance();
        const row = {
            instanceTag: `a${'0'.repeat(42)}`, lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
            configuredAtMs: 1, sourceQualifiedId: `${configured.instance.source.pluginId}/${configured.instance.source.localId}`,
            configured,
        } as const;
        control.sourceInstances.seed(toCorpusStoredValue(row));
        const base = createContext(collections);
        const snapshot = testkitReadOnlySourceSnapshot();
        let sourceReads = 0;
        const context = { ...base, surface: 'api', services: { ...base.services,
            targetedContributions: { observeForSelf: () => ({ readCurrent: async () => ({ contributions: [
                { ...snapshot.contributions[0], operations: { readSessionLinks: { role: 'readSessionLinks' } } },
            ] }), dispose: () => {} }) },
            actions: { executeAdmittedTargetedOperation: async () => {
                sourceReads++;
                return { kind: 'complete', links: [{
                    localRef: { kindId: 'pull-request', collisionScope: 'example/repository', entryId: '17' },
                    sessionId: 'session-a', linkedAtMs: 10, displayPath: 'Linked work',
                }] };
            } },
        } } as unknown as PluginInvocationContext;
        const handler = registeredLinkHandler(TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1);
        const input = { v: 1, entryRef: testkitEntryRef(), sourceInstanceId: configured.instance.sourceInstanceId };
        expect(TriageReadEntryDetailResultV1Schema.parse(await handler(input, context)))
            .toMatchObject({ kind: 'read', instance: configured, linkedSessions: [{ sessionId: 'session-a' }] });
        expect(sourceReads).toBe(1);
        expect(configurationReads).toBe(1);

        control.sourceInstances.seed(toCorpusStoredValue({ ...row,
            lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.retired, retiredReason: 'userRemoved',
        }));
        expect(await handler(input, context)).toEqual({ kind: 'unavailable' });
        expect(configurationReads).toBe(2);
        expect(sourceReads).toBe(1);
    });

    it.each(['ui', 'voice', 'cli', 'agent', 'self', 'otherPlugin'] as const)('returns healthy source links and explicit unavailable coverage to %s callers', async (caller) => {
        const { collections, control } = createTestkitCorpusCollections();
        const configured = testkitConfiguredInstance();
        const unavailable = { ...configured,
            instance: { source: { pluginId: 'acme.uninstalled', localId: 'items' },
                sourceInstanceId: '22222222-2222-4222-8222-222222222222' },
            locator: { v: 1 as const, displayLabel: 'Retained source' },
        };
        for (const [index, instance] of [configured, unavailable].entries()) control.sourceInstances.seed(toCorpusStoredValue({
            instanceTag: `${index}${'a'.repeat(42)}`, lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
            configuredAtMs: 1, sourceQualifiedId: `${instance.instance.source.pluginId}/${instance.instance.source.localId}`,
            configured: instance,
        }));
        const base = createContext(collections);
        const snapshot = testkitReadOnlySourceSnapshot();
        let unavailableRead = false;
        const context = { ...base, surface: caller === 'self' || caller === 'otherPlugin' ? 'ui' : caller,
            ...(caller === 'self' || caller === 'otherPlugin' ? { caller: { kind: 'plugin',
                pluginId: caller === 'self' ? 'happier.triage' : 'example.other-plugin' } } : {}),
            services: { ...base.services,
                targetedContributions: { observeForSelf: () => ({ readCurrent: async () => ({ contributions: [
                    { ...snapshot.contributions[0], operations: { readSessionLinks: { role: 'readSessionLinks' } } },
                ] }), dispose: () => {} }) },
                // The host's admitted-operation transport is the boundary; the
                // registered aggregate and relationship read below stay real.
                actions: { executeAdmittedTargetedOperation: async () => unavailableRead
                    ? { kind: 'failed', failure: { class: 'transient', code: 'accountDataUnavailable' } }
                    : ({ kind: 'complete', links: [{
                    localRef: { kindId: 'pull-request', collisionScope: 'example/repository', entryId: '17' },
                    sessionId: 'session-a', linkedAtMs: 10, displayPath: 'Healthy linked work',
                }] }) },
            },
        } as unknown as PluginInvocationContext;
        const raw = await registeredLinkHandler(TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1)(
            { v: 1, sessionId: 'session-a' }, context);
        const result = TriageReadSourceSessionLinksResultV1Schema.parse(raw);
        expect(result).toMatchObject({ kind: 'partial', links: [{ entryRef: testkitEntryRef(), displayPath: 'Healthy linked work' }],
            lanes: expect.arrayContaining([{ source: unavailable.instance.source,
                sourceInstanceId: unavailable.instance.sourceInstanceId, displayLabel: 'Retained source',
                health: { kind: 'unavailable' },
            }]),
        });
        unavailableRead = true;
        expect(TriageReadSourceSessionLinksResultV1Schema.parse(await registeredLinkHandler(TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1)(
            { v: 1, sessionId: 'session-a' }, context))).toMatchObject({ kind: 'failed', links: [],
            lanes: expect.arrayContaining([expect.objectContaining({ source: configured.instance.source,
                health: { kind: 'failed', failure: { class: 'transient', code: 'accountDataUnavailable' } },
            })]),
        });
    });

    it('uses an admitted source relationship role instead of also creating an external row', async () => {
        const { collections, control } = createTestkitCorpusCollections();
        const configured = testkitConfiguredInstance();
        control.sourceInstances.seed(toCorpusStoredValue({
            instanceTag: `a${'0'.repeat(42)}`, lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1,
            sourceQualifiedId: `${configured.instance.source.pluginId}/${configured.instance.source.localId}`,
            configured,
        }));
        const writes: unknown[] = [];
        let linked = false;
        let writeFails = false;
        await linkEntryToSession({ collections, entryRef: testkitEntryRef(), sessionId: 'session-a',
            display: { locator: testkitLocator(), scopeLabel: 'example/repository' }, nowMs: 1 });
        const sessionActions = createTestkitActionInvoker();
        const context = createContext(collections);
        const sourceContext = {
            ...context,
            surface: 'api',
            services: {
                ...context.services,
                targetedContributions: { observeForSelf: () => ({
                    readCurrent: async () => ({ contributions: [{
                        contributor: { pluginId: configured.instance.source.pluginId, contributionId: configured.instance.source.localId },
                        descriptor: { v: 1, purpose: 'triage-source', displayName: 'Example', kinds: [
                            { id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Pull request' },
                        ] },
                        operations: { linkSession: { role: 'linkSession' }, readSessionLinks: { role: 'readSessionLinks' } },
                    }] }), dispose: () => {},
                }) },
                actions: {
                    execute: async (actionId: Parameters<typeof sessionActions.execute>[0], input: Parameters<typeof sessionActions.execute>[1]) => {
                        if (actionId === 'session.message.send') expect(writes).toHaveLength(1);
                        return await sessionActions.execute(actionId, input);
                    },
                    executeAdmittedTargetedOperation: async (operation: { role: string }, input: { linked: boolean }) => {
                        if (operation.role === 'readSessionLinks') return { kind: 'complete', links: linked ? [{
                            localRef: { kindId: 'pull-request', collisionScope: 'example/repository', entryId: '17' },
                            sessionId: 'session-a', linkedAtMs: 10, displayPath: 'Personal task',
                        }] : [] };
                        if (writeFails) return { status: 'failed' };
                        linked = input.linked;
                        writes.push(input); return { status: linked ? 'linked' : 'unlinked' };
                    },
                },
            },
        } as unknown as PluginInvocationContext;
        const startInput = { v: 1, entryRef: testkitEntryRef(),
            sourceInstanceId: configured.instance.sourceInstanceId,
            display: { locator: testkitLocator(), scopeLabel: 'example/repository' },
            workspaceMode: 'reference_only', destination: { kind: 'existing', sessionId: 'session-a' },
            delivery: { ...TESTKIT_DELIVERY_REQUEST, kind: 'send' },
        } as const;
        const start = registeredLinkHandler(TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1);
        writeFails = true;
        expect(await start(startInput, sourceContext)).toMatchObject({ type: 'linkPending', sessionId: 'session-a' });
        expect(sessionActions.callsFor('session.message.send')).toHaveLength(0);
        expect(await readLinkRows(collections, 'session-a')).toHaveLength(1);
        writeFails = false;
        expect(await start({ ...startInput, resume: { phase: 'linkPending', sessionId: 'session-a', disposition: 'existing' } },
            sourceContext)).toMatchObject({ v: 1, type: 'opened', sessionId: 'session-a', delivery: 'accepted' });
        expect(writes).toEqual([{ v: 1, instance: configured,
            localRef: { kindId: 'pull-request', collisionScope: 'example/repository', entryId: '17' },
            sessionId: 'session-a', linked: true,
        }]);
        expect(await readLinkRows(collections, 'session-a')).toHaveLength(0);
        expect(sessionActions.callsFor('session.message.send')).toHaveLength(1);
        expect(await registeredLinkHandler(TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1)(
            { v: 1, sessionId: 'session-a' }, sourceContext)).toMatchObject({ kind: 'complete', links: [{
                entryRef: testkitEntryRef(), sessionId: 'session-a', linkedAtMs: 10, displayPath: 'Personal task',
            }] });
        expect(await registeredLinkHandler(TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1)({
            v: 1, entryRef: testkitEntryRef(), sourceInstanceId: configured.instance.sourceInstanceId,
        }, sourceContext)).toMatchObject({ kind: 'read', linkedSessions: [{ sessionId: 'session-a' }] });
        expect(await registeredLinkHandler(TRIAGE_UNLINK_ENTRY_FROM_SESSION_ACTION_LOCAL_ID_V1)({
            v: 1, sessionId: 'session-a', entryRef: testkitEntryRef(), sourceInstanceId: configured.instance.sourceInstanceId,
        }, sourceContext)).toEqual({ v: 1, status: 'unlinked' });
        expect(linked).toBe(false);
        expect(await readLinkRows(collections, 'session-a')).toHaveLength(0);
        writeFails = true;
        expect(await registeredLinkHandler()({ v: 1, sessionId: 'session-a', entryRef: testkitEntryRef(),
            sourceInstanceId: configured.instance.sourceInstanceId,
            display: { locator: testkitLocator(), scopeLabel: 'example/repository' },
        }, sourceContext)).toEqual({ v: 1, status: 'failed' });
        expect(await readLinkRows(collections, 'session-a')).toHaveLength(0);
    });

    it('links a host-qualified Session carried to the real PR target through this same writer', async () => {
        const { collections } = createTestkitCorpusCollections();
        const entryRef = testkitEntryRef();
        const admission = triageEntrySessionDropTargetRuntime.resolve({
            item: { kind: 'session', scope: { serverId: 'home-a', accountId: 'account-a' },
                address: { serverId: 'home-a', sessionId: 'session-a' } },
            destination: null, input: 'pointer',
            targetInput: {
                entryRef, display: { locator: testkitLocator(), scopeLabel: 'example/repository' },
                preview: { verb: 'Link Session', target: 'Review the normalizer', consequence: 'Nothing changes at the source.' },
            },
        });
        expect(admission.status).toBe('allowed');
        if (admission.status !== 'allowed') throw new Error('Expected the mounted entry to accept this Session');
        expect(admission.effect.actionId).toBe('plugin:happier.triage/sessions/link-entry-v1');
        // Only persistence is substituted; the drop emits the canonical Action
        // input, and the actual registered handler and relationship writer run.
        expect(await registeredLinkHandler()(admission.effect.input, createContext(collections)))
            .toEqual({ v: 1, status: 'linked' });
        const rows = await readLinkRows(collections, 'session-a');
        expect(rows).toHaveLength(1);
        expect(rows[0]?.entryRef).toEqual(entryRef);
        expect(rows[0]?.displayPathAtLink).toBe('example/repository #17');
    });

    it('refuses absent destination state or a non-Session without producing an effect', () => {
        const request = {
            item: { kind: 'session' as const, scope: { serverId: 'home-a', accountId: 'account-a' },
                address: { serverId: 'home-a', sessionId: 'session-a' } },
            destination: null, input: 'pointer' as const, targetInput: null,
        };
        expect(triageEntrySessionDropTargetRuntime.resolve(request).status).toBe('refused');
        expect(triageEntrySessionDropTargetRuntime.resolve({ ...request,
            item: { kind: 'repository-file', scope: request.item.scope, machineId: 'machine-a', path: '/repo/file.ts' },
        }).status).toBe('refused');
    });

    it('describes the current qualified PR and refuses a selected instance belonging to another source', () => {
        const reference = {
            entryRef: testkitEntryRef(),
            sourceInstance: { source: testkitEntryRef().source, sourceInstanceId: '11111111-1111-4111-8111-111111111111' },
            lastKnownLocator: testkitLocator(), title: 'Review the normalizer', subtitle: 'Example forge · Pull request',
        };
        expect(triageEntryDragSourceRuntime.describe(reference))
            .toEqual({ title: 'Review the normalizer', subtitle: 'Example forge · Pull request' });
        expect(triageEntryDragSourceRuntime.describe({ ...reference,
            sourceInstance: { ...reference.sourceInstance, source: { pluginId: 'happier.other-source', localId: 'items' } },
        })).toBeNull();
    });

    it('writes one durable link row the Session cockpit can read', async () => {
        const { collections } = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
        const handler = registeredLinkHandler();

        const result = await handler({
            v: 1,
            sessionId: 'session-a',
            entryRef: testkitEntryRef(),
            display: { locator: testkitLocator(), scopeLabel: 'example/repository' },
        }, createContext(collections));

        expect(result).toEqual({ v: 1, status: 'linked' });
        const rows = await readLinkRows(collections, 'session-a');
        expect(rows).toHaveLength(1);
        expect(rows[0]?.sessionId).toBe('session-a');
        // The cockpit renders this exact frozen path; nothing durable holds a
        // fresher one to read.
        expect(rows[0]?.displayPathAtLink).toBe('example/repository #17');
    });

    it('keeps one row for one entry and Session when the same link is repeated with a different rendering', async () => {
        // The failure this excludes: a second device materializes the same entry
        // with a fresher display path, presses the same affordance, and the
        // Session ends up showing one relationship twice.
        const { collections } = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
        const handler = registeredLinkHandler();
        const context = createContext(collections);

        await handler({
            v: 1,
            sessionId: 'session-a',
            entryRef: testkitEntryRef(),
            display: { locator: testkitLocator(), scopeLabel: 'example/repository' },
        }, context);
        const second = await handler({
            v: 1,
            sessionId: 'session-a',
            // Structurally equal, independently constructed, differently rendered.
            entryRef: { ...testkitEntryRef() },
            display: {
                locator: testkitLocator({ displayPath: 'example/repository #17 (renamed)' }),
                scopeLabel: 'example/repository',
            },
        }, context);

        expect(second).toEqual({ v: 1, status: 'linked' });
        const rows = await readLinkRows(collections, 'session-a');
        expect(rows).toHaveLength(1);
        expect(rows[0]?.displayPathAtLink).toBe('example/repository #17');
        expect(rows[0]?.linkedAtMs).toBeGreaterThanOrEqual(NOW_BEFORE_MS);
    });

    it('reports a refused storage write as a failed status rather than throwing', async () => {
        const { collections } = createTestkitCorpusCollections();
        const handler = registeredLinkHandler();

        const result = await handler({
            v: 1,
            sessionId: 'session-a',
            entryRef: testkitEntryRef(),
            display: { locator: testkitLocator(), scopeLabel: 'example/repository' },
        }, createContext({
            ...collections,
            sessionLinks: {
                ...collections.sessionLinks,
                batch: async () => {
                    throw new Error('collection_unavailable');
                },
            },
        }));

        expect(result).toEqual({ v: 1, status: 'failed' });
    });

    it('falls back to the entry scope label when the source emitted no display path', async () => {
        const { collections } = createTestkitCorpusCollections();
        const handler = registeredLinkHandler();

        await handler({
            v: 1,
            sessionId: 'session-a',
            entryRef: testkitEntryRef(),
            display: {
                locator: testkitLocator({ displayPath: undefined }),
                scopeLabel: 'example/repository',
            },
        }, createContext(collections));

        const rows = await readLinkRows(collections, 'session-a');
        expect(rows[0]?.displayPathAtLink).toBe('example/repository');
    });
});
