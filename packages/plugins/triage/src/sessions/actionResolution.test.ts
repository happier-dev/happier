import { describe, expect, it } from 'vitest';
import { getActionSpec, type ActionId } from '@happier-dev/protocol';

import {
    TRIAGE_PROMPT_INVOCATION_RESOLVE_ACTION_ID_V1,
    TRIAGE_PROMPT_INVOCATIONS_LIST_ACTION_ID_V1,
    TRIAGE_SPAWN_PROFILES_LIST_ACTION_ID_V1,
    readTriageLaunchProfilesV1,
    readTriagePromptInvocationsV1,
    resolveTriageActionReferencesV1,
    type TriageActionResolutionHostV1,
} from './actionResolution.js';

/**
 * A host that answers the three catalog Actions and records what was asked.
 *
 * The host boundary is the only thing stood in for; the resolution, the verdict
 * vocabulary and the ordering are the real implementation.
 *
 * It admits a request the way the real host does — against that Action's OWN
 * published input schema — rather than answering anything asked of it. A fake
 * that recorded only the action id let this module ship a profiles read the host
 * rejects on every call: the plugin saw a throw, reported `unavailable`, and
 * every test stayed green. Standing in for a boundary means standing in for its
 * refusals too.
 */
function createHost(answers: Readonly<Record<string, unknown | (() => never)>>): Readonly<{
    host: TriageActionResolutionHostV1;
    asked: readonly string[];
    requests: readonly Readonly<{ action: string; input: unknown }>[];
}> {
    const asked: string[] = [];
    const requests: Readonly<{ action: string; input: unknown }>[] = [];
    return {
        asked,
        requests,
        host: {
            async executeAction(action, input) {
                asked.push(action);
                requests.push({ action, input });
                const admitted = getActionSpec(action as ActionId).inputSchema.safeParse(input);
                if (!admitted.success) {
                    throw new Error(`invalid_parameters:${action}:${
                        admitted.error.issues.map((issue) => issue.message).join('; ')
                    }`);
                }
                const answer = answers[action];
                if (typeof answer === 'function') answer();
                if (answer === undefined) throw new Error(`unreachable: ${action}`);
                return answer;
            },
        },
    };
}

const PROFILES = {
    items: [
        { id: 'profile-1', name: 'Focused', placement: 'ask', checkout: 'create_worktree' },
        { id: 'profile-2', name: 'Fast' },
    ],
    coverage: 'complete',
};

