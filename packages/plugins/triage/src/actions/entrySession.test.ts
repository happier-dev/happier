import type { JsonValue, PluginApi, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk/collections';
import { describe, expect, it } from 'vitest';

import { activate } from '../activate.js';
import type { CorpusCollectionsV1 } from '../corpus/collections/bindCorpusCollections.js';
import {
    CORPUS_SESSION_LINKS_COLLECTION_ID,
    CORPUS_SESSION_LINKS_INDEX_ID,
    CORPUS_SOURCE_INSTANCES_COLLECTION_ID,
} from '../corpus/collections/ids.js';
import { fromCorpusStoredRow } from '../corpus/collections/rowCodec.js';
import type { CorpusSessionLinkRowV1 } from '../corpus/collections/rows.js';
import { deriveSessionLinkTag } from '../corpus/identity/tags.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { testkitEntryRef, testkitLocator } from '../corpus/testkit/observations.test-support.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { linkEntryToSession } from '../sessions/entrySessionLinks.js';
import {
    TESTKIT_LINK_DISPLAY,
    TESTKIT_SPAWN_REQUEST,
    createTestkitActionInvoker,
    spawnSuccess,
    type TestkitActionInvoker,
} from '../sessions/testkit/entrySessionTestkit.test-support.js';
import {
    TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1,
    TRIAGE_UNLINK_ENTRY_FROM_SESSION_ACTION_LOCAL_ID_V1,
    TriageStartEntrySessionInputV1Schema,
} from './entrySessionProtocol.js';

/**
 * The registered entry point of the whole Session-start vertical.
 *
 * `startEntrySession` was complete and unit-tested, and no user could reach a
 * single line of it: a mounted surface holds Actions, not Account storage and
 * not the canonical creator, so without a registered Action the common header's
 * Ask and Fix controls could only ever call something in-process. These cases
 * exercise the seam through `activate` and the declared manifest, because a
 * handler nothing registers — or one declared on a surface the mounted caller is
 * not — is exactly the defect this proves is gone.
 */

const START_INPUT_BASE = Object.freeze({
    v: 1 as const,
    entryRef: testkitEntryRef(),
    display: { locator: testkitLocator(), scopeLabel: 'example/repository' },
});

const NEW_DESTINATION = Object.freeze({
    kind: 'new' as const,
    creationKey: 'creation-key-1',
    spawn: TESTKIT_SPAWN_REQUEST,
    materialization: { kind: 'referenceOnly' as const, directory: '/workspaces/example' },
});

function registeredHandler(localId: string): ActionHandler<JsonValue, JsonValue> {
    const handlers = new Map<string, ActionHandler<JsonValue, JsonValue>>();
    const api = {
        actions: {
            register: (id: string, handler: ActionHandler<JsonValue, JsonValue>) => {
                handlers.set(id, handler);
            },
        },
        composerAttachments: { register: () => {} },
    } as unknown as PluginApi;

    activate(api);
    const handler = handlers.get(localId);
    if (handler === undefined) {
        throw new Error(`activation registers no handler for "${localId}"`);
    }
    return handler;
}

function createContext(
    collections: CorpusCollectionsV1,
    invoker?: TestkitActionInvoker,
): PluginInvocationContext {
    return {
        signal: new AbortController().signal,
        services: {
            actions: {
                execute: async (actionId: unknown, input: unknown) => {
                    if (invoker === undefined) {
                        throw new Error(`no host Action was expected, and "${String(actionId)}" was invoked`);
                    }
                    return await (invoker.execute as (
                        id: unknown,
                        value: unknown,
                    ) => Promise<unknown>)(actionId, input);
                },
            },
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

function declaredAction(localId: string) {
    const action = PLUGIN_MANIFEST.contributes.actions.find((candidate) => candidate.id === localId);
    if (action === undefined) throw new Error(`the manifest declares no Action "${localId}"`);
    return action;
}

describe('the Session-start Action a mounted header can actually press', () => {
    /**
     * The reachability contract. A mounted plugin surface dispatches as a
     * `plugin` caller, so an Action without that surface is refused outright
     * before its handler is entered — the whole vertical would stay dead behind
     * a registered handler. `agent` and `mcp` stay absent for the opposite
     * reason: starting a Session on a person's machine and claiming an entry for
     * it is a decision a person makes.
     */
    it('is declared on the surface the mounted header dispatches from, and on no automated one', () => {
        for (const localId of [
            TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1,
            TRIAGE_UNLINK_ENTRY_FROM_SESSION_ACTION_LOCAL_ID_V1,
        ]) {
            const action = declaredAction(localId);
            expect(action.surfaces, localId).toEqual(['plugin']);
            expect(action.execution, localId).toEqual({ target: 'daemon' });
            // It writes durable Account state and reaches the generic Session
            // creator, so it is never `safe`.
            expect(action.dangerLevel, localId).toBe('writesLocal');
        }
    });

    it('creates one Session, links it and opens it for an Ask on a new destination', async () => {
        const { collections } = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
        const invoker = createTestkitActionInvoker({ spawn: [spawnSuccess()] });
        const handler = registeredHandler(TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1);

        const result = await handler({
            ...START_INPUT_BASE,
            intent: 'ask',
            workflowSubject: 'pullRequest',
            destination: NEW_DESTINATION,
        }, createContext(collections, invoker));

        expect(result).toEqual({
            v: 1,
            type: 'opened',
            sessionId: 'session-a',
            disposition: 'created',
        });
        // Exactly one create and one open, in that order, and no second create.
        expect(invoker.calls.map((call) => call.actionId))
            .toEqual(['session.spawn_new', 'session.open']);
        expect(invoker.callsFor('session.open')[0]?.input).toEqual({ sessionId: 'session-a' });

        const spawn = invoker.callsFor('session.spawn_new')[0]?.input as Record<string, unknown>;
        // The directory is the one the caller settled on, and the creation key is
        // the caller's own — this Action mints neither.
        expect(spawn.directory).toBe('/workspaces/example');
        expect(spawn.creationKey).toBe('creation-key-1');
        // A Triage start carries no prose: a rejoined Session keeps whatever the
        // user had typed, and nothing is sent on their behalf.
        expect(Object.keys(spawn)).not.toContain('initialMessage');
        expect(Object.keys(spawn)).not.toContain('title');

        const rows = await readLinkRows(collections, 'session-a');
        expect(rows).toHaveLength(1);
        expect(rows[0]?.displayPathAtLink).toBe('example/repository #17');
    });

    it('refuses a Fix into an existing Session before it creates, links or opens anything', async () => {
        const { collections } = createTestkitCorpusCollections();
        const handler = registeredHandler(TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1);
        // No invoker at all: any host Action call here throws rather than being
        // asserted away afterwards.
        const context = createContext(collections);

        expect(await handler({
            ...START_INPUT_BASE,
            intent: 'fix',
            workflowSubject: 'issue',
            destination: { kind: 'existing', sessionId: 'session-a' },
        }, context)).toEqual({
            v: 1,
            type: 'rejected',
            reason: 'existingSessionNotOfferedForFix',
        });
        expect(await readLinkRows(collections, 'session-a')).toEqual([]);
    });

    it('returns the canonical pending outcome without linking or opening anything', async () => {
        const { collections } = createTestkitCorpusCollections();
        const invoker = createTestkitActionInvoker({
            spawn: [{ type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' }],
        });
        const handler = registeredHandler(TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1);

        expect(await handler({
            ...START_INPUT_BASE,
            intent: 'ask',
            workflowSubject: 'issue',
            destination: NEW_DESTINATION,
        }, createContext(collections, invoker))).toEqual({
            v: 1,
            type: 'creationPending',
            outcome: 'accepted',
        });
        // No Session id was disclosed, so none is fabricated, linked or opened.
        expect(invoker.callsFor('session.open')).toEqual([]);
        expect(await readLinkRows(collections, 'session-a')).toEqual([]);
    });

    it('keeps the Session and reports the phase that failed when the link does not commit', async () => {
        const { collections } = createTestkitCorpusCollections();
        const invoker = createTestkitActionInvoker({ spawn: [spawnSuccess()] });
        const handler = registeredHandler(TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1);

        const result = await handler({
            ...START_INPUT_BASE,
            intent: 'ask',
            workflowSubject: 'issue',
            destination: NEW_DESTINATION,
        }, createContext({
            ...collections,
            sessionLinks: {
                ...collections.sessionLinks,
                batch: async () => {
                    throw new Error('collection_unavailable');
                },
            },
        }, invoker));

        // The stable id survives the failure, so the retry is a link — never a
        // second Session for one press.
        expect(result).toEqual({
            v: 1,
            type: 'linkPending',
            sessionId: 'session-a',
            disposition: 'created',
        });
        expect(invoker.callsFor('session.open')).toEqual([]);
    });

    it('never removes a link while starting a Session', async () => {
        // Destructive-by-default guard for the untouched case: the unlink writer
        // now ships beside the start, and a start that reached it would silently
        // drop a relationship the user established from another device.
        const { collections } = createTestkitCorpusCollections();
        const entryRef = testkitEntryRef();
        await linkEntryToSession({
            collections,
            entryRef,
            display: TESTKIT_LINK_DISPLAY,
            sessionId: 'session-b',
            nowMs: 1_760_000_900_000,
        });
        const deletions: string[] = [];
        const invoker = createTestkitActionInvoker({ spawn: [spawnSuccess()] });
        const handler = registeredHandler(TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1);

        await handler({
            ...START_INPUT_BASE,
            entryRef,
            intent: 'ask',
            workflowSubject: 'issue',
            destination: NEW_DESTINATION,
        }, createContext({
            ...collections,
            sessionLinks: {
                ...collections.sessionLinks,
                delete: async (rowId: string, options?: unknown) => {
                    deletions.push(rowId);
                    return await collections.sessionLinks.delete(rowId, options as never);
                },
            },
        }, invoker));

        expect(deletions).toEqual([]);
        expect(await readLinkRows(collections, 'session-b')).toHaveLength(1);
    });
});

describe('the explicit unlink Action', () => {
    it('ends exactly the one relationship the user named', async () => {
        const { collections, control } = createTestkitCorpusCollections({
            accountEncryptionMode: 'e2ee',
        });
        const entryRef = testkitEntryRef();
        for (const sessionId of ['session-a', 'session-b']) {
            await linkEntryToSession({
                collections,
                entryRef,
                display: TESTKIT_LINK_DISPLAY,
                sessionId,
                nowMs: 1_760_000_900_000,
            });
        }
        const linkToB = await deriveSessionLinkTag(collections.sessionLinks, entryRef, 'session-b');
        const handler = registeredHandler(TRIAGE_UNLINK_ENTRY_FROM_SESSION_ACTION_LOCAL_ID_V1);

        expect(await handler({
            v: 1,
            sessionId: 'session-b',
            entryRef,
        }, createContext(collections))).toEqual({ v: 1, status: 'unlinked' });

        expect(control.sessionLinks.inspect(linkToB)?.deleted).toBe(true);
        // The same entry's other relationship is untouched: the link address is
        // derived from the entry AND the Session, never from either alone.
        expect(await readLinkRows(collections, 'session-a')).toHaveLength(1);
    });

    it('answers an already absent link with the same idempotent success', async () => {
        const { collections } = createTestkitCorpusCollections();
        const handler = registeredHandler(TRIAGE_UNLINK_ENTRY_FROM_SESSION_ACTION_LOCAL_ID_V1);

        expect(await handler({
            v: 1,
            sessionId: 'session-a',
            entryRef: testkitEntryRef(),
        }, createContext(collections))).toEqual({ v: 1, status: 'unlinked' });
    });
});

describe('the Session-start wire', () => {
    /**
     * The pull-request Fix materialization is deliberately unreachable from this
     * Action: preparing one needs the selected source's admitted
     * `prepareReviewWorkspace` operation, and no shipped source binds it. A wire
     * that accepted the request would put a control in the product that always
     * resolves the workspace refusal.
     */
    it('cannot carry a review-workspace request while nothing can prepare one', () => {
        expect(TriageStartEntrySessionInputV1Schema.safeParse({
            ...START_INPUT_BASE,
            intent: 'fix',
            workflowSubject: 'pullRequest',
            destination: {
                kind: 'new',
                creationKey: 'creation-key-1',
                spawn: TESTKIT_SPAWN_REQUEST,
                materialization: { kind: 'reviewWorkspace' },
            },
        }).success).toBe(false);
    });

    it('cannot carry prose into the Session it creates', () => {
        // The no-auto-send rule is structural here, not a stripping step: the
        // spawn members a caller may choose are closed, so an initial message
        // cannot even be transmitted.
        expect(TriageStartEntrySessionInputV1Schema.safeParse({
            ...START_INPUT_BASE,
            intent: 'ask',
            workflowSubject: 'issue',
            destination: {
                ...NEW_DESTINATION,
                spawn: { ...TESTKIT_SPAWN_REQUEST, initialMessage: 'review this' },
            },
        }).success).toBe(false);
    });
});
