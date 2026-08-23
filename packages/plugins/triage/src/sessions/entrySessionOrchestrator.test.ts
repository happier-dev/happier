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
    currentness: { kind: 'currentAtObservedHead' },
} as const;

const REVIEW_WORKSPACE: TriageWorkspaceMaterializationV1 = {
    kind: 'reviewWorkspace',
    request: {
        instance: testkitConfiguredInstance(),
        entryRef: testkitEntryRef(),
        workflowSubject: 'pullRequest',
        observed: TESTKIT_OBSERVED_REVISION,
        workspace: TESTKIT_SELECTED_WORKSPACE,
    },
};

const PREPARED_FACTS = {
    kind: 'preparedReviewWorkspace',
    directory: '/workspaces/example-review',
    branch: 'pr-17',
    created: true,
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
        mintCardPublicationId: () => 'publication-id-a',
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
            cardPublicationId: 'publication-id-a',
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
        });
        expect(invoker.calls.map((call) => call.actionId)).toEqual(['session.open']);
    });

    it.each(['pullRequest', 'issue', 'errorIssue', 'other'] as const)(
        'rejects a Fix into an existing Session for %s before any creation, link or open',
        async (workflowSubject) => {
            const fixture = createTestkitCorpusCollections();
            const entryRef = testkitEntryRef();
            const invoker = createTestkitActionInvoker();

            const result = await startEntrySession(deps(fixture, invoker), {
                entryRef,
                display: TESTKIT_LINK_DISPLAY,
                workflowSubject,
                intent: 'fix',
                destination: { kind: 'existing', sessionId: 'session-existing' },
            });

            expect(result).toEqual({ type: 'rejected', reason: 'existingSessionNotOfferedForFix' });
            expect(invoker.calls).toEqual([]);
            const linkTag = await deriveSessionLinkTag(
                fixture.collections.sessionLinks,
                entryRef,
                'session-existing',
            );
            expect(await fixture.collections.sessionLinks.get(linkTag)).toBeNull();
        },
    );

    it('rejects an Ask that carries a workspace materialization', async () => {
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

        expect(result).toEqual({ type: 'rejected', reason: 'askUsesReferenceOnly' });
        expect(invoker.calls).toEqual([]);
    });

    it('rejects a pull-request Fix that has no prepared review workspace', async () => {
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
            reason: 'pullRequestFixRequiresPreparedWorkspace',
        });
        expect(invoker.calls).toEqual([]);
    });

    it('rejects an error-issue Fix that tries to use a prepared review workspace', async () => {
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
            reason: 'nonPullRequestFixRequiresSelectedProject',
        });
        expect(invoker.calls).toEqual([]);
    });

    it('creates an error Fix in the project the user selected', async () => {
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
        });
        expect(invoker.callsFor('session.spawn_new')[0]?.input).toMatchObject({
            directory: '/projects/example',
        });
    });

    it('creates a pull-request Fix at the prepared path and keeps only the bounded prepared facts', async () => {
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
        });
        expect(invoker.callsFor('session.open')).toHaveLength(1);
    });

    it('refuses a pull-request Fix when no preparation dependency is wired at all', async () => {
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
        });
        // Only the failed phase repeats: no creation, no second link write.
        expect(retry.calls.map((call) => call.actionId)).toEqual(['session.open']);
        expect(fixture.control.sessionLinks.inspect(linkTag)?.revision).toBe(linkedRevision);
    });
});