describe('resolveTriageActionReferencesV1', () => {
    it('resolves both references before anything can be created', async () => {
        const { host, asked } = createHost({
            [TRIAGE_SPAWN_PROFILES_LIST_ACTION_ID_V1]: PROFILES,
            [TRIAGE_PROMPT_INVOCATION_RESOLVE_ACTION_ID_V1]: {
                status: 'resolved',
                text: 'Review this change.',
            },
        });

        const resolved = await resolveTriageActionReferencesV1(host, {
            profileId: 'profile-1',
            target: { promptInvocationId: 'invocation-1' },
        });

        expect(resolved).toEqual({
            status: 'resolved',
            profile: {
                status: 'read',
                profileId: 'profile-1',
                preferences: { placement: 'ask', checkout: 'create_worktree' },
            },
            prompt: { status: 'resolved', invocationId: 'invocation-1', text: 'Review this change.' },
        });
        expect(asked).toEqual([
            TRIAGE_SPAWN_PROFILES_LIST_ACTION_ID_V1,
            TRIAGE_PROMPT_INVOCATION_RESOLVE_ACTION_ID_V1,
        ]);
    });

    it('treats an unconfigured reference as the approved default, not as a failure', async () => {
        const { host, asked } = createHost({});

        expect(await resolveTriageActionReferencesV1(host, {
            profileId: null,
            target: { promptInvocationId: null },
        })).toEqual({ status: 'resolved' });
        // Nothing was asked, because nothing was configured.
        expect(asked).toEqual([]);
    });

    it('refuses a deleted profile as referenceMissing without resolving the prompt', async () => {
        // The deciding case. A profile the catalog does not hold used to read as
        // "no preference": the Session was created with the very defaults the
        // person configured away from, and nothing said so.
        const { host, asked } = createHost({
            [TRIAGE_SPAWN_PROFILES_LIST_ACTION_ID_V1]: PROFILES,
            [TRIAGE_PROMPT_INVOCATION_RESOLVE_ACTION_ID_V1]: {
                status: 'resolved',
                text: 'Never asked for.',
            },
        });

        expect(await resolveTriageActionReferencesV1(host, {
            profileId: 'profile-deleted',
            target: { promptInvocationId: 'invocation-1' },
        })).toEqual({
            status: 'referenceMissing',
            reference: 'profile',
            id: 'profile-deleted',
        });
        expect(asked).toEqual([TRIAGE_SPAWN_PROFILES_LIST_ACTION_ID_V1]);
    });

    it('separates a catalog that did not answer from one that answered "no"', async () => {
        const { host } = createHost({
            [TRIAGE_SPAWN_PROFILES_LIST_ACTION_ID_V1]: () => { throw new Error('offline'); },
        });

        expect(await resolveTriageActionReferencesV1(host, {
            profileId: 'profile-1',
            target: { promptInvocationId: null },
        })).toEqual({
            status: 'referenceUnavailable',
            reference: 'profile',
            id: 'profile-1',
        });
    });

    it('refuses a deleted prompt as referenceMissing rather than after the Session exists', async () => {
        const { host } = createHost({
            [TRIAGE_SPAWN_PROFILES_LIST_ACTION_ID_V1]: PROFILES,
            [TRIAGE_PROMPT_INVOCATION_RESOLVE_ACTION_ID_V1]: { status: 'unknownInvocation' },
        });

        expect(await resolveTriageActionReferencesV1(host, {
            profileId: 'profile-2',
            target: { promptInvocationId: 'invocation-gone' },
        })).toEqual({
            status: 'referenceMissing',
            reference: 'prompt',
            id: 'invocation-gone',
        });
    });

    it('refuses an empty resolution as terminal invalid input rather than a retryable outage', async () => {
        const { host } = createHost({
            [TRIAGE_PROMPT_INVOCATION_RESOLVE_ACTION_ID_V1]: { status: 'resolved', text: '   ' },
        });

        expect(await resolveTriageActionReferencesV1(host, {
            profileId: null,
            target: { promptInvocationId: 'invocation-empty' },
        })).toEqual({
            status: 'referenceInvalid',
            reference: 'prompt',
            id: 'invocation-empty',
        });
    });
});

