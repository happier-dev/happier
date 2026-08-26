import { describe, expect, it } from 'vitest';

import { deriveSessionLinkTag } from '../corpus/identity/tags.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { testkitEntryRef } from '../corpus/testkit/observations.test-support.js';
import {
    resumeEntrySessionStart,
    startEntrySession,
    type TriageEntrySessionDepsV1,
    type TriageEntrySessionStartRequestV1,
    type TriageWorkspaceMaterializationV1,
} from './entrySessionOrchestrator.js';
import {
    TRIAGE_WORKSPACE_MODE_MATERIALIZATION_V1,
    type TriageWorkspaceModeV1,
} from './entrySessionWorkspace.js';
import {
    createTestkitActionInvoker,
    createTestkitPrepareReviewWorkspace,
    spawnSuccess,
    TESTKIT_DELIVERY_REQUEST,
    TESTKIT_LINK_DISPLAY,
    TESTKIT_OBSERVED_REVISION,
    TESTKIT_SELECTED_WORKSPACE,
    TESTKIT_SPAWN_REQUEST,
    testkitConfiguredInstance,
    type TestkitActionInvoker,
    type TestkitPrepareReviewWorkspace,
} from './testkit/entrySessionTestkit.test-support.js';

const NOW_MS = 1_760_000_900_000;

const PREPARED_RESULT = {
    kind: 'prepared',
    repositoryPath: '/workspaces/example-review',
    branch: 'pr-17',
    created: true,
    pullRequest: { number: 17 },
    currentness: { kind: 'currentAtObservedHead' },
} as const;

const REVIEW_WORKSPACE: TriageWorkspaceMaterializationV1 = {
    kind: 'reviewWorkspace',
    request: {
        instance: testkitConfiguredInstance(),
        entryRef: testkitEntryRef(),
        workflowSubject: 'pullRequest',
        lastKnownLocator: TESTKIT_LINK_DISPLAY.locator,
        observed: TESTKIT_OBSERVED_REVISION,
        workspace: TESTKIT_SELECTED_WORKSPACE,
    },
};

const PREPARED_FACTS = {
    kind: 'preparedReviewWorkspace',
    directory: '/workspaces/example-review',
    branch: 'pr-17',
    created: true,
    pullRequest: { number: 17 },
    currentness: { kind: 'currentAtObservedHead' },
    reviewEligibility: {
        status: 'eligible',
        baseSha: TESTKIT_OBSERVED_REVISION.baseSha,
        headSha: TESTKIT_OBSERVED_REVISION.headSha,
    },
} as const;

function deps(
    fixture: ReturnType<typeof createTestkitCorpusCollections>,
    invoker: TestkitActionInvoker,
    source?: TestkitPrepareReviewWorkspace,
): TriageEntrySessionDepsV1 {
    return {
        collections: fixture.collections,
        execute: invoker.execute,
        nowMs: NOW_MS,
        ...(source ? { prepareReviewWorkspace: source.deps } : {}),
    };
}

/**
 * The pressed action's declared `workspaceMode` is the gate's ONE input
 * (`PLAN.md` §0a A3). It replaced the `ask | fix` intent union, which the gate
 * had to re-read together with the entry's workflow subject to work out what a
 * press meant. The three approved pairings are unchanged and are exercised
 * literally below — a reference-only action never materializes a workspace, a
 * pull-request action demands the source-prepared review workspace, and every
 * repository action runs in the project the reader selected.
 */
