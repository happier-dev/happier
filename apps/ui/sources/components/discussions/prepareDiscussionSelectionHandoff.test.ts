import { describe, expect, it } from 'vitest';
import type { DiscussionOpenedMessageV1 } from '@happier-dev/protocol/discussions/actions';
import { DiscussionMessageV1Schema } from '@happier-dev/protocol/discussions/models';
import { createDiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';

import { prepareDiscussionSelectionHandoff, projectWorkflowRunPublishedAnswerIds } from '@/components/discussions/prepareDiscussionSelectionHandoff';

const message = (input: Readonly<{
    id: string;
    seq: number;
    authorAccountId: string | null;
    producerV1?: DiscussionOpenedMessageV1['producerV1'];
    content?: DiscussionOpenedMessageV1['content'];
}>): DiscussionOpenedMessageV1 => {
    const opened = {
    discussionId: 'discussion-a',
    localId: `local-${input.id}`,
    mentionedAccountIds: [],
    createdAt: 1,
    accountActor: input.authorAccountId === null ? null : { v: 1 as const, accountId: input.authorAccountId, profile: null },
    producerV1: input.producerV1 ?? null,
    content: input.content ?? { v: 1 as const, parts: [{ t: 'text' as const, text: input.id }] },
    ...input,
    };
    // The committed row may be unavailable to this reader after decryption.
    const committed = DiscussionMessageV1Schema.parse({ ...opened, content: { t: 'plain', v: opened.content ?? { v: 1, parts: [{ t: 'text', text: input.id }] } } });
    return { ...opened, messageRef: createDiscussionMessageRefV1({ serverId: 'home-a', discussionId: opened.discussionId }, committed) };
};

describe('prepareDiscussionSelectionHandoff', () => {
    it('copies an attachment summary with committed provenance without leaking a private locator', () => {
        const attachment = { kind: 'folder' as const, id: '63d77628-40c9-48c5-93f6-d197c2783ad5',
            name: 'Empty designs', entries: [], directories: ['drafts'] };
        const result = prepareDiscussionSelectionHandoff({
            serverId: 'home-a', discussionId: 'discussion-a', selectedMessageIds: ['m1'],
            messages: [message({ id: 'm1', seq: 1, authorAccountId: 'alice',
                content: { v: 1, parts: [{ t: 'attachment', attachment }] } })],
            resolveAccountLabel: () => 'Alice', format: 'plain',
            roleLabels: { user: 'User', assistant: 'Assistant' }, agentAttributionLabel: 'Via Agent',
        });
        expect(result?.text).toContain(attachment.name);
        expect(result?.text).not.toContain(attachment.id);
        expect(result?.source).toMatchObject({ serverId: 'home-a', discussionId: 'discussion-a', messageIds: ['m1'] });
    });

    it('copies opened passage comments and proposals without interpreting their source as a mention', () => {
        const revision = { headerVersion: 1, bodyVersion: 2 };
        const passage = { ref: { kind: 'doc' as const, artifactId: 'doc', serverId: 'home-a' }, revision,
            range: { start: 0, end: 3 }, quote: 'old' };
        const comments: NonNullable<DiscussionOpenedMessageV1['content']>[] = [
            { kind: 'doc_passage_comment', passage, content: { v: 1, parts: [
                { t: 'text', text: 'Please check ' }, { t: 'mention', participant: { kind: 'account', accountId: 'bob' } },
            ] } },
            { kind: 'doc_edit_proposal', proposal: { target: passage, baseRevision: revision,
                before: 'old', after: 'new', reason: 'clarify' } },
        ];
        for (const [index, content] of comments.entries()) {
            expect(prepareDiscussionSelectionHandoff({
                serverId: 'home-a', discussionId: 'discussion-a', selectedMessageIds: ['m1'],
                messages: [message({ id: 'm1', seq: 1, authorAccountId: 'alice', content })],
                resolveAccountLabel: (id) => id === 'bob' ? 'Bob' : 'Alice', format: 'plain',
                roleLabels: { user: 'User', assistant: 'Assistant' }, agentAttributionLabel: 'Via Agent',
            })).toMatchObject({ text: index === 0 ? 'Please check @Bob' : 'old\nnew\nclarify',
                source: { kind: 'discussion', serverId: 'home-a', discussionId: 'discussion-a', messageIds: ['m1'] } });
        }
    });
    it.each(['home', 'discussion'] as const)('refuses selected content from another %s before assigning current provenance', (scope) => {
        const selected = message({ id: 'm1', seq: 1, authorAccountId: 'alice' });
        const foreign = scope === 'home'
            ? { ...selected, messageRef: { ...selected.messageRef, discussion: { ...selected.messageRef.discussion, serverId: 'other-home' } } }
            : { ...selected, discussionId: 'other-discussion', messageRef: { ...selected.messageRef,
                discussion: { ...selected.messageRef.discussion, discussionId: 'other-discussion' } } };
        expect(prepareDiscussionSelectionHandoff({
            serverId: 'home-a', discussionId: 'discussion-a', selectedMessageIds: ['m1'], messages: [foreign],
            resolveAccountLabel: () => 'Alice', format: 'plain',
            roleLabels: { user: 'User', assistant: 'Assistant' }, agentAttributionLabel: 'Via Agent',
        })).toBeNull();
        const unselected = { ...foreign, id: 'm2', messageRef: { ...foreign.messageRef, messageId: 'm2' } };
        expect(prepareDiscussionSelectionHandoff({
            serverId: 'home-a', discussionId: 'discussion-a', selectedMessageIds: ['m1'], messages: [unselected, selected],
            resolveAccountLabel: () => 'Alice', format: 'plain',
            roleLabels: { user: 'User', assistant: 'Assistant' }, agentAttributionLabel: 'Via Agent',
        })).toMatchObject({ text: 'm1', source: { serverId: 'home-a', discussionId: 'discussion-a', messageIds: ['m1'] } });
    });

    it('uses selected loaded human rows in sequence order and the canonical neutral formatter', () => {
        const labels = new Map([
            ['alice', 'Alice Example'],
            ['bob', 'Bob Example'],
            ['carol', 'Carol Example'],
        ]);
        const result = prepareDiscussionSelectionHandoff({
            serverId: 'home-a',
            discussionId: 'discussion-a',
            selectedMessageIds: ['m3', 'm1', 'agent', 'unavailable'],
            messages: [
                message({ id: 'm3', seq: 3, authorAccountId: 'bob', content: { v: 1, parts: [{ t: 'text', text: 'Hi ' }, { t: 'mention', participant: { kind: 'account', accountId: 'carol' } }] } }),
                message({ id: 'agent', seq: 2, authorAccountId: 'alice', producerV1: { v: 1, kind: 'agent', sessionId: 'session-a' } }),
                message({ id: 'm1', seq: 1, authorAccountId: 'alice', content: { v: 1, parts: [{ t: 'text', text: 'First' }] } }),
                message({ id: 'unavailable', seq: 4, authorAccountId: 'alice', content: null }),
            ],
            resolveAccountLabel: (accountId) => labels.get(accountId) ?? null,
            resolveSessionLabel: (sessionId) => sessionId === 'session-a' ? 'Payments reviewer' : null,
            format: 'markdown_labeled',
            roleLabels: { user: 'User', assistant: 'Assistant' },
            agentAttributionLabel: 'Via Agent',
        });

        // A trusted Agent-posted row is a collaborator row with attribution, not
        // assistant output and not an excluded row.
        expect(result).toEqual({
            text: '**Alice Example:**\n\nFirst\n\n**Payments reviewer · Via Agent:**\n\nagent\n\n**Bob Example:**\n\nHi @Carol Example',
            source: {
                kind: 'discussion',
                serverId: 'home-a',
                discussionId: 'discussion-a',
                messageIds: ['m1', 'agent', 'm3'],
            },
        });
        expect(result?.text).not.toContain('Assistant');
        expect(result?.source).not.toHaveProperty('draftCorrelationId');
    });

    it('returns null instead of leaking Account ids when an author or mention label is unresolved', () => {
        const base = {
            serverId: 'home-a',
            discussionId: 'discussion-a',
            selectedMessageIds: ['m1'],
            format: 'plain' as const,
            roleLabels: { user: 'User', assistant: 'Assistant' },
            agentAttributionLabel: 'Via Agent',
        };
        expect(prepareDiscussionSelectionHandoff({
            ...base,
            messages: [message({ id: 'm1', seq: 1, authorAccountId: 'alice' })],
            resolveAccountLabel: () => null,
        })).toBeNull();
        expect(prepareDiscussionSelectionHandoff({
            ...base,
            messages: [message({ id: 'm1', seq: 1, authorAccountId: 'alice', content: { v: 1, parts: [{ t: 'mention', participant: { kind: 'account', accountId: 'bob' } }] } })],
            resolveAccountLabel: (id) => id === 'alice' ? 'Alice' : null,
        })).toBeNull();
    });

    it('renders an admitted Session mention only with its own display label, never an Account collision or opaque id', () => {
        const input = {
            serverId: 'home-a', discussionId: 'discussion-a', selectedMessageIds: ['m1'],
            messages: [message({ id: 'm1', seq: 1, authorAccountId: 'alice', content: { v: 1, parts: [
                { t: 'mention', participant: { kind: 'session', sessionId: 'same-id' } },
            ] } })],
            resolveAccountLabel: (id: string) => id === 'alice' ? 'Alice' : 'Wrong Account',
            resolveSessionLabel: (id: string) => id === 'same-id' ? 'Build Agent' : null,
            format: 'plain' as const,
            roleLabels: { user: 'User', assistant: 'Assistant' }, agentAttributionLabel: 'Via Agent',
        };
        expect(prepareDiscussionSelectionHandoff(input)?.text).toBe('@Build Agent');
        expect(prepareDiscussionSelectionHandoff({ ...input, resolveSessionLabel: () => null })).toBeNull();
    });
});

describe('projectWorkflowRunPublishedAnswerIds', () => {
    const published = (id: string, seq: number, runId: string, outcome: 'answer' | 'pass' | 'failed', actionId = 'review.verdict') => message({ id, seq, authorAccountId: 'alice',
        producerV1: { v: 1, kind: 'workflow', runId, invocationRecordId: `invocation-${id}`, invocationAttempt: '0',
            execution: { kind: 'action', actionId }, outcome } });

    it('lists each Run\'s answers in thread order and leaves out passes, failures and other producers', () => {
        const byRun = projectWorkflowRunPublishedAnswerIds([
            published('late', 5, 'run-a', 'answer'),
            message({ id: 'human', seq: 1, authorAccountId: 'alice' }),
            published('early', 2, 'run-a', 'answer'),
            published('passed', 3, 'run-a', 'pass'),
            published('stopped', 4, 'run-a', 'failed'),
            published('other-run', 6, 'run-b', 'answer'),
            // A retained pre-fix projection is not an answer or capture source.
            published('internal-projection', 7, 'run-a', 'answer', 'workflow.discussion.round.project'),
        ]);
        expect(Object.fromEntries(byRun)).toEqual({ 'run-a': ['early', 'late'], 'run-b': ['other-run'] });
    });

    it('attributes committed Agent answers to their stamped Workflow Run, retaining outcome and selection eligibility', () => {
        const agent = (id: string, seq: number, outcome: 'answer' | 'pass' | 'failed' | 'cancelled', runId?: string, runtimeRunId = runId) => message({
            id, seq, authorAccountId: 'alice', producerV1: { v: 1, kind: 'agent', sessionId: 'external-plugin-session',
                ...(runtimeRunId ? { runId: runtimeRunId } : {}), replyReturn: { serverId: 'home-a', requestLocalId: `request-${id}`, outcome,
                    ...(runId ? { workflow: { runId, invocationRecordId: `invocation-${id}`, invocationAttempt: '0' } } : {}) } },
        });
        const unavailable = { ...agent('unavailable', 8, 'answer', 'run-a'), content: null };
        const byRun = projectWorkflowRunPublishedAnswerIds([
            agent('late-agent', 7, 'answer', 'run-a'), published('workflow-answer', 2, 'run-a', 'answer'),
            agent('early-agent', 1, 'answer', 'run-a'), agent('pass', 3, 'pass', 'run-a'),
            agent('failed', 4, 'failed', 'run-a'), agent('cancelled', 5, 'cancelled', 'run-a'),
            agent('ordinary-agent', 6, 'answer'), unavailable, agent('other-run', 9, 'answer', 'run-b'),
            agent('ordinary-execution-reply', 10, 'answer', undefined, 'run-a'), agent('marker-owned-answer', 11, 'answer', 'run-a', 'run-b'),
        ]);
        expect(Object.fromEntries(byRun)).toEqual({ 'run-a': ['early-agent', 'workflow-answer', 'late-agent', 'marker-owned-answer'], 'run-b': ['other-run'] });
    });
});