describe('readTriageLaunchProfilesV1', () => {
    it('offers the profiles a person can pick by name, keyed by the stable id', async () => {
        const { host } = createHost({ [TRIAGE_SPAWN_PROFILES_LIST_ACTION_ID_V1]: PROFILES });

        expect(await readTriageLaunchProfilesV1(host)).toEqual({
            status: 'read',
            coverage: 'complete',
            profiles: [
                { id: 'profile-1', name: 'Focused' },
                { id: 'profile-2', name: 'Fast' },
            ],
        });
    });

    it('asks the catalog for every profile, with no agent scope and no bound', async () => {
        // The request shape IS the contract here. Scoping this read by an agent
        // is what made it unanswerable — a Triage action selects the profile
        // first and the profile then supplies the agent — and bounding it is
        // what makes an absent row ambiguous.
        const { host, requests } = createHost({
            [TRIAGE_SPAWN_PROFILES_LIST_ACTION_ID_V1]: PROFILES,
        });

        await readTriageLaunchProfilesV1(host);

        expect(requests).toEqual([
            { action: TRIAGE_SPAWN_PROFILES_LIST_ACTION_ID_V1, input: {} },
        ]);
    });

    it('keeps a nameless profile rather than hiding one a person may have configured', async () => {
        const { host } = createHost({
            [TRIAGE_SPAWN_PROFILES_LIST_ACTION_ID_V1]: { items: [{ id: 'profile-3' }, { name: 'no id' }] },
        });

        expect(await readTriageLaunchProfilesV1(host)).toEqual({
            status: 'read',
            coverage: 'complete',
            profiles: [{ id: 'profile-3', name: 'profile-3' }],
        });
    });

    it('reports an unreachable catalog rather than an empty one', async () => {
        const { host } = createHost({
            [TRIAGE_SPAWN_PROFILES_LIST_ACTION_ID_V1]: () => { throw new Error('offline'); },
        });

        expect(await readTriageLaunchProfilesV1(host)).toEqual({ status: 'unavailable' });
    });

    it('carries a bounded answer as incomplete rather than as the whole account', async () => {
        const { host } = createHost({
            [TRIAGE_SPAWN_PROFILES_LIST_ACTION_ID_V1]: {
                items: [{ id: 'profile-1', name: 'Focused' }],
                totalCount: 2,
                truncated: true,
            },
        });

        expect(await readTriageLaunchProfilesV1(host)).toEqual({
            status: 'read',
            coverage: 'truncated',
            profiles: [{ id: 'profile-1', name: 'Focused' }],
        });
    });
});

describe('a profile hidden by a newer schema', () => {
    it('is unreadable, never genuinely missing or merely truncated away', async () => {
        const { host } = createHost({
            [TRIAGE_SPAWN_PROFILES_LIST_ACTION_ID_V1]: {
                items: [{ id: 'profile-1', name: 'Focused' }],
                coverage: 'unreadable',
            },
        });

        expect(await resolveTriageActionReferencesV1(host, {
            profileId: 'profile-future',
            target: { promptInvocationId: null },
        })).toEqual({
            status: 'referenceNotVisible',
            reference: 'profile',
            id: 'profile-future',
            reason: 'unreadable',
        });
    });
});

describe('a profile absent from a bounded answer', () => {
    it('is unavailable, never "no longer in your account"', async () => {
        // The false verdict this replaces was non-retryable: it told somebody
        // to repoint a reference to a profile their account still holds.
        const { host } = createHost({
            [TRIAGE_SPAWN_PROFILES_LIST_ACTION_ID_V1]: {
                items: [{ id: 'profile-1', name: 'Focused' }],
                totalCount: 2,
                truncated: true,
            },
        });

        expect(await resolveTriageActionReferencesV1(host, {
            profileId: 'profile-2',
            target: { promptInvocationId: null },
        })).toEqual({
            status: 'referenceNotVisible',
            reference: 'profile',
            id: 'profile-2',
            reason: 'truncated',
        });
    });
});

describe('readTriagePromptInvocationsV1', () => {
    it('carries complete inventory coverage to the editor', async () => {
        const { host } = createHost({
            [TRIAGE_PROMPT_INVOCATIONS_LIST_ACTION_ID_V1]: {
                items: [{ id: 'prompt-1', token: '/review', title: 'Review' }],
                coverage: 'complete',
            },
        });

        expect(await readTriagePromptInvocationsV1(host)).toEqual({
            status: 'read',
            coverage: 'complete',
            invocations: [{ id: 'prompt-1', token: '/review', title: 'Review' }],
        });
    });

    it('keeps absence inconclusive when the inventory is truncated', async () => {
        const { host } = createHost({
            [TRIAGE_PROMPT_INVOCATIONS_LIST_ACTION_ID_V1]: {
                items: [{ id: 'prompt-1', token: '/review', title: 'Review' }],
                coverage: 'truncated',
            },
        });

        expect(await readTriagePromptInvocationsV1(host)).toMatchObject({
            status: 'read',
            coverage: 'truncated',
        });
    });
});
