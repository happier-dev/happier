import type { JsonValue, PluginApi, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk/collections';
import { TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1 } from '@happier-dev/triage-protocol/v1';
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
import {
    TESTKIT_SOURCE_INSTANCE_ID,
    testkitEntryRef,
    testkitLocator,
} from '../corpus/testkit/observations.test-support.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { linkEntryToSession } from '../sessions/entrySessionLinks.js';
import { startTriageEntrySession } from './entrySession.js';
import {
    TESTKIT_LINK_DISPLAY,
    TESTKIT_SPAWN_REQUEST,
    TESTKIT_OBSERVED_REVISION,
    TESTKIT_SELECTED_WORKSPACE,
    createTestkitPrepareReviewWorkspace,
    testkitConfiguredInstance,
    createTestkitActionInvoker,
    spawnSuccess,
    type TestkitActionInvoker,
} from '../sessions/testkit/entrySessionTestkit.test-support.js';
import {
    TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1,
    TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1,
    TRIAGE_UNLINK_ENTRY_FROM_SESSION_ACTION_LOCAL_ID_V1,
    TriageStartEntrySessionInputV1Schema,
    TriageStartPullRequestReviewInputV1Schema,
} from './entrySessionProtocol.js';
import type { TriageAdmittedSourceV1 } from './listEntries.js';

/**
 * The registered entry point of the whole Session-start vertical.
 *
 * `startEntrySession` was complete and unit-tested, and no user could reach a
 * single line of it: a mounted surface holds Actions, not Account storage and
 * not the canonical creator, so without a registered Action the common header's
 * configured action controls could only ever call something in-process. These cases
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

function formalReviewInput() {
    return {
        v: 1 as const,
        sessionId: 'session-a',
        review: {
            instance: testkitConfiguredInstance(),
            entryRef: START_INPUT_BASE.entryRef,
            lastKnownLocator: START_INPUT_BASE.display.locator,
            observed: TESTKIT_OBSERVED_REVISION,
            workspace: TESTKIT_SELECTED_WORKSPACE,
            repositoryPath: '/workspaces/example-review',
            pullRequest: { number: 17 },
        },
        engineIds: ['engine-a', 'engine-b'],
        instructions: 'Review the selected pull request.',
    };
}

function createFormalReviewContext(input: Readonly<{
    verifyResult: unknown;
    events: string[];
}>): PluginInvocationContext {
    const operation = { role: 'verifyReviewWorkspace' };
    const source = START_INPUT_BASE.entryRef.source;
    const admitted = [{
        contributor: {
            pluginId: source.pluginId,
            contributionId: source.localId,
            immutableGenerationId: 'source-generation-1',
        },
        protocol: { id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, version: 1 },
        descriptor: {
            v: 1,
            purpose: 'triage-source',
            displayName: 'Example forge',
            kinds: [{
                id: START_INPUT_BASE.entryRef.kindId,
                workflowSubject: 'pullRequest',
                displayName: 'Pull request',
            }],
        },
        operations: { listInstances: {}, scan: {}, get: {}, verifyReviewWorkspace: operation },
        surfaces: { detail: {} },
    } as unknown as TriageAdmittedSourceV1];

    return {
        signal: new AbortController().signal,
        services: {
            targetedContributions: {
                observeForSelf: () => ({
                    readCurrent: async () => {
                        input.events.push('source.readCurrent');
                        return { generation: 'generation-1', contributions: admitted };
                    },
                    dispose: () => { input.events.push('source.dispose'); },
                }),
            },
            actions: {
                executeAdmittedTargetedOperation: async (
                    selectedOperation: unknown,
                    selectedInput: unknown,
                    options: unknown,
                ) => {
                    input.events.push('source.verifyReviewWorkspace');
                    expect(selectedOperation).toBe(operation);
                    const review = formalReviewInput().review;
                    expect(selectedInput).toEqual({
                        v: 1,
                        instance: review.instance,
                        entryRef: review.entryRef,
                        lastKnownLocator: review.lastKnownLocator,
                        observed: review.observed,
                        workspace: review.workspace,
                        prepared: {
                            repositoryPath: review.repositoryPath,
                            pullRequest: review.pullRequest,
                        },
                    });
                    expect(options).toEqual(expect.objectContaining({
                        expectedSelectedConnectedAccountRef:
                            testkitConfiguredInstance().binding.account,
                    }));
                    return input.verifyResult;
                },
                execute: async (actionId: string, actionInput: unknown) => {
                    input.events.push(actionId);
                    expect(actionId).toBe('review.start');
                    expect(actionInput).toEqual({
                        sessionId: 'session-a',
                        engineIds: ['engine-a', 'engine-b'],
                        instructions: 'Review the selected pull request.',
                        changeType: 'committed',
                        base: {
                            kind: 'commit',
                            baseCommit: TESTKIT_OBSERVED_REVISION.baseSha,
                        },
                        scmPullRequestReviewScope: {
                            kind: 'scm_pull_request_review_scope.v1',
                            account: testkitConfiguredInstance().binding.account,
                            pullRequest: { number: 17 },
                            observed: TESTKIT_OBSERVED_REVISION,
                        },
                    });
                    return { status: 'started' };
                },
            },
        },
    } as unknown as PluginInvocationContext;
}

describe('the Session-start Action a mounted header can actually press', () => {
    /**
     * The reachability contract. The mounted header reaches the daemon through
     * the authenticated mounted-UI provenance, which the canonical dispatcher
     * admits as `ui` authority — an Action without that surface is refused
     * outright before its handler is entered. `plugin` stays absent so direct
     * plugin code cannot start sessions, and `agent` and `mcp` stay absent for
     * the same reachability reason: starting a Session on a person's machine
     * and claiming an entry for it is a decision a person makes.
     */
    it('is declared on the surface the mounted header dispatches from, and on no automated one', () => {
        for (const localId of [
            TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1,
            TRIAGE_UNLINK_ENTRY_FROM_SESSION_ACTION_LOCAL_ID_V1,
        ]) {
            const action = declaredAction(localId);
            expect(action.surfaces, localId).toEqual(['ui']);
            expect(action.execution, localId).toEqual({ target: 'daemon' });
            // It writes durable Account state and reaches the generic Session
            // creator, so it is never `safe`.
            expect(action.dangerLevel, localId).toBe('writesLocal');
        }
    });

    /**
     * `PLAN.md` §0a A4a's whole delivery half, through the registered Action.
     *
     * The structured send happens INSIDE the start, between the link and the
     * open, and its verdict comes back on the result. Before this, delivery ran
     * in the mounted surface after the open — so navigation could retire that
     * mount before the send ever ran — and the surface reported every resolved
     * promise as sent, including a refusal.
     */
    it('sends the configured delivery before the open and reports admission as it answered', async () => {
        const { collections } = createTestkitCorpusCollections();
        const invoker = createTestkitActionInvoker({
            spawn: [spawnSuccess({
                initialInput: { status: 'rejected', code: 'session_input_archived' },
            })],
        });
        const handler = registeredHandler(TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1);

        const result = await handler({
            ...START_INPUT_BASE,
            workspaceMode: 'reference_only',
            destination: NEW_DESTINATION,
            delivery: {
                kind: 'send',
                text: 'Repair the failing parser test.',
                attachments: [{
                    entryRef: START_INPUT_BASE.entryRef,
                    display: START_INPUT_BASE.display,
                    sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID,
                    title: 'Replace the duplicated normalizer',
                }, {
                    entryRef: testkitEntryRef({ entryId: '18' }),
                    display: TESTKIT_LINK_DISPLAY,
                    sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID,
                    title: 'Extract the selection reducer',
                }],
                idempotencyKey: 'delivery-key-a',
            },
        }, createContext(collections, invoker));

        expect(result).toEqual({
            v: 1,
            type: 'opened',
            sessionId: 'session-a',
            disposition: 'created',
            // Reported as itself. A refusal arriving as success is the failure
            // the typed verdict exists to make unsayable.
            delivery: 'rejected',
        });
        expect(invoker.calls.map((call) => call.actionId))
            .toEqual(['session.spawn_new', 'session.open']);
        const spawn = invoker.callsFor('session.spawn_new')[0]?.input as Readonly<{
            initialInput?: Readonly<{
                text?: string;
                attachments?: readonly unknown[];
            }>;
        }>;
        expect(spawn.initialInput?.text).toBe('Repair the failing parser test.');
        const send = spawn.initialInput as Readonly<{
            attachments?: readonly unknown[];
        }>;
        expect(send.attachments).toHaveLength(2);
    });

    it('rejects the retired singular-plus-additional delivery spelling', () => {
        expect(TriageStartEntrySessionInputV1Schema.safeParse({
            ...START_INPUT_BASE,
            workspaceMode: 'reference_only',
            destination: NEW_DESTINATION,
            delivery: {
                kind: 'send',
                sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID,
                title: 'Only the first entry',
                additionalEntries: [],
                idempotencyKey: 'delivery-key-retired',
            },
        }).success).toBe(false);
    });

    it('rejects an unknown admission verdict masquerading as settled retry history', () => {
        expect(TriageStartEntrySessionInputV1Schema.safeParse({
            ...START_INPUT_BASE,
            workspaceMode: 'reference_only',
            destination: NEW_DESTINATION,
            resume: {
                phase: 'openPending',
                sessionId: 'session-a',
                disposition: 'created',
                delivery: 'outcomeUnknown',
            },
        }).success).toBe(false);
    });

    /**
     * The retry custody, at the seam that owns it.
     *
     * `resumeEntrySessionStart` had no production consumer at all, so the
     * header's own notice — "pressing again resumes the same one rather than
     * starting a second" — was untrue: every press minted a new creation key.
     * A resume reaches that incumbent owner and repeats only the phase named.
     */
    it('resumes only the failed phase instead of starting a second Session', async () => {
        const { collections } = createTestkitCorpusCollections();
        const entryRef = testkitEntryRef();
        const linked = await linkEntryToSession({
            collections,
            entryRef,
            display: TESTKIT_LINK_DISPLAY,
            sessionId: 'session-a',
            nowMs: 1_760_000_900_000,
        });
        expect(linked.status).toBe('linked');

        const invoker = createTestkitActionInvoker();
        const handler = registeredHandler(TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1);
        const result = await handler({
            ...START_INPUT_BASE,
            entryRef,
            workspaceMode: 'reference_only',
            destination: NEW_DESTINATION,
            resume: { phase: 'openPending', sessionId: 'session-a', disposition: 'created' },
        }, createContext(collections, invoker));

        expect(result).toEqual({
            v: 1,
            type: 'opened',
            sessionId: 'session-a',
            disposition: 'created',
            delivery: 'notRequested',
        });
        // Nothing respawned, and no second creation key was spent.
        expect(invoker.calls.map((call) => call.actionId)).toEqual(['session.open']);
    });

    it('creates one Session, links it and opens it for a reference-only action on a new destination', async () => {
        const { collections } = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
        const invoker = createTestkitActionInvoker({ spawn: [spawnSuccess()] });
        const handler = registeredHandler(TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1);

        const result = await handler({
            ...START_INPUT_BASE,
            workspaceMode: 'reference_only',
            destination: NEW_DESTINATION,
        }, createContext(collections, invoker));

        expect(result).toEqual({
            v: 1,
            type: 'opened',
            sessionId: 'session-a',
            disposition: 'created',
            // No delivery travelled with this start, and the wire says exactly
            // that rather than borrowing the vocabulary of one that did.
            delivery: 'notRequested',
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
        // Nothing was authored on the reader's behalf: this Action's wire carries
        // no title at all, and the only admitted `initialMessage` producer is a
        // configured action's own resolved prompt invocation (`PLAN.md` §0a A4),
        // which this start did not carry.
        expect(Object.keys(spawn)).not.toContain('initialMessage');
        expect(Object.keys(spawn)).not.toContain('title');

        const rows = await readLinkRows(collections, 'session-a');
        expect(rows).toHaveLength(1);
        expect(rows[0]?.displayPathAtLink).toBe('example/repository #17');
    });

    it('refuses a repository action into an existing Session before it creates, links or opens anything', async () => {
        const { collections } = createTestkitCorpusCollections();
        const handler = registeredHandler(TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1);
        // No invoker at all: any host Action call here throws rather than being
        // asserted away afterwards.
        const context = createContext(collections);

        expect(await handler({
            ...START_INPUT_BASE,
            workspaceMode: 'repository',
            destination: { kind: 'existing', sessionId: 'session-a' },
        }, context)).toEqual({
            v: 1,
            type: 'rejected',
            reason: 'existingSessionRequiresReferenceOnlyMode',
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
            workspaceMode: 'reference_only',
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
            workspaceMode: 'reference_only',
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
            workspaceMode: 'reference_only',
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

describe('the registered formal Review transition', () => {
    it('is a person-invoked daemon Action, never an automated review shortcut', () => {
        const action = declaredAction(TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1);
        expect(action.surfaces).toEqual(['ui']);
        expect(action.execution).toEqual({ target: 'daemon' });
        expect(action.dangerLevel).toBe('writesLocal');
    });

    it('verifies the provider and prepared local HEAD immediately before one review.start', async () => {
        const events: string[] = [];
        const handler = registeredHandler(TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1);

        await expect(handler(formalReviewInput(), createFormalReviewContext({
            verifyResult: { kind: 'verified', pullRequest: { number: 17 } },
            events,
        }))).resolves.toEqual({ v: 1, status: 'started' });

        expect(events).toEqual([
            'source.readCurrent',
            'source.dispose',
            'source.verifyReviewWorkspace',
            'review.start',
        ]);
    });

    it.each([
        ['provider revision moved', { kind: 'refused', reason: 'observedHeadMoved' }, 'revisionMismatch'],
        ['prepared workspace moved', { kind: 'workspaceMismatch' }, 'workspaceMismatch'],
        ['source became unavailable', { kind: 'unavailable', reason: 'account' }, 'sourceUnavailable'],
    ] as const)('starts zero reviews when the %s', async (_label, verifyResult, reason) => {
        const events: string[] = [];
        const handler = registeredHandler(TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1);

        await expect(handler(formalReviewInput(), createFormalReviewContext({
            verifyResult,
            events,
        }))).resolves.toEqual({ v: 1, status: 'refused', reason });

        expect(events).not.toContain('review.start');
    });

    it('rejects duplicate selected engines before a provider read or outward write', async () => {
        const events: string[] = [];
        const handler = registeredHandler(TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1);

        await expect(handler({
            ...formalReviewInput(),
            engineIds: ['engine-a', 'engine-a'],
        }, createFormalReviewContext({
            verifyResult: { kind: 'verified', pullRequest: { number: 17 } },
            events,
        }))).resolves.toEqual({ v: 1, status: 'refused', reason: 'reviewRejected' });

        expect(events).toEqual([]);
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
    it('admits and preserves every selected review engine beyond the former local cap', () => {
        const engineIds = Array.from({ length: 17 }, (_, index) => `review-engine-${index + 1}`);

        const parsed = TriageStartPullRequestReviewInputV1Schema.safeParse({
            v: 1,
            sessionId: 'session-a',
            review: {
                instance: testkitConfiguredInstance(),
                entryRef: START_INPUT_BASE.entryRef,
                lastKnownLocator: START_INPUT_BASE.display.locator,
                observed: TESTKIT_OBSERVED_REVISION,
                workspace: TESTKIT_SELECTED_WORKSPACE,
                repositoryPath: '/workspaces/example-review',
                pullRequest: { number: 17 },
            },
            engineIds,
            instructions: 'Review the selected pull request.',
        });

        expect(parsed.success).toBe(true);
        if (parsed.success) expect(parsed.data.engineIds).toEqual(engineIds);
    });

    it('admits the selected prepare-operation payload only as a transient carrier relay', () => {
        const selection = {
            target: { pluginId: 'happier.triage', immutableGenerationId: 'triage-generation-1' },
            point: {
                pointId: 'sources',
                protocol: { id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, version: 1 },
            },
            contributor: {
                pluginId: START_INPUT_BASE.entryRef.source.pluginId,
                contributionId: START_INPUT_BASE.entryRef.source.localId,
                immutableGenerationId: 'source-generation-1',
            },
        } as const;
        const selectedInput = {
            v: 1,
            instance: {
                instance: {
                    source: START_INPUT_BASE.entryRef.source,
                    sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID,
                },
                binding: {},
            },
            entryRef: START_INPUT_BASE.entryRef,
            lastKnownLocator: START_INPUT_BASE.display.locator,
            observed: TESTKIT_OBSERVED_REVISION,
            workspace: TESTKIT_SELECTED_WORKSPACE,
        } as const;

        const parsed = TriageStartEntrySessionInputV1Schema.safeParse({
            ...START_INPUT_BASE,
            workspaceMode: 'pull_request',
            destination: {
                kind: 'new',
                creationKey: 'creation-key-1',
                spawn: TESTKIT_SPAWN_REQUEST,
                materialization: {
                    kind: 'reviewWorkspace',
                    request: {
                        instance: testkitConfiguredInstance(),
                        entryRef: START_INPUT_BASE.entryRef,
                        workflowSubject: 'pullRequest',
                        lastKnownLocator: START_INPUT_BASE.display.locator,
                        observed: TESTKIT_OBSERVED_REVISION,
                        workspace: TESTKIT_SELECTED_WORKSPACE,
                    },
                },
            },
            prepareReviewWorkspaceSelection: {
                selection,
                input: selectedInput,
                credentialRef: testkitConfiguredInstance().binding.account,
            },
        });
        expect(
            parsed.success,
            parsed.success ? undefined : JSON.stringify(parsed.error, null, 2),
        ).toBe(true);
    });

    it('carries an exact selected-PR workspace request only to the supplied admitted operation', async () => {
        const { collections } = createTestkitCorpusCollections();
        const invoker = createTestkitActionInvoker({ spawn: [spawnSuccess()] });
        const source = createTestkitPrepareReviewWorkspace({
            results: [{
                kind: 'prepared',
                repositoryPath: '/workspaces/example-review',
                branch: 'pr-17',
                created: true,
                pullRequest: { number: 17 },
                currentness: { kind: 'currentAtObservedHead' },
            }],
        });
        const input = TriageStartEntrySessionInputV1Schema.parse({
            ...START_INPUT_BASE,
            workspaceMode: 'pull_request',
            destination: {
                kind: 'new',
                creationKey: 'creation-key-1',
                spawn: TESTKIT_SPAWN_REQUEST,
                materialization: {
                    kind: 'reviewWorkspace',
                    request: {
                        instance: testkitConfiguredInstance(),
                        entryRef: START_INPUT_BASE.entryRef,
                        workflowSubject: 'pullRequest',
                        lastKnownLocator: START_INPUT_BASE.display.locator,
                        observed: TESTKIT_OBSERVED_REVISION,
                        workspace: TESTKIT_SELECTED_WORKSPACE,
                    },
                },
            },
        });

        const result = await startTriageEntrySession(input, {
            collections: { sessionLinks: collections.sessionLinks },
            execute: invoker.execute,
            nowMs: () => 1_760_000_900_000,
            prepareReviewWorkspace: source.deps,
        } as Parameters<typeof startTriageEntrySession>[1]);

        expect(result).toMatchObject({
            v: 1,
            type: 'opened',
            sessionId: 'session-a',
            disposition: 'created',
            // A Session that did open from a prepared selected-PR workspace
            // exposes only the bounded continuation needed to select engines.
            // It never exposes source tips or a second SCM route.
            review: {
                instance: testkitConfiguredInstance(),
                entryRef: START_INPUT_BASE.entryRef,
                lastKnownLocator: START_INPUT_BASE.display.locator,
                observed: TESTKIT_OBSERVED_REVISION,
                workspace: TESTKIT_SELECTED_WORKSPACE,
                repositoryPath: '/workspaces/example-review',
                pullRequest: { number: 17 },
            },
        });
        expect(source.calls).toHaveLength(1);
        expect(source.calls[0]?.input).toMatchObject({
            entryRef: START_INPUT_BASE.entryRef,
            lastKnownLocator: START_INPUT_BASE.display.locator,
            observed: TESTKIT_OBSERVED_REVISION,
            workspace: TESTKIT_SELECTED_WORKSPACE,
        });
        expect(invoker.callsFor('session.spawn_new')[0]?.input).toMatchObject({
            directory: '/workspaces/example-review',
        });
    });

    it('cannot carry a caller\'s own prose into the Session it creates', () => {
        // Structural, not a stripping step: the spawn members a caller may
        // choose are closed, so a caller cannot smuggle prose of its own into
        // the creation. `PLAN.md` §0a A4 admits a prompt body only as the
        // resolution of a configured action's own Prompt Library invocation —
        // a producer this wire does not yet have — and never as a free-form
        // member an arbitrary caller may set.
        expect(TriageStartEntrySessionInputV1Schema.safeParse({
            ...START_INPUT_BASE,
            workspaceMode: 'reference_only',
            destination: {
                ...NEW_DESTINATION,
                spawn: { ...TESTKIT_SPAWN_REQUEST, initialMessage: 'review this' },
            },
        }).success).toBe(false);
    });
});
