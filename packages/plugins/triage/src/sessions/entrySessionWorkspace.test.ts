import {
    TriageConfiguredSourceInstanceV1Schema,
    TriagePrepareReviewWorkspaceInputV1Schema,
    TriageReviewWorkspaceObservedRevisionV1Schema,
    TriageSelectedWorkspaceScopeV1Schema,
    type TriagePrepareReviewWorkspaceResultV1,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import { TRIAGE_TESTKIT_SOURCE, testkitEntryRef } from '../corpus/testkit/observations.test-support.js';
import {
    resolveEntrySessionWorkspace,
    type TriageReviewWorkspacePreparationRequestV1,
} from './entrySessionWorkspace.js';
import {
    TESTKIT_OBSERVED_REVISION,
    TESTKIT_SELECTED_WORKSPACE,
    TESTKIT_LINK_DISPLAY,
    createTestkitPrepareReviewWorkspace,
    testkitConfiguredInstance,
} from './testkit/entrySessionTestkit.test-support.js';

/**
 * The pull-request workspace binding.
 *
 * Two product rules decide every assertion here. Materialization must land in
 * the one exact saved workspace the user selected — never an auto-clone, a
 * discovered clone or a guessed path — so the operation is invoked with that
 * scope verbatim and no non-`prepared` arm ever yields a directory. And a
 * Session opened from a pull request must carry truthful partial outcomes, so a
 * worktree the source deliberately left at a stale head still opens a Session
 * while saying, in the projected facts, that it cannot start a review.
 */

const REQUEST: TriageReviewWorkspacePreparationRequestV1 = Object.freeze({
    instance: testkitConfiguredInstance(),
    entryRef: testkitEntryRef(),
    workflowSubject: 'pullRequest',
    lastKnownLocator: TESTKIT_LINK_DISPLAY.locator,
    observed: TESTKIT_OBSERVED_REVISION,
    workspace: TESTKIT_SELECTED_WORKSPACE,
});

const PREPARED_CURRENT: TriagePrepareReviewWorkspaceResultV1 = {
    kind: 'prepared',
    repositoryPath: '/workspaces/example-review',
    branch: 'pr-17',
    created: true,
    // The source owns this opaque canonical reference. Triage retains it only
    // long enough for the generic SCM/Reviews scope producer to validate it
    // after the stable Session exists.
    pullRequest: { number: 17 },
    currentness: { kind: 'currentAtObservedHead' },
};

describe('resolveEntrySessionWorkspace', () => {
    it('invokes the admitted operation once with the exact selected workspace and observed revision', async () => {
        const source = createTestkitPrepareReviewWorkspace({ results: [PREPARED_CURRENT] });

        const resolved = await resolveEntrySessionWorkspace(source.deps, REQUEST);

        expect(resolved.status).toBe('prepared');
        expect(source.calls).toHaveLength(1);
        // Parsed through the published schema: a fixture the wire would reject
        // cannot pass, and a normalized, widened or invented path cannot hide.
        expect(TriagePrepareReviewWorkspaceInputV1Schema.parse(source.calls[0]?.input)).toEqual({
            v: 1,
            instance: REQUEST.instance,
            entryRef: REQUEST.entryRef,
            lastKnownLocator: TESTKIT_LINK_DISPLAY.locator,
            observed: TESTKIT_OBSERVED_REVISION,
            workspace: TESTKIT_SELECTED_WORKSPACE,
        });
        // The exact configured account this instance is bound to is the
        // credential correspondence, so a moved binding fails at the host.
        expect(source.calls[0]?.options.expectedSelectedConnectedAccountRef)
            .toEqual(REQUEST.instance.binding.account);
    });

    it('refuses a non-pull-request subject before any provider or worktree call', async () => {
        const source = createTestkitPrepareReviewWorkspace({ results: [PREPARED_CURRENT] });

        expect(await resolveEntrySessionWorkspace(source.deps, {
            ...REQUEST,
            workflowSubject: 'errorIssue',
        })).toEqual({ status: 'failed', failure: { reason: 'refused', retryable: false } });
        expect(source.calls).toHaveLength(0);
    });

    it('refuses an entry that does not belong to the configured instance source', async () => {
        const source = createTestkitPrepareReviewWorkspace({ results: [PREPARED_CURRENT] });

        expect(await resolveEntrySessionWorkspace(source.deps, {
            ...REQUEST,
            entryRef: testkitEntryRef({
                source: { pluginId: 'happier.other.source', localId: 'other-forge' },
            }),
        })).toEqual({ status: 'failed', failure: { reason: 'refused', retryable: false } });
        expect(source.calls).toHaveLength(0);
    });

    it('resolves the strict unsupported refusal when the source declares no preparation, with no fallback', async () => {
        const source = createTestkitPrepareReviewWorkspace({ results: [], operation: 'absent' });

        expect(await resolveEntrySessionWorkspace(source.deps, REQUEST))
            .toEqual({ status: 'failed', failure: { reason: 'refused', retryable: false } });
        expect(source.calls).toHaveLength(0);
    });

    it('keeps only the bounded prepared facts and marks a current worktree review-eligible', async () => {
        const source = createTestkitPrepareReviewWorkspace({ results: [PREPARED_CURRENT] });

        expect(await resolveEntrySessionWorkspace(source.deps, REQUEST)).toEqual({
            status: 'prepared',
            facts: {
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
            },
        });
    });

    it('stays review-eligible at the observed head when the source moved the worktree onto it', async () => {
        const source = createTestkitPrepareReviewWorkspace({
            results: [{
                ...PREPARED_CURRENT,
                created: false,
                currentness: {
                    kind: 'movedToObservedHead',
                    fromSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    observedHeadSha: TESTKIT_OBSERVED_REVISION.headSha,
                    recoveryRef: 'refs/happier/recovered/pr-17',
                },
            }],
        });

        const resolved = await resolveEntrySessionWorkspace(source.deps, REQUEST);

        expect(resolved).toMatchObject({
            status: 'prepared',
            facts: {
                created: false,
                reviewEligibility: {
                    status: 'eligible',
                    baseSha: TESTKIT_OBSERVED_REVISION.baseSha,
                    headSha: TESTKIT_OBSERVED_REVISION.headSha,
                },
            },
        });
    });

    it('opens the Session but refuses review start when the worktree was preserved at a stale head', async () => {
        const source = createTestkitPrepareReviewWorkspace({
            results: [{
                ...PREPARED_CURRENT,
                currentness: {
                    kind: 'preservedStale',
                    resolvedHeadSha: 'cccccccccccccccccccccccccccccccccccccccc',
                    observedHeadSha: TESTKIT_OBSERVED_REVISION.headSha,
                    reason: 'dirtyWorktree',
                },
            }],
        });

        const resolved = await resolveEntrySessionWorkspace(source.deps, REQUEST);

        expect(resolved).toMatchObject({
            status: 'prepared',
            facts: {
                directory: '/workspaces/example-review',
                reviewEligibility: {
                    status: 'ineligible',
                    reason: 'localHeadStale',
                    staleReason: 'dirtyWorktree',
                    resolvedHeadSha: 'cccccccccccccccccccccccccccccccccccccccc',
                    observedHeadSha: TESTKIT_OBSERVED_REVISION.headSha,
                },
            },
        });
    });

    it('never adopts a head the request did not observe', async () => {
        const source = createTestkitPrepareReviewWorkspace({
            results: [{
                ...PREPARED_CURRENT,
                currentness: {
                    kind: 'movedToObservedHead',
                    fromSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    observedHeadSha: 'dddddddddddddddddddddddddddddddddddddddd',
                    recoveryRef: 'refs/happier/recovered/pr-17',
                },
            }],
        });

        const resolved = await resolveEntrySessionWorkspace(source.deps, REQUEST);

        expect(resolved).toMatchObject({
            status: 'prepared',
            facts: {
                reviewEligibility: {
                    status: 'ineligible',
                    reason: 'observedHeadMismatch',
                    resolvedHeadSha: 'dddddddddddddddddddddddddddddddddddddddd',
                    observedHeadSha: TESTKIT_OBSERVED_REVISION.headSha,
                },
            },
        });
    });

    it('maps every non-prepared arm to a typed failure that yields no directory', async () => {
        const arms: readonly (readonly [
            TriagePrepareReviewWorkspaceResultV1,
            Readonly<{ reason: 'refused' | 'failed'; retryable: boolean }>,
        ])[] = [
            [{ kind: 'workspaceRequired' }, { reason: 'refused', retryable: false }],
            [{ kind: 'workspaceMismatch' }, { reason: 'refused', retryable: false }],
            [{ kind: 'unsupported' }, { reason: 'refused', retryable: false }],
            [{ kind: 'unavailable', reason: 'account' }, { reason: 'failed', retryable: true }],
            [{ kind: 'unavailable', reason: 'machine' }, { reason: 'failed', retryable: true }],
            [{ kind: 'unavailable', reason: 'scmResolver' }, { reason: 'failed', retryable: true }],
            // A moved instance, pull request or head means the request carries a
            // stale observation. Repeating it unchanged must never succeed: the
            // user re-observes and starts again.
            [{ kind: 'refused', reason: 'instanceMoved' }, { reason: 'refused', retryable: false }],
            [{ kind: 'refused', reason: 'pullRequestMoved' }, { reason: 'refused', retryable: false }],
            [{ kind: 'refused', reason: 'observedHeadMoved' }, { reason: 'refused', retryable: false }],
        ];

        for (const [result, failure] of arms) {
            const source = createTestkitPrepareReviewWorkspace({ results: [result] });
            expect(await resolveEntrySessionWorkspace(source.deps, REQUEST))
                .toEqual({ status: 'failed', failure });
        }
    });

    it('passes a null selection through rather than guessing a workspace for the user', async () => {
        const source = createTestkitPrepareReviewWorkspace({ results: [{ kind: 'workspaceRequired' }] });

        expect(await resolveEntrySessionWorkspace(source.deps, { ...REQUEST, workspace: null }))
            .toEqual({ status: 'failed', failure: { reason: 'refused', retryable: false } });
        expect(source.calls[0]?.input.workspace).toBeNull();
    });

    it('lets cancellation abort through the execution seam instead of becoming a result', async () => {
        const source = createTestkitPrepareReviewWorkspace({ results: [], throws: new Error('aborted') });

        await expect(resolveEntrySessionWorkspace(source.deps, REQUEST)).rejects.toThrow('aborted');
    });
});

describe('published workspace fixtures', () => {
    it('are valid on the wire', () => {
        expect(() => TriageConfiguredSourceInstanceV1Schema.parse(testkitConfiguredInstance()))
            .not.toThrow();
        expect(() => TriageReviewWorkspaceObservedRevisionV1Schema.parse(TESTKIT_OBSERVED_REVISION))
            .not.toThrow();
        expect(() => TriageSelectedWorkspaceScopeV1Schema.parse(TESTKIT_SELECTED_WORKSPACE))
            .not.toThrow();
        expect(testkitConfiguredInstance().instance.source).toEqual(TRIAGE_TESTKIT_SOURCE);
    });
});
