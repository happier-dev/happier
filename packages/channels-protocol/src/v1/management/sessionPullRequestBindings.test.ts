import { describe, expect, it } from 'vitest';
import type { ConversationBindingV1 } from './targets.js';
import { parseGithubConversationUrlV1, resolveSessionPullRequestLinksV1, resolveDistinctPullRequestLinksV1, SessionPullRequestLinksV1Schema, SessionPullRequestBindingInputV1Schema } from './sessionPullRequestBindings.js';

const nativeProvider = { repositoryKind: 'github' as const, deployment: 'https://github.com',
    urlTemplate: 'https://github.com/{repository}/pull/{number}', repositoryConnectionKeyPrefix: 'github:repository:',
    publicationInstructions: 'Use native reply Actions.' };

function binding(id: string, createdAt: number, sessionId: string, number: number): ConversationBindingV1 {
    return {
        v: 1, id, createdAt, updatedAt: createdAt, connectionId: 'connection-1',
        endpoint: { kind: 'githubPullRequest', audience: 'shared', id: `pr-${number}`, pullRequest: { repository: 'acme/widgets', number } },
        target: { kind: 'session', sessionId, pullRequestLink: { repository: 'acme/widgets', number },
            policy: { deliveryMode: 'repliesOnly', permissionCeiling: 'read-only', approvals: { kind: 'off' }, newSession: { kind: 'off' } } },
        allowedPrincipalIds: ['principal-1'], allowBotSenders: false, inputMode: 'directMentionsOnly',
        inboundDebounceMs: 0, linkPreviewPolicy: 'suppress', senderFeedback: 'off', authorityEpoch: 1,
        enabled: false, deletionState: 'none',
    };
}