describe('startEntrySession', () => {
    it('creates one reference-only Session, links it and opens it without touching SCM', async () => {
        const fixture = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
        const entryRef = testkitEntryRef();
        const invoker = createTestkitActionInvoker({ spawn: [spawnSuccess()] });

        const result = await startEntrySession(deps(fixture, invoker), {
            entryRef,
            display: TESTKIT_LINK_DISPLAY,
            workspaceMode: 'reference_only',
            destination: {
                kind: 'new',
                creationKey: 'creation-key-a',
                spawn: TESTKIT_SPAWN_REQUEST,
                materialization: { kind: 'referenceOnly', directory: '/projects/example' },
            },
        });

        expect(result).toEqual({
            type: 'opened',
            sessionId: 'session-a',
            disposition: 'created',
            workspace: { kind: 'referenceOnly' },
            delivery: 'notRequested',
        });
        // Exactly one creation and one open, in that order, and nothing else.
        expect(invoker.calls.map((call) => call.actionId)).toEqual([
            'session.spawn_new',
            'session.open',
        ]);
        const spawn = invoker.callsFor('session.spawn_new')[0]?.input;
        expect(spawn).toMatchObject({
            directory: '/projects/example',
            creationKey: 'creation-key-a',
        });
        // Nothing was composed here: the caller supplied no prompt body, and
        // this module never synthesizes one from the entry's own words.
        expect(spawn && 'initialMessage' in spawn).toBe(false);
        expect(invoker.callsFor('session.open')[0]?.input).toEqual({ sessionId: 'session-a' });

        const linkTag = await deriveSessionLinkTag(fixture.collections.sessionLinks, entryRef, 'session-a');
        expect((await fixture.collections.sessionLinks.get(linkTag))?.value).toEqual({
            linkTag,
            entryTag: expect.any(String),
            sessionId: 'session-a',
            linkedAtMs: NOW_MS,
            entryRef,
            identityEntryRef: entryRef,
            displayPathAtLink: 'example/repository #17',
        });
    });

    it('never lets a title, a startup prompt or a second checkout reach the creation call', async () => {
        const fixture = createTestkitCorpusCollections();
        const entryRef = testkitEntryRef();
        const invoker = createTestkitActionInvoker({ spawn: [spawnSuccess()] });
        // A caller that carried these members anyway — the shape a UI surface
        // could produce from an unnarrowed value.
        const leakingSpawn = {
            ...TESTKIT_SPAWN_REQUEST,
            title: 'Replace the duplicated normalizer',
            agentSessionStartupInstructionsV1: { instructions: 'review it', v: 1, id: 'i', revision: 1 },
            checkoutCreationDraft: { kind: 'git_worktree', displayName: 'pr-17', baseRef: null },
        } as unknown as typeof TESTKIT_SPAWN_REQUEST;

        await startEntrySession(deps(fixture, invoker), {
            entryRef,
            display: TESTKIT_LINK_DISPLAY,
            workspaceMode: 'reference_only',
            destination: {
                kind: 'new',
                creationKey: 'creation-key-a',
                spawn: leakingSpawn,
                materialization: { kind: 'referenceOnly', directory: '/projects/example' },
            },
        });

        const spawn = invoker.callsFor('session.spawn_new')[0]?.input ?? {};
        for (const member of [
            'title',
            'agentSessionStartupInstructionsV1',
            'checkoutCreationDraft',
        ]) {
            expect(member in spawn).toBe(false);
        }
    });

    /**
     * `PLAN.md` §0a A4 narrowed the blanket prohibition: `initialMessage` is
     * admissible, and its one admitted producer is the body resolved from the
     * pressed action's own Prompt Library invocation. The invariant the blanket
     * prohibition protected is unchanged and now stated positively — **Triage
     * never stringifies provider prose into a prompt** — and it is enforced by
     * this module never composing one, plus the wire's closed spawn shape
     * (`actions/entrySessionProtocol.ts`) refusing a caller-supplied one.
     *
     * So the structural fact this pins is the narrow one: the stripper no
     * longer deletes a resolved prompt body on its way to the creator, which is
     * what would silently drop the instruction a configured action exists to
     * send.
     */
    it('carries a resolved prompt body through to the creation call unchanged', async () => {
        const fixture = createTestkitCorpusCollections();
        const invoker = createTestkitActionInvoker({ spawn: [spawnSuccess()] });
        const withPrompt = {
            ...TESTKIT_SPAWN_REQUEST,
            initialMessage: 'Summarize what changed and propose the smallest fix.',
        } as unknown as typeof TESTKIT_SPAWN_REQUEST;

        await startEntrySession(deps(fixture, invoker), {
            entryRef: testkitEntryRef(),
            display: TESTKIT_LINK_DISPLAY,
            workspaceMode: 'reference_only',
            destination: {
                kind: 'new',
                creationKey: 'creation-key-a',
                spawn: withPrompt,
                materialization: { kind: 'referenceOnly', directory: '/projects/example' },
            },
        });

        expect(invoker.callsFor('session.spawn_new')[0]?.input).toMatchObject({
            initialMessage: 'Summarize what changed and propose the smallest fix.',
        });
    });

    it('links and opens an existing Session for a reference-only action without materializing anything', async () => {
        const fixture = createTestkitCorpusCollections();
        const entryRef = testkitEntryRef();
        const invoker = createTestkitActionInvoker();

        const result = await startEntrySession(deps(fixture, invoker), {
            entryRef,
            display: TESTKIT_LINK_DISPLAY,
            workspaceMode: 'reference_only',
            destination: { kind: 'existing', sessionId: 'session-existing' },
        });

        expect(result).toEqual({
            type: 'opened',
            sessionId: 'session-existing',
            disposition: 'existing',
            workspace: { kind: 'referenceOnly' },
            delivery: 'notRequested',
        });
        expect(invoker.calls.map((call) => call.actionId)).toEqual(['session.open']);
    });

    /**
     * Reusing an EXISTING Session stays a reference-only affair: an action that
     * declares a workspace has a directory to create, and an existing Session
     * already has one. The subject the entry happens to carry never enters this
     * decision, which is why the cases are the modes rather than the subjects.
     */
    it.each(['repository', 'pull_request'] as const)(
        'rejects a %s action into an existing Session before any creation, link or open',
        async (workspaceMode) => {
            const fixture = createTestkitCorpusCollections();
            const entryRef = testkitEntryRef();
            const invoker = createTestkitActionInvoker();

            const result = await startEntrySession(deps(fixture, invoker), {
                entryRef,
                display: TESTKIT_LINK_DISPLAY,
                workspaceMode,
                destination: { kind: 'existing', sessionId: 'session-existing' },
            });

            expect(result).toEqual({
                type: 'rejected',
                reason: 'existingSessionRequiresReferenceOnlyMode',
            });
            expect(invoker.calls).toEqual([]);
            const linkTag = await deriveSessionLinkTag(
                fixture.collections.sessionLinks,
                entryRef,
                'session-existing',
            );
            expect(await fixture.collections.sessionLinks.get(linkTag)).toBeNull();
        },
    );

    it('rejects a reference-only action that carries a workspace materialization', async () => {
        const fixture = createTestkitCorpusCollections();
        const entryRef = testkitEntryRef();
        const invoker = createTestkitActionInvoker();

        const result = await startEntrySession(deps(fixture, invoker), {
            entryRef,
            display: TESTKIT_LINK_DISPLAY,
            workspaceMode: 'reference_only',
            destination: {
                kind: 'new',
                creationKey: 'creation-key-a',
                spawn: TESTKIT_SPAWN_REQUEST,
                materialization: REVIEW_WORKSPACE,
            },
        });

        expect(result).toEqual({ type: 'rejected', reason: 'referenceOnlyModeRequiresReferenceOnlyWorkspace' });
        expect(invoker.calls).toEqual([]);
    });

    it('rejects a pull-request action that has no prepared review workspace', async () => {
        const fixture = createTestkitCorpusCollections();
        const entryRef = testkitEntryRef();
        const invoker = createTestkitActionInvoker();

        const result = await startEntrySession(deps(fixture, invoker), {
            entryRef,
            display: TESTKIT_LINK_DISPLAY,
            workspaceMode: 'pull_request',
            destination: {
                kind: 'new',
                creationKey: 'creation-key-a',
                spawn: TESTKIT_SPAWN_REQUEST,
                materialization: { kind: 'selectedProject', directory: '/projects/example' },
            },
        });

        expect(result).toEqual({
            type: 'rejected',
            reason: 'pullRequestModeRequiresPreparedWorkspace',
        });
        expect(invoker.calls).toEqual([]);
    });

    it('rejects a selected-PR workspace whose nested entry is not the linked entry', async () => {
        const fixture = createTestkitCorpusCollections();
        const invoker = createTestkitActionInvoker();
        const source = createTestkitPrepareReviewWorkspace({ results: [PREPARED_RESULT] });

        const result = await startEntrySession(deps(fixture, invoker, source), {
            entryRef: testkitEntryRef({ entryId: '18' }),
            display: TESTKIT_LINK_DISPLAY,
            workspaceMode: 'pull_request',
            destination: {
                kind: 'new',
                creationKey: 'creation-key-a',
                spawn: TESTKIT_SPAWN_REQUEST,
                materialization: REVIEW_WORKSPACE,
            },
        });

        expect(result).toEqual({
            type: 'rejected',
            reason: 'pullRequestWorkspaceEntryMismatch',
        });
        expect(source.calls).toEqual([]);
        expect(invoker.calls).toEqual([]);
    });

    it('rejects a repository action that tries to use a prepared review workspace', async () => {
        const fixture = createTestkitCorpusCollections();
        const entryRef = testkitEntryRef();
        const invoker = createTestkitActionInvoker();

        const result = await startEntrySession(deps(fixture, invoker), {
            entryRef,
            display: TESTKIT_LINK_DISPLAY,
            workspaceMode: 'repository',
            destination: {
                kind: 'new',
                creationKey: 'creation-key-a',
                spawn: TESTKIT_SPAWN_REQUEST,
                materialization: REVIEW_WORKSPACE,
            },
        });

        expect(result).toEqual({
            type: 'rejected',
            reason: 'repositoryModeRequiresSelectedProject',
        });
        expect(invoker.calls).toEqual([]);
    });

    it('creates a repository action in the project the user selected', async () => {
        const fixture = createTestkitCorpusCollections();
        const entryRef = testkitEntryRef({ kindId: 'error-issue', entryId: 'ERR-9' });
        const invoker = createTestkitActionInvoker({ spawn: [spawnSuccess()] });

        const result = await startEntrySession(deps(fixture, invoker), {
            entryRef,
            display: TESTKIT_LINK_DISPLAY,
            workspaceMode: 'repository',
            destination: {
                kind: 'new',
                creationKey: 'creation-key-a',
                spawn: TESTKIT_SPAWN_REQUEST,
                materialization: { kind: 'selectedProject', directory: '/projects/example' },
            },
        });

        expect(result).toEqual({
            type: 'opened',
            sessionId: 'session-a',
            disposition: 'created',
            workspace: { kind: 'selectedProject', directory: '/projects/example' },
            delivery: 'notRequested',
        });
        expect(invoker.callsFor('session.spawn_new')[0]?.input).toMatchObject({
            directory: '/projects/example',
        });
    });

    it('creates a pull-request action at the prepared path and keeps only the bounded prepared facts', async () => {
        const fixture = createTestkitCorpusCollections();
        const entryRef = testkitEntryRef();
        const invoker = createTestkitActionInvoker({ spawn: [spawnSuccess()] });
        const source = createTestkitPrepareReviewWorkspace({ results: [PREPARED_RESULT] });

        const result = await startEntrySession(deps(fixture, invoker, source), {
            entryRef,
            display: TESTKIT_LINK_DISPLAY,
            workspaceMode: 'pull_request',
            destination: {
                kind: 'new',
                creationKey: 'creation-key-a',
                spawn: TESTKIT_SPAWN_REQUEST,
                materialization: REVIEW_WORKSPACE,
            },
        });

        expect(result).toEqual({
            type: 'opened',
            sessionId: 'session-a',
            disposition: 'created',
            workspace: PREPARED_FACTS,
            delivery: 'notRequested',
        });
        // One preparation, and the directory the Session is created in is the
        // one the source prepared — never a path Triage chose.
        expect(source.calls).toHaveLength(1);
        expect(invoker.callsFor('session.spawn_new')[0]?.input).toMatchObject({
            directory: '/workspaces/example-review',
        });
    });

    it('creates no Session, link or open when preparation refuses the selected workspace', async () => {
        const fixture = createTestkitCorpusCollections();
        const entryRef = testkitEntryRef();
        const invoker = createTestkitActionInvoker();
        const source = createTestkitPrepareReviewWorkspace({ results: [{ kind: 'workspaceMismatch' }] });

        const result = await startEntrySession(deps(fixture, invoker, source), {
            entryRef,
            display: TESTKIT_LINK_DISPLAY,
            workspaceMode: 'pull_request',
            destination: {
                kind: 'new',
                creationKey: 'creation-key-a',
                spawn: TESTKIT_SPAWN_REQUEST,
                materialization: REVIEW_WORKSPACE,
            },
        });

        expect(result).toEqual({
            type: 'workspacePreparationFailed',
            reason: 'refused',
            retryable: false,
        });
        expect(invoker.calls).toEqual([]);
        const linkTag = await deriveSessionLinkTag(fixture.collections.sessionLinks, entryRef, 'session-a');
        expect(await fixture.collections.sessionLinks.get(linkTag)).toBeNull();
    });

    it('reports an unreachable machine as a retryable preparation failure', async () => {
        const fixture = createTestkitCorpusCollections();
        const invoker = createTestkitActionInvoker();
        const source = createTestkitPrepareReviewWorkspace({
            results: [{ kind: 'unavailable', reason: 'machine' }],
        });

        expect(await startEntrySession(deps(fixture, invoker, source), {
            entryRef: testkitEntryRef(),
            display: TESTKIT_LINK_DISPLAY,
            workspaceMode: 'pull_request',
            destination: {
                kind: 'new',
                creationKey: 'creation-key-a',
                spawn: TESTKIT_SPAWN_REQUEST,
                materialization: REVIEW_WORKSPACE,
            },
        })).toEqual({ type: 'workspacePreparationFailed', reason: 'failed', retryable: true });
        expect(invoker.calls).toEqual([]);
    });

    it('opens a Session on a worktree the source left stale and says the review cannot start', async () => {
        const fixture = createTestkitCorpusCollections();
        const invoker = createTestkitActionInvoker({ spawn: [spawnSuccess()] });
        const source = createTestkitPrepareReviewWorkspace({
            results: [{
                ...PREPARED_RESULT,
                currentness: {
                    kind: 'preservedStale',
                    resolvedHeadSha: 'cccccccccccccccccccccccccccccccccccccccc',
                    observedHeadSha: TESTKIT_OBSERVED_REVISION.headSha,
                    reason: 'localCommits',
                },
            }],
        });

        const result = await startEntrySession(deps(fixture, invoker, source), {
            entryRef: testkitEntryRef(),
            display: TESTKIT_LINK_DISPLAY,
            workspaceMode: 'pull_request',
            destination: {
                kind: 'new',
                creationKey: 'creation-key-a',
                spawn: TESTKIT_SPAWN_REQUEST,
                materialization: REVIEW_WORKSPACE,
            },
        });

        // The Session is real and so is the directory; only the review claim is withheld.
        expect(result).toMatchObject({
            type: 'opened',
            workspace: {
                directory: '/workspaces/example-review',
                reviewEligibility: { status: 'ineligible', reason: 'localHeadStale' },
            },
            delivery: 'notRequested',
        });
        expect(invoker.callsFor('session.open')).toHaveLength(1);
    });

    it('refuses a pull-request action when no preparation dependency is wired at all', async () => {
        const fixture = createTestkitCorpusCollections();
        const invoker = createTestkitActionInvoker();

        expect(await startEntrySession(deps(fixture, invoker), {
            entryRef: testkitEntryRef(),
            display: TESTKIT_LINK_DISPLAY,
            workspaceMode: 'pull_request',
            destination: {
                kind: 'new',
                creationKey: 'creation-key-a',
                spawn: TESTKIT_SPAWN_REQUEST,
                materialization: REVIEW_WORKSPACE,
            },
        })).toEqual({ type: 'workspacePreparationFailed', reason: 'refused', retryable: false });
        expect(invoker.calls).toEqual([]);
    });

    it('retries a pending creation with the identical request and only then links and opens', async () => {
        const fixture = createTestkitCorpusCollections();
        const entryRef = testkitEntryRef();
        const invoker = createTestkitActionInvoker({
            spawn: [
                { type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' },
                spawnSuccess({ disposition: 'rejoined' }),
            ],
        });
        const request: TriageEntrySessionStartRequestV1 = {
            entryRef,
            display: TESTKIT_LINK_DISPLAY,
            workspaceMode: 'reference_only',
            destination: {
                kind: 'new',
                creationKey: 'creation-key-a',
                spawn: TESTKIT_SPAWN_REQUEST,
                materialization: { kind: 'referenceOnly', directory: '/projects/example' },
            },
        };

        const pending = await startEntrySession(deps(fixture, invoker), request);
        expect(pending).toEqual({
            type: 'creationPending',
            creationKey: 'creation-key-a',
            outcome: 'unknown',
            workspace: { kind: 'referenceOnly' },
        });
        // A pending creation writes no link and navigates nowhere.
        expect(invoker.calls.map((call) => call.actionId)).toEqual(['session.spawn_new']);

        const settled = await startEntrySession(deps(fixture, invoker), request);
        expect(settled).toMatchObject({ type: 'opened', disposition: 'rejoined' });
        const spawnCalls = invoker.callsFor('session.spawn_new');
        // The retry is the same request under the same key: no new key, no
        // attempt ordinal, no second identity.
        expect(spawnCalls[1]?.input).toEqual(spawnCalls[0]?.input);
    });

    it('treats a creation conflict as terminal without fabricating a Session id', async () => {
        const fixture = createTestkitCorpusCollections();
        const entryRef = testkitEntryRef();
        const invoker = createTestkitActionInvoker({
            spawn: [{ type: 'error', code: 'creation_conflict', retryable: false }],
        });

        const result = await startEntrySession(deps(fixture, invoker), {
            entryRef,
            display: TESTKIT_LINK_DISPLAY,
            workspaceMode: 'reference_only',
            destination: {
                kind: 'new',
                creationKey: 'creation-key-a',
                spawn: TESTKIT_SPAWN_REQUEST,
                materialization: { kind: 'referenceOnly', directory: '/projects/example' },
            },
        });

        expect(result).toEqual({
            type: 'creationFailed',
            creationKey: 'creation-key-a',
            workspace: { kind: 'referenceOnly' },
        });
        expect(invoker.calls.map((call) => call.actionId)).toEqual(['session.spawn_new']);
    });

    /**
     * `PLAN.md` §0a A4a approves `resolve -> spawn/rejoin -> link -> send
     * structured input -> open`, and the order is the whole point rather than a
     * preference. Delivery used to run in the mounted Triage surface AFTER the
     * orchestrator had navigated to the Session, so the host retiring that mount
     * — which opening a Session is exactly the thing that does — skipped the
     * delivery outright and the reader arrived at an empty Session.
     *
     * This case fails if the send moves back after the open, or disappears.
     */
    it('delivers the structured input after the link and BEFORE the open', async () => {
        const fixture = createTestkitCorpusCollections();
        const entryRef = testkitEntryRef();
        const invoker = createTestkitActionInvoker({ spawn: [spawnSuccess()] });

        const result = await startEntrySession(deps(fixture, invoker), {
            entryRef,
            display: TESTKIT_LINK_DISPLAY,
            workspaceMode: 'reference_only',
            destination: {
                kind: 'new',
                creationKey: 'creation-key-a',
                spawn: TESTKIT_SPAWN_REQUEST,
                materialization: { kind: 'referenceOnly', directory: '/projects/example' },
            },
            delivery: TESTKIT_DELIVERY_REQUEST,
        });

        expect(result).toEqual({
            type: 'opened',
            sessionId: 'session-a',
            disposition: 'created',
            workspace: { kind: 'referenceOnly' },
            delivery: 'accepted',
        });
        expect(invoker.calls.map((call) => call.actionId)).toEqual([
            'session.spawn_new',
            'session.message.send',
            'session.open',
        ]);
        // The link committed before the send: a delivery into a Session this
        // entry is not linked to would be context for a relationship nothing
        // records.
        const linkTag = await deriveSessionLinkTag(fixture.collections.sessionLinks, entryRef, 'session-a');
        expect(await fixture.collections.sessionLinks.get(linkTag)).not.toBeNull();

        const send = invoker.callsFor('session.message.send')[0]?.input as Readonly<{
            sessionId: string;
            message: string;
            idempotencyKey: string;
            attachments?: readonly Readonly<{ attachmentLocalId: string }>[];
        }>;
        expect(send.sessionId).toBe('session-a');
        expect(send.message).toBe('Repair the failing parser test.');
        // The press's own delivery identity, never the Session id: a
        // Session-scoped key would make a second, different action's prompt a
        // duplicate of the first and dedupe it away.
        expect(send.idempotencyKey).toBe('delivery-key-a');
        expect(send.idempotencyKey).not.toBe('session-a');
        // The prompt never travels alone. Entry context rides the declared
        // attachment, whose `resolveForDispatch` reads authoritative facts at
        // dispatch rather than any prose this start embedded.
        expect(send.attachments).toHaveLength(1);
        expect(send.attachments?.[0]?.attachmentLocalId).toBe('entry');
        expect(send.message).not.toContain('example/repository');
    });

    it('delivers every selected entry when one bulk unit asks for one Session', async () => {
        const fixture = createTestkitCorpusCollections();
        const entryRef = testkitEntryRef({ entryId: '17' });
        const secondEntryRef = testkitEntryRef({ entryId: '18' });
        const invoker = createTestkitActionInvoker({ spawn: [spawnSuccess()] });

        await startEntrySession(deps(fixture, invoker), {
            entryRef,
            display: TESTKIT_LINK_DISPLAY,
            workspaceMode: 'reference_only',
            destination: {
                kind: 'new',
                creationKey: 'creation-key-all',
                spawn: TESTKIT_SPAWN_REQUEST,
                materialization: { kind: 'referenceOnly', directory: '/projects/example' },
            },
            delivery: {
                ...TESTKIT_DELIVERY_REQUEST,
                attachments: [...TESTKIT_DELIVERY_REQUEST.attachments, {
                    entryRef: secondEntryRef,
                    display: TESTKIT_LINK_DISPLAY,
                    sourceInstanceId: TESTKIT_DELIVERY_REQUEST.attachments[0]!.sourceInstanceId,
                    title: 'Extract the selection reducer',
                }],
            } as never,
        });

        const send = invoker.callsFor('session.message.send')[0]?.input as Readonly<{
            attachments?: readonly Readonly<{
                value?: Readonly<{ value?: Readonly<{ entryRef?: unknown }> }>;
            }>[];
        }>;
        expect(send.attachments).toHaveLength(2);
        expect(send.attachments?.map((attachment) => attachment.value?.value?.entryRef)).toEqual([
            entryRef,
            secondEntryRef,
        ]);
    });

    /**
     * The failure this whole phase exists to stop: the previous surface awaited
     * the send, discarded its value and reported EVERY resolved promise as
     * `sent`. A refusal and a genuinely unknown outcome both reached the reader
     * as success, which is the worst thing a start can say.
     */
    it('reports a refused delivery as refused and an unanswered one as unknown', async () => {
        const refusedFixture = createTestkitCorpusCollections();
        const refused = createTestkitActionInvoker({
            spawn: [spawnSuccess()],
            send: [{ status: 'rejected', code: 'session_input_archived' }],
        });
        const refusedResult = await startEntrySession(deps(refusedFixture, refused), {
            entryRef: testkitEntryRef(),
            display: TESTKIT_LINK_DISPLAY,
            workspaceMode: 'reference_only',
            destination: {
                kind: 'new',
                creationKey: 'creation-key-a',
                spawn: TESTKIT_SPAWN_REQUEST,
                materialization: { kind: 'referenceOnly', directory: '/projects/example' },
            },
            delivery: TESTKIT_DELIVERY_REQUEST,
        });
        // The start itself still succeeded: the Session exists, is linked and
        // opened. Only the delivery was refused, and it says so.
        expect(refusedResult).toMatchObject({ type: 'opened', delivery: 'rejected' });

        const unknownFixture = createTestkitCorpusCollections();
        const unanswered = createTestkitActionInvoker({
            spawn: [spawnSuccess()],
            sendThrows: true,
        });
        const unknownResult = await startEntrySession(deps(unknownFixture, unanswered), {
            entryRef: testkitEntryRef(),
            display: TESTKIT_LINK_DISPLAY,
            workspaceMode: 'reference_only',
            destination: {
                kind: 'new',
                creationKey: 'creation-key-a',
                spawn: TESTKIT_SPAWN_REQUEST,
                materialization: { kind: 'referenceOnly', directory: '/projects/example' },
            },
            delivery: TESTKIT_DELIVERY_REQUEST,
        });
        expect(unknownResult).toMatchObject({ type: 'opened', delivery: 'outcomeUnknown' });
        // A send that never answered still opens the Session it created.
        expect(unanswered.callsFor('session.open')).toHaveLength(1);

        const silentFixture = createTestkitCorpusCollections();
        const silent = createTestkitActionInvoker({ spawn: [spawnSuccess()] });
        const silentResult = await startEntrySession(deps(silentFixture, silent), {
            entryRef: testkitEntryRef(),
            display: TESTKIT_LINK_DISPLAY,
            workspaceMode: 'reference_only',
            destination: {
                kind: 'new',
                creationKey: 'creation-key-a',
                spawn: TESTKIT_SPAWN_REQUEST,
                materialization: { kind: 'referenceOnly', directory: '/projects/example' },
            },
        });
        // A start that carried no delivery says so, rather than borrowing the
        // vocabulary of one that did.
        expect(silentResult).toMatchObject({ type: 'opened', delivery: 'notRequested' });
        expect(silent.callsFor('session.message.send')).toHaveLength(0);
    });

    it('reports a link failure as pending and resumes with only the link and the open', async () => {
        const fixture = createTestkitCorpusCollections();
        const entryRef = testkitEntryRef();
        const invoker = createTestkitActionInvoker({ spawn: [spawnSuccess()] });
        let linkWritesFail = true;
        const sessionLinks = {
            ...fixture.collections.sessionLinks,
            batch: async (...args: Parameters<typeof fixture.collections.sessionLinks.batch>) => {
                if (linkWritesFail) throw new Error('collection_unavailable');
                return await fixture.collections.sessionLinks.batch(...args);
            },
        };
        const failingDeps = {
            ...deps(fixture, invoker),
            collections: { sessionLinks },
        };

        const pending = await startEntrySession(failingDeps, {
            entryRef,
            display: TESTKIT_LINK_DISPLAY,
            workspaceMode: 'reference_only',
            destination: {
                kind: 'new',
                creationKey: 'creation-key-a',
                spawn: TESTKIT_SPAWN_REQUEST,
                materialization: { kind: 'referenceOnly', directory: '/projects/example' },
            },
        });
        expect(pending).toEqual({
            type: 'linkPending',
            sessionId: 'session-a',
            disposition: 'created',
            workspace: { kind: 'referenceOnly' },
        });
        expect(invoker.calls.map((call) => call.actionId)).toEqual(['session.spawn_new']);

        linkWritesFail = false;
        if (pending.type !== 'linkPending') throw new Error('expected a pending link');
        expect(await resumeEntrySessionStart(failingDeps, { entryRef, display: TESTKIT_LINK_DISPLAY, pending })).toEqual({
            type: 'opened',
            sessionId: 'session-a',
            disposition: 'created',
            workspace: { kind: 'referenceOnly' },
            delivery: 'notRequested',
        });
        // The resume respawned nothing: creation stays a single call.
        expect(invoker.callsFor('session.spawn_new')).toHaveLength(1);
        const linkTag = await deriveSessionLinkTag(fixture.collections.sessionLinks, entryRef, 'session-a');
        expect(await fixture.collections.sessionLinks.get(linkTag)).not.toBeNull();
    });

    it('reports an open failure as pending and resumes with only session.open', async () => {
        const fixture = createTestkitCorpusCollections();
        const entryRef = testkitEntryRef();
        const failing = createTestkitActionInvoker({ spawn: [spawnSuccess()], openFails: true });

        const pending = await startEntrySession(deps(fixture, failing), {
            entryRef,
            display: TESTKIT_LINK_DISPLAY,
            workspaceMode: 'reference_only',
            destination: {
                kind: 'new',
                creationKey: 'creation-key-a',
                spawn: TESTKIT_SPAWN_REQUEST,
                materialization: { kind: 'referenceOnly', directory: '/projects/example' },
            },
        });
        expect(pending).toEqual({
            type: 'openPending',
            sessionId: 'session-a',
            disposition: 'created',
            workspace: { kind: 'referenceOnly' },
            delivery: 'notRequested',
        });

        const linkTag = await deriveSessionLinkTag(fixture.collections.sessionLinks, entryRef, 'session-a');
        const linkedRevision = fixture.control.sessionLinks.inspect(linkTag)?.revision;
        const retry = createTestkitActionInvoker();
        if (pending.type !== 'openPending') throw new Error('expected a pending open');
        expect(await resumeEntrySessionStart(deps(fixture, retry), { entryRef, display: TESTKIT_LINK_DISPLAY, pending })).toEqual({
            type: 'opened',
            sessionId: 'session-a',
            disposition: 'created',
            workspace: { kind: 'referenceOnly' },
            delivery: 'notRequested',
        });
        // Only the failed phase repeats: no creation, no second link write.
        expect(retry.calls.map((call) => call.actionId)).toEqual(['session.open']);
        expect(fixture.control.sessionLinks.inspect(linkTag)?.revision).toBe(linkedRevision);
    });
});

/**
 * The gate reads the ONE pairing table, and so does the surface that builds the
 * request (`ui/header/newSessionDestination.ts`).
 *
 * Before `workspaceMode` existed the two ends each restated the three pairings
 * in their own vocabulary with nothing binding the copies — the unbound
 * duplicate the Ask/Fix verifier filed as F1, where a change to one end was
 * invisible to the other until a start was refused in front of a reader. This
 * case exists so a table edit this gate did not follow fails here.
 */
describe('the workspace-mode gate is bound to the pairing table', () => {
    const MATERIALIZATIONS: Readonly<Record<
        TriageWorkspaceMaterializationV1['kind'],
        TriageWorkspaceMaterializationV1
    >> = {
        referenceOnly: { kind: 'referenceOnly', directory: '/projects/example' },
        selectedProject: { kind: 'selectedProject', directory: '/projects/example' },
        reviewWorkspace: REVIEW_WORKSPACE,
    };
    const MODES: readonly TriageWorkspaceModeV1[] = ['reference_only', 'repository', 'pull_request'];

    it.each(MODES)('admits only the materialization %s names, and rejects the other two', async (workspaceMode) => {
        const paired = TRIAGE_WORKSPACE_MODE_MATERIALIZATION_V1[workspaceMode];
        for (const [kind, materialization] of Object.entries(MATERIALIZATIONS)) {
            const fixture = createTestkitCorpusCollections();
            const invoker = createTestkitActionInvoker({ spawn: [spawnSuccess()] });
            // Preparation is wired but refuses, so the pull-request arm settles
            // past the gate without a real SCM boundary and still proves the
            // gate let it through.
            const source = createTestkitPrepareReviewWorkspace({ results: [{ kind: 'workspaceMismatch' }] });
            const result = await startEntrySession(deps(fixture, invoker, source), {
                entryRef: testkitEntryRef(),
                display: TESTKIT_LINK_DISPLAY,
                workspaceMode,
                destination: {
                    kind: 'new',
                    creationKey: 'creation-key-a',
                    spawn: TESTKIT_SPAWN_REQUEST,
                    materialization,
                },
            });
            expect(result.type === 'rejected', `${workspaceMode} + ${kind}`).toBe(kind !== paired);
        }
    });
});
