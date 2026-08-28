import { describe, expect, it } from 'vitest';
import type { SessionId } from '@happier-dev/plugin-sdk/sessions';
import type { QualifiedConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';

import type { TriageEntrySessionStartResultV1 } from './entrySessionOrchestrator.js';
import type {
    TriageEntrySessionWorkspaceFactsV1,
    TriagePreparedReviewWorkspaceFactsV1,
    TriageReviewStartEligibilityV1,
} from './entrySessionWorkspace.js';
import {
    resolvePullRequestReviewStart,
    startPullRequestReview,
    type TriagePullRequestAuthoritativeReviewReadV1,
} from './pullRequestReview.js';
import {
    TESTKIT_OBSERVED_REVISION,
    testkitConfiguredInstance,
} from './testkit/entrySessionTestkit.test-support.js';
import {
    TRIAGE_TESTKIT_SOURCE,
    testkitEntryRef,
} from '../corpus/testkit/observations.test-support.js';

/**
 * The Triage half of safe selected-PR review (`core/SESSIONS.md` §5.2).
 *
 * Every case here is a way a review could be started against commits nobody
 * looked at. The decision is made once, from the facts the settled start
 * already carries, and it invokes nothing at all — which is why these tests
 * need no host boundary to be discriminating.
 */

const SESSION_ID = 'session-7' as SessionId;
const BASE_SHA = '1111111111111111111111111111111111111111';
const HEAD_SHA = '2222222222222222222222222222222222222222';
const OTHER_SHA = '3333333333333333333333333333333333333333';
const ACCOUNT = testkitConfiguredInstance().binding.account;
const ENTRY_REF = testkitEntryRef();
const PULL_REQUEST = { number: 42 } as const;

function preparedWorkspace(
    reviewEligibility: TriageReviewStartEligibilityV1,
): TriagePreparedReviewWorkspaceFactsV1 {
    return {
        kind: 'preparedReviewWorkspace',
        directory: '/workspaces/acme/web',
        branch: 'pr-42',
        created: true,
        pullRequest: PULL_REQUEST,
        currentness: { kind: 'currentAtObservedHead' },
        reviewEligibility,
    };
}

const ELIGIBLE = preparedWorkspace({ status: 'eligible', baseSha: BASE_SHA, headSha: HEAD_SHA });

function opened(
    workspace: TriageEntrySessionWorkspaceFactsV1,
): TriageEntrySessionStartResultV1 {
    return { type: 'opened', sessionId: SESSION_ID, disposition: 'created', workspace };
}

describe('resolvePullRequestReviewStart', () => {
    it('admits the prepared workspace with the exact observed base and head', () => {
        expect(resolvePullRequestReviewStart(opened(ELIGIBLE))).toEqual({
            status: 'eligible',
            sessionId: SESSION_ID,
            baseSha: BASE_SHA,
            headSha: HEAD_SHA,
        });
    });

    it('refuses a reference-only Ask and a selected-project Fix', () => {
        expect(resolvePullRequestReviewStart(opened({ kind: 'referenceOnly' })))
            .toEqual({ status: 'ineligible', reason: 'noPreparedReviewWorkspace' });
        expect(resolvePullRequestReviewStart(
            opened({ kind: 'selectedProject', directory: '/workspaces/acme/web' }),
        )).toEqual({ status: 'ineligible', reason: 'noPreparedReviewWorkspace' });
    });

    it('refuses a worktree the source deliberately preserved at a stale head', () => {
        const stale = preparedWorkspace({
            status: 'ineligible',
            reason: 'localHeadStale',
            resolvedHeadSha: OTHER_SHA,
            observedHeadSha: HEAD_SHA,
            staleReason: 'dirtyWorktree',
        });

        expect(resolvePullRequestReviewStart(opened(stale)))
            .toEqual({ status: 'ineligible', reason: 'localHeadStale' });
    });

    it('refuses a head this start never observed', () => {
        const moved = preparedWorkspace({
            status: 'ineligible',
            reason: 'observedHeadMismatch',
            resolvedHeadSha: OTHER_SHA,
            observedHeadSha: HEAD_SHA,
        });

        expect(resolvePullRequestReviewStart(opened(moved)))
            .toEqual({ status: 'ineligible', reason: 'observedHeadMismatch' });
    });

    it('refuses every start that did not settle on one linked, opened Session', () => {
        // A pending link or open still names a Session id, and starting a review
        // against it would review commits under a relationship that was never
        // committed and a Session the reader is not looking at.
        const unsettled: readonly TriageEntrySessionStartResultV1[] = [
            { type: 'linkPending', sessionId: SESSION_ID, disposition: 'created', workspace: ELIGIBLE },
            { type: 'openPending', sessionId: SESSION_ID, disposition: 'created', workspace: ELIGIBLE },
            { type: 'creationPending', creationKey: 'key-1', outcome: 'accepted', workspace: ELIGIBLE },
            { type: 'creationFailed', creationKey: 'key-1', workspace: ELIGIBLE },
            { type: 'workspacePreparationFailed', reason: 'refused', retryable: false },
            { type: 'rejected', reason: 'existingSessionRequiresReferenceOnlyMode' },
        ];

        for (const result of unsettled) {
            expect(resolvePullRequestReviewStart(result))
                .toEqual({ status: 'ineligible', reason: 'noStableSession' });
        }
    });

    it('refuses an Ask that reused an existing Session even when one is open', () => {
        expect(resolvePullRequestReviewStart({
            type: 'opened',
            sessionId: SESSION_ID,
            disposition: 'existing',
            workspace: { kind: 'referenceOnly' },
        })).toEqual({ status: 'ineligible', reason: 'noPreparedReviewWorkspace' });
    });
});

describe('startPullRequestReview', () => {
    function authoritative(
        overrides: Partial<Extract<TriagePullRequestAuthoritativeReviewReadV1, { status: 'present' }>> = {},
    ): TriagePullRequestAuthoritativeReviewReadV1 {
        return {
            status: 'present',
            source: TRIAGE_TESTKIT_SOURCE,
            account: ACCOUNT,
            entryRef: ENTRY_REF,
            pullRequest: PULL_REQUEST,
            observed: TESTKIT_OBSERVED_REVISION,
            ...overrides,
        };
    }

    function harness(input: Readonly<{
        reread?: TriagePullRequestAuthoritativeReviewReadV1;
        engineList?: unknown;
        selectedEngineIds?: readonly string[];
    }> = {}) {
        const calls: Array<Readonly<{ actionId: string; input: unknown }>> = [];
        const events: string[] = [];
        const selections: unknown[] = [];
        return {
            calls,
            events,
            selections,
            deps: {
                reread: async () => {
                    events.push('reread');
                    return input.reread ?? authoritative();
                },
                execute: async (actionId: string, actionInput: unknown) => {
                    events.push(actionId);
                    calls.push({ actionId, input: actionInput });
                    if (actionId === 'review.engines.list') {
                        return input.engineList ?? {
                            sessionId: SESSION_ID,
                            items: [
                                { engineId: 'codex', label: 'Codex', enabled: true },
                                { engineId: 'claude', label: 'Claude', enabled: true },
                            ],
                        };
                    }
                    if (actionId === 'review.start') return { status: 'started' };
                    throw new Error(`unexpected action ${actionId}`);
                },
                selectEngineIds: async (selection) => {
                    events.push('selectEngineIds');
                    selections.push(selection);
                    return input.selectedEngineIds ?? ['codex', 'claude'];
                },
            },
        };
    }

    const request = {
        startResult: opened(ELIGIBLE),
        prepared: {
            source: TRIAGE_TESTKIT_SOURCE,
            account: ACCOUNT,
            entryRef: ENTRY_REF,
            observed: TESTKIT_OBSERVED_REVISION,
        },
        instructions: 'Review this pull request.',
    } as const;

    it('rereads once after the stable Session, lists engines once, and starts the incumbent fan-out once', async () => {
        const run = harness();

        await expect(startPullRequestReview(run.deps, request)).resolves.toEqual({
            status: 'started',
            result: { status: 'started' },
        });

        expect(run.events).toEqual([
            'reread',
            'review.engines.list',
            'selectEngineIds',
            'review.start',
        ]);
        expect(run.selections).toEqual([expect.objectContaining({
            sessionId: SESSION_ID,
            options: [
                { value: 'codex', label: 'Codex' },
                { value: 'claude', label: 'Claude' },
            ],
        })]);
        expect(run.calls).toEqual([
            { actionId: 'review.engines.list', input: { sessionId: SESSION_ID } },
            {
                actionId: 'review.start',
                input: {
                    sessionId: SESSION_ID,
                    engineIds: ['codex', 'claude'],
                    instructions: 'Review this pull request.',
                    changeType: 'committed',
                    base: { kind: 'commit', baseCommit: BASE_SHA },
                    scmPullRequestReviewScope: {
                        kind: 'scm_pull_request_review_scope.v1',
                        account: ACCOUNT,
                        pullRequest: PULL_REQUEST,
                        observed: TESTKIT_OBSERVED_REVISION,
                    },
                },
            },
        ]);
    });

    it.each([
        ['Ask/existing', {
            ...request,
            startResult: opened({ kind: 'referenceOnly' }),
        }, undefined, 'noPreparedReviewWorkspace'],
        ['source mismatch', request, authoritative({ source: { pluginId: 'other.plugin', localId: 'forge' } }), 'sourceMismatch'],
        ['account mismatch', request, authoritative({
            account: { ...ACCOUNT, accountId: 'other-account' } as QualifiedConnectedAccountRef,
        }), 'accountMismatch'],
        ['pull-request mismatch', request, authoritative({
            entryRef: { ...ENTRY_REF, entryId: '99' },
        }), 'pullRequestMismatch'],
        ['changed base', request, authoritative({
            observed: { ...TESTKIT_OBSERVED_REVISION, baseSha: OTHER_SHA },
        }), 'observationMismatch'],
        ['changed head', request, authoritative({
            observed: { ...TESTKIT_OBSERVED_REVISION, headSha: OTHER_SHA },
        }), 'observationMismatch'],
        ['absent scope facts', request, { status: 'absent' as const }, 'scopeAbsent'],
        ['malformed scope facts', request, authoritative({ pullRequest: {} }), 'scopeMalformed'],
    ] as const)('starts zero reviews for %s', async (_label, reviewRequest, reread, reason) => {
        const run = harness({ ...(reread === undefined ? {} : { reread }) });

        await expect(startPullRequestReview(run.deps, reviewRequest)).resolves.toEqual({
            status: 'refused',
            reason,
        });
        expect(run.calls.filter((call) => call.actionId === 'review.start')).toHaveLength(0);
    });

    it.each([
        ['local head stale', preparedWorkspace({
            status: 'ineligible',
            reason: 'localHeadStale',
            resolvedHeadSha: OTHER_SHA,
            observedHeadSha: HEAD_SHA,
            staleReason: 'dirtyWorktree',
        }), 'localHeadStale'],
        ['local head mismatch', preparedWorkspace({
            status: 'ineligible',
            reason: 'observedHeadMismatch',
            resolvedHeadSha: OTHER_SHA,
            observedHeadSha: HEAD_SHA,
        }), 'observedHeadMismatch'],
    ] as const)('does not reread, list, or start when the %s', async (_label, workspace, reason) => {
        const run = harness();
        const result = await startPullRequestReview(run.deps, {
            ...request,
            startResult: opened(workspace),
        });

        expect(result).toEqual({ status: 'refused', reason });
        expect(run.calls).toHaveLength(0);
    });

    it('does not reread, list, or start when the prepared observation and local eligibility pair disagree', async () => {
        const run = harness();

        await expect(startPullRequestReview(run.deps, {
            ...request,
            startResult: opened(preparedWorkspace({
                status: 'eligible',
                baseSha: OTHER_SHA,
                headSha: HEAD_SHA,
            })),
        })).resolves.toEqual({ status: 'refused', reason: 'observationMismatch' });
        expect(run.events).toHaveLength(0);
    });

    it('starts zero reviews when the selected engines are absent from the one list result', async () => {
        const run = harness({ selectedEngineIds: ['invented-engine'] });

        await expect(startPullRequestReview(run.deps, request)).resolves.toEqual({
            status: 'refused',
            reason: 'engineSelectionInvalid',
        });
        expect(run.calls.map((call) => call.actionId)).toEqual(['review.engines.list']);
    });

    it('starts zero reviews when the one engine list result is malformed', async () => {
        const run = harness({ engineList: { items: [{ enabled: true }] } });

        await expect(startPullRequestReview(run.deps, request)).resolves.toEqual({
            status: 'refused',
            reason: 'engineListMalformed',
        });
        expect(run.calls.map((call) => call.actionId)).toEqual(['review.engines.list']);
    });
});