describe('Session pull-request link projection', () => {
    it('admits nonempty bulk operands without mixing singular or state-selected mutations', () => {
        const pullRequests = [{ repository: 'acme/widgets', number: 12 }, { repository: 'acme/widgets', number: 13 }];
        const attach = { kind: 'attach', sessionId: 'session-1', pullRequests };
        expect(SessionPullRequestBindingInputV1Schema.parse(attach)).toEqual(attach);
        const urls = { kind: 'attach', sessionId: 'session-1', pullRequestUrls: ['https://github.com/acme/widgets/pull/12'] };
        expect(SessionPullRequestBindingInputV1Schema.parse(urls)).toEqual(urls);
        const bindings = [{ bindingId: 'binding-1', expectedRevision: 1 }, { bindingId: 'binding-2', expectedRevision: 2 }];
        for (const operand of [{ bindings }, { states: ['merged', 'closed'] }]) {
            const input = { kind: 'unlink', sessionId: 'session-1', ...operand };
            expect(SessionPullRequestBindingInputV1Schema.parse(input)).toEqual(input);
        }
        for (const input of [{ ...attach, pullRequests: [] }, { ...attach, target: { automationId: 'automation-1',
            triggerId: 'trigger-1', triggerRevision: 1, triggerKind: 'prComment' } },
            { ...attach, pullRequest: pullRequests[0] }, { kind: 'unlink', sessionId: 'session-1', states: [] },
            { kind: 'unlink', sessionId: 'session-1', bindings: [] },
            { kind: 'unlink', sessionId: 'session-1', bindings, states: ['merged'] }]) {
            expect(SessionPullRequestBindingInputV1Schema.safeParse(input).success).toBe(false);
        }
    });
    it('projects the URL and provider kind supplied by its native contribution', () => {
        expect(resolveSessionPullRequestLinksV1([binding('native', 1, 'session-1', 12)], {
            repositoryKind: 'gitlab', deployment: 'https://forge.example.test',
            urlTemplate: 'https://forge.example.test/{repository}/merge_requests/{number}',
            repositoryConnectionKeyPrefix: 'forge:', publicationInstructions: 'Native reply.',
        })[0]?.pullRequestLinks[0]).toMatchObject({ provider: 'gitlab',
            url: 'https://forge.example.test/acme/widgets/merge_requests/12' });
    });
    it('admits exact configured and explicit native relation reads without a Session selector', () => {
        const credentialRef = { service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' }, accountId: '99' };
        for (const credential of [credentialRef, null]) expect(SessionPullRequestBindingInputV1Schema.parse({
            kind: 'readRelations', credentialRef: credential, pullRequest: { repositoryId: '77', number: 12 },
        })).toEqual({ kind: 'readRelations', credentialRef: credential, pullRequest: { repositoryId: '77', number: 12 } });
        expect(SessionPullRequestBindingInputV1Schema.safeParse({ kind: 'readRelations' }).success).toBe(false);
        expect(SessionPullRequestBindingInputV1Schema.parse({ kind: 'attach', sessionId: 'session-1',
            pullRequest: { repository: 'acme/widgets', number: 12 }, credentialRef: null, expectedRepositoryId: '77' }))
            .toMatchObject({ credentialRef: null, expectedRepositoryId: '77' });
        expect(SessionPullRequestBindingInputV1Schema.safeParse({ kind: 'attach', sessionId: 'session-1',
            pullRequest: { repository: 'acme/widgets', number: 12 }, linkedAtMs: 42 }).success).toBe(false);
    });
    it('projects the same distinct freshest link from public Watch metadata without a consumer-owned merge', () => {
        const link = { provider: 'github' as const, repository: 'acme/widgets', number: 12, url: 'https://github.com/acme/widgets/pull/12' };
        expect(resolveDistinctPullRequestLinksV1([{ ...link, state: 'open', observedAt: 10 },
            { ...link, state: 'merged', observedAt: 20 }, { ...link, state: 'closed', observedAt: 15 }]))
            .toEqual([{ ...link, state: 'merged', observedAt: 20 }]);
    });
    it('admits a URL attach as an alternative to the structured PR identity', () => {
        const input = { kind: 'attach', sessionId: { selector: 'manager' }, pullRequestUrl: 'https://github.com/acme/widgets/pull/12' };
        expect(SessionPullRequestBindingInputV1Schema.parse(input)).toEqual(input);
        expect(SessionPullRequestBindingInputV1Schema.safeParse({ ...input,
            pullRequest: { repository: 'acme/other', number: 12 } }).success).toBe(false);
        expect(SessionPullRequestBindingInputV1Schema.safeParse({ kind: 'attach', sessionId: 'session-1' }).success).toBe(false);
    });

    it('parses the same exact GitHub conversation URL for attach and endpoint resolution', () => {
        expect(parseGithubConversationUrlV1(' https://github.com/Acme/widgets/pull/12/ '))
            .toEqual({ kind: 'githubPullRequest', repository: 'Acme/widgets', number: 12 });
        expect(parseGithubConversationUrlV1('https://github.com/acme/widgets/issues/12#issuecomment-1'))
            .toEqual({ kind: 'githubIssue', repository: 'acme/widgets', number: 12 });
        for (const value of ['https://example.test/acme/widgets/pull/12', 'https://github.com/acme/widgets/pull/12/files',
            'https://github.com/acme/widgets/pull/0', 'https://github.com/acme/widgets/pull/9007199254740992']) {
            expect(parseGithubConversationUrlV1(value)).toBeNull();
        }
    });

    it('projects only identity-qualified PR observations and uses the freshest duplicate binding', () => {
        const first = binding('a', 1, 'session-1', 1);
        const observed = (id: string, state: 'open' | 'merged', observedAt: number): ConversationBindingV1 => ({
            ...first, id, endpoint: { ...first.endpoint, kind: 'githubPullRequest', audience: 'shared',
                pullRequest: { repository: 'acme/widgets', number: 1 }, pullRequestState: { state, observedAt } },
        });
        expect(resolveSessionPullRequestLinksV1([observed('a', 'open', 10), observed('b', 'merged', 20)], nativeProvider))
            .toMatchObject([{ pullRequestLinks: [{ state: 'merged', observedAt: 20 }] }]);
        expect(resolveSessionPullRequestLinksV1([{ ...observed('c', 'merged', 30),
            endpoint: { ...observed('c', 'merged', 30).endpoint, kind: 'githubPullRequest', audience: 'shared',
                pullRequest: { repository: 'another/widgets', number: 1 }, pullRequestState: { state: 'merged', observedAt: 30 } },
        }], nativeProvider)[0]?.pullRequestLinks[0]).not.toHaveProperty('state');
    });

    it('projects ordered distinct per-session links from retained bindings, including disabled trigger history', () => {
        const historical = { ...binding('binding-b', 1, 'session-1', 2), target: { kind: 'automation', automationId: 'automation-1', policy: { resultDelivery: 'none' }, scopedTrigger: {
            sessionId: 'session-1', triggerId: 'trigger-1', triggerRevision: 0, triggerKind: 'prComment',
            principalPolicy: 'repositoryWriters', pullRequest: { repository: 'acme/widgets', number: 2 },
        } } } satisfies ConversationBindingV1;
        const deleting = { ...binding('binding-deleted', 0, 'session-deleted', 9), enabled: false, deletionState: 'finalizingDelete' } satisfies ConversationBindingV1;
        const ordinaryAutomation = { ...binding('binding-ordinary', 0, 'session-unlinked', 9),
            target: { kind: 'automation', automationId: 'automation-ordinary', policy: { resultDelivery: 'finalResult' } },
        } satisfies ConversationBindingV1;
        const bindings = [binding('binding-z', 4, 'session-2', 2), binding('binding-duplicate', 3, 'session-1', 2), historical,
            binding('binding-a', 1, 'session-1', 1), deleting, ordinaryAutomation];
        expect(resolveSessionPullRequestLinksV1(bindings, nativeProvider)).toEqual([
            { sessionId: 'session-1', pullRequestLinks: [{ provider: 'github', repository: 'acme/widgets', number: 1, url: 'https://github.com/acme/widgets/pull/1' }, { provider: 'github', repository: 'acme/widgets', number: 2, url: 'https://github.com/acme/widgets/pull/2' }] },
            { sessionId: 'session-2', pullRequestLinks: [{ provider: 'github', repository: 'acme/widgets', number: 2, url: 'https://github.com/acme/widgets/pull/2' }] },
        ]);
        expect(bindings[0]?.id).toBe('binding-z');
    });

    it('keeps fix-resolution evidence with the observation while its link passes the public strict reader', () => {
        const source = binding('observed', 1, 'session-1', 1);
        const observed = { ...source, endpoint: { ...source.endpoint, kind: 'githubPullRequest', audience: 'shared',
            pullRequest: { repository: 'acme/widgets', number: 1 },
            pullRequestState: { state: 'open', observedAt: 20,
                fixResolution: { headRevision: 'head-1', resolved: true, incomplete: false } },
        } } satisfies ConversationBindingV1;
        expect(resolveSessionPullRequestLinksV1([observed], nativeProvider).map(row => SessionPullRequestLinksV1Schema.parse(row)))
            .toEqual([{ sessionId: 'session-1', pullRequestLinks: [{ provider: 'github', repository: 'acme/widgets',
                number: 1, url: 'https://github.com/acme/widgets/pull/1', state: 'open', observedAt: 20 }] }]);
        expect(observed.endpoint.pullRequestState.fixResolution.headRevision).toBe('head-1');
    });

    it('requires exact Session qualification on the public list projection', () => {
        const projection = { sessionId: 'session-1', pullRequestLinks: [{ provider: 'github', repository: 'acme/widgets', number: 1, url: 'https://github.com/acme/widgets/pull/1' }] };
        expect(SessionPullRequestLinksV1Schema.parse(projection)).toEqual(projection);
        expect(SessionPullRequestLinksV1Schema.safeParse({ pullRequestLinks: projection.pullRequestLinks }).success).toBe(false);
        expect(SessionPullRequestLinksV1Schema.safeParse({ ...projection, unknown: true }).success).toBe(false);
        const selected = { selector: 'manager' };
        expect(SessionPullRequestBindingInputV1Schema.parse({ kind: 'list', sessionId: selected }))
            .toEqual({ kind: 'list', sessionId: selected });
        expect(SessionPullRequestLinksV1Schema.safeParse({ ...projection, sessionId: selected }).success).toBe(false);
    });
});
