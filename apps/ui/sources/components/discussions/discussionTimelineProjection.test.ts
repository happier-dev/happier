import { describe, expect, it } from 'vitest';
import { DiscussionDocEditProposalContentV1Schema, DiscussionMessageContentV1Schema, DiscussionProducerV1Schema } from '@happier-dev/protocol/discussions/content';
import { INTERNAL_TASK_SOURCE_V1, internalTaskLocalRefV1 } from '@happier-dev/protocol/tasks/entryRefV1';

import {
    NO_SESSION_AGENT_ACTIVITY_ATTENTION,
    type AgentActivityEntry,
} from '@/sync/domains/session/agentActivity';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';

import { buildDiscussionTimelineItems, projectDiscussionWorkflowRounds, placeDiscussionRequesterApprovals, projectDiscussionMessageReferences, projectDiscussionMessageLabels, readDiscussionMessagePreview, resolveDiscussionMessageAuthorLabel, resolveDiscussionMessageSpeakerLabel, resolveDiscussionMessageSpeakerKind, resolveDiscussionOutwardReply, resolveDiscussionReplyAttributionLine, resolveDiscussionReplyOutcome, resolveDiscussionWorkflowAttribution, readDiscussionWorkflowResultDetail, resolveDiscussionReplyPresentation, startsDiscussionMessageGroup } from '@/components/discussions/discussionTimelineProjection';
import { t } from '@/text';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';

describe('readDiscussionMessagePreview', () => {
    it('projects an identity-only entry without disclosing the raw identity', () => {
        const entry = { source: INTERNAL_TASK_SOURCE_V1, ...internalTaskLocalRefV1('private-task-id', 'other-account') };
        const content = DiscussionMessageContentV1Schema.parse({ v: 1, parts: [{ t: 'triage_entry', entry }] });
        const projection = projectDiscussionMessageReferences(content);
        expect(projection.readableText).toContain(t('session.collaboration.discussion.quote.task'));
        expect(projection.text).not.toContain('private-task-id');
        expect([...projection.inline.values()]).toEqual([expect.objectContaining({ entry })]);
    });

    it('binds repeated attachment tokens once per occurrence without duplicating the retained metadata', () => {
        const id = '762847e4-14cb-45c2-9e3a-06db902a417a';
        const token = `[diagram.png](happier-ref:attachment:${id})`;
        const projection = projectDiscussionMessageReferences({ v: 1, parts: [
            { t: 'text', text: `Inspect ${token} beside ${token}` },
            { t: 'attachment', attachment: { kind: 'file', id, name: 'diagram.png', file: {
                blobId: id, mime: 'image/png', sizeBytes: 3, sha256: 'a'.repeat(64),
            } } },
        ] });
        // A thread names a picture as a Session does: Image #1, at each place the author put it.
        expect(projection.readableText.match(/Image #1/g)).toHaveLength(2);
        expect(projection.inline.get(`attachment:${id}`)?.tokenStarts?.size).toBe(2);
        expect(projection.text.match(/happier-ref:attachment:/g)).toHaveLength(2);
    });

    it('draws a file the author placed in the text as its inline chip, a picture as Image #N like a Session', () => {
        const id = '762847e4-14cb-45c2-9e3a-06db902a417a';
        const ref = `attachment:${id}`;
        const projection = projectDiscussionMessageReferences({ v: 1, parts: [
            { t: 'reference', reference: { kind: 'attachment', ref, token: `[graph.png](happier-ref:${ref})`, label: 'graph.png' } },
            { t: 'text', text: ' from the deploy' },
            { t: 'attachment', attachment: { kind: 'file', id, name: 'graph.png', file: { blobId: id, mime: 'image/png', sizeBytes: 3, sha256: 'a'.repeat(64) } } },
        ] }, {}, undefined, 'omit');
        expect(projection.inline.get(ref)).toMatchObject({ label: 'Image #1', imageNumber: 1 });
        expect(projection.readableText).toContain('Image #1');
    });

    it('lets a thread row that draws the files below keep only the chips the author placed', () => {
        const placed = '762847e4-14cb-45c2-9e3a-06db902a417a';
        const unplaced = '63d77628-40c9-48c5-93f6-d197c2783ad5';
        const file = (id: string, name: string) => ({ t: 'attachment' as const, attachment: { kind: 'file' as const, id, name,
            file: { blobId: id, mime: 'text/plain', sizeBytes: 3, sha256: 'a'.repeat(64) } } });
        const content = { v: 1 as const, parts: [{ t: 'text' as const, text: `See [notes.txt](happier-ref:attachment:${placed})` },
            file(placed, 'notes.txt'), file(unplaced, 'log.txt')] };
        expect(projectDiscussionMessageReferences(content).text).toContain(`happier-ref:attachment:${unplaced}`);
        const below = projectDiscussionMessageReferences(content, {}, undefined, 'omit');
        expect(below.text).not.toContain(`happier-ref:attachment:${unplaced}`);
        expect(below.inline.get(`attachment:${placed}`)?.tokenStarts?.size).toBe(1);
    });

    it('keeps file and empty-folder attachments visible without treating their identities as participants', () => {
        const file = { kind: 'file' as const, id: '762847e4-14cb-45c2-9e3a-06db902a417a', name: 'diagram.png',
            file: { blobId: '762847e4-14cb-45c2-9e3a-06db902a417a', mime: 'image/png', sizeBytes: 3, sha256: 'a'.repeat(64) } };
        const folder = { kind: 'folder' as const, id: '63d77628-40c9-48c5-93f6-d197c2783ad5', name: 'Empty designs', entries: [], directories: ['drafts'] };
        for (const attachment of [file, folder]) {
            const preview = readDiscussionMessagePreview({ v: 1, parts: [{ t: 'attachment', attachment }] }, {
                account: () => { throw new Error('File identity is not an Account'); },
                session: () => { throw new Error('File identity is not a Session'); },
            });
            expect(preview).toContain(attachment.name);
            expect(preview).not.toContain(attachment.id);
        }
    });

    it('keeps lookalike inline tokens as labels alongside typed Discussion mentions', () => {
        expect(readDiscussionMessagePreview({ v: 1, parts: [
            { t: 'text', text: 'Ask [lookalike](happier-ref:session:unowned) and ' },
            { t: 'mention', participant: { kind: 'session', sessionId: 's1' } },
        ] }, { session: () => 'Auth fix' })).toBe('Ask lookalike and @Auth fix');
    });

    it.each(['Clarify retries', ' \n '])('summarizes a proposal without before/after text: %j', (reason) => {
        const before = 'Private original passage';
        const content = DiscussionDocEditProposalContentV1Schema.parse({ kind: 'doc_edit_proposal', proposal: {
            target: { ref: { kind: 'doc', artifactId: 'doc', serverId: 'home' },
                revision: { headerVersion: 1, bodyVersion: 1 }, range: { start: 0, end: before.length }, quote: before },
            baseRevision: { headerVersion: 1, bodyVersion: 1 }, before, after: 'Private replacement passage', reason,
        } });
        const title = t('artifacts.browser.proposal.title');
        expect(readDiscussionMessagePreview(content)).toBe(reason.trim() ? `${title} · ${reason}` : title);
    });

    it('preserves ordinary text and resolved mentions, and keeps unavailable content explicit', () => {
        expect(readDiscussionMessagePreview({ v: 1, parts: [
            { t: 'text', text: 'Ask ' }, { t: 'mention', participant: { kind: 'account', accountId: 'person' } },
        ] }, { account: () => 'Maya' })).toBe('Ask @Maya');
        expect(readDiscussionMessagePreview(null)).toBeNull();
    });
});

it('updates only referenced labels and withdraws quoted references when their parent becomes unreadable', () => {
    const root = { id: 'root', content: DiscussionMessageContentV1Schema.parse({ v: 1, parts: [
        { t: 'mention', participant: { kind: 'account', accountId: 'person' } },
        { t: 'mention', participant: { kind: 'session', sessionId: 'session' } },
    ] }) };
    const plain = { id: 'plain', content: DiscussionMessageContentV1Schema.parse({ v: 1, parts: [{ t: 'text', text: 'Unrelated' }] }) };
    const replyTarget = { kind: 'message', messageId: 'root' } satisfies NonNullable<Parameters<typeof projectDiscussionMessageLabels>[0][number]['replyTarget']>;
    const reply = { id: 'reply', content: plain.content, replyTarget };
    let account: string | null = 'Maya';
    let session: string | null = 'Reviewer';
    const labels = { account: () => account, session: () => session };
    const first = projectDiscussionMessageLabels([root, plain, reply], labels);
    const arrival = { id: 'arrival', content: plain.content };
    const next = projectDiscussionMessageLabels([root, plain, reply, arrival], labels, first);
    for (const row of [root, plain, reply]) expect(next.get(row.id)).toBe(first.get(row.id));
    account = 'Mei';
    session = null;
    const changed = projectDiscussionMessageLabels([root, plain, reply, arrival], labels, next);
    expect(changed.get('plain')).toBe(next.get('plain'));
    expect(changed.get('root')?.account('person')).toBe('Mei');
    expect(changed.get('reply')?.session('session')).toBeNull();
    const withheld = projectDiscussionMessageLabels([{ ...root, content: null }, plain, reply, arrival], labels, changed);
    expect(withheld.get('reply')).not.toBe(changed.get('reply'));
    expect(withheld.get('reply')?.account('person')).toBeNull();
});

describe('resolveDiscussionMessageAuthorLabel', () => {
    it.each([
        [{ name: 'Maya Chen', username: 'maya' }, 'Maya Chen'],
        [{ name: '  ', username: 'maya' }, 'maya'],
        [null, t('accountDisplay.yours')],
    ] as const)('names the optimistic own message from the scoped viewer profile: %j', (profile, expected) => {
        expect(resolveDiscussionMessageAuthorLabel({ authorAccountId: 'viewer', accountActor: null, createdAt: 0 }, {
            accountId: 'viewer', profile,
        })).toBe(expected);
    });

    it('keeps historical and other Accounts distinct from the viewer', () => {
        const viewer = { serverId: 'home', accountId: 'viewer', profile: { name: 'Maya Chen' } };
        expect(resolveDiscussionMessageAuthorLabel({ authorAccountId: 'other', accountActor: null, createdAt: 0 }, viewer))
            .toBe(t('session.collaboration.discussion.collaborator'));
        expect(resolveDiscussionMessageAuthorLabel({ authorAccountId: 'viewer', accountActor: { v: 1, accountId: 'viewer', profile: null }, createdAt: 1 }, viewer))
            .toBe(t('message.accountActorFormerMember'));
        expect(resolveDiscussionMessageAuthorLabel({ authorAccountId: 'viewer', accountActor: null, createdAt: 1 }, viewer))
            .toBe(t('session.collaboration.discussion.collaborator'));
        expect(resolveDiscussionMessageAuthorLabel({ authorAccountId: 'other', accountActor: {
            v: 1, accountId: 'other', accessibility: 'former',
            profile: { name: 'Visible Bob', firstName: null, lastName: null, username: null, avatarUrl: null },
        }, createdAt: 1 }, viewer)).toBe(t('message.accountActorFormerMember'));
    });
});

describe('resolveDiscussionMessageSpeakerLabel', () => {
    const person = {
        authorAccountId: 'owner',
        accountActor: {
            v: 1 as const,
            accountId: 'owner',
            profile: { name: 'QA owner', firstName: null, lastName: null, username: null, avatarUrl: null },
        },
        createdAt: 1,
    };

    it('projects one speaker identity for person, Agent Session and Workflow Run messages', () => {
        expect(resolveDiscussionMessageSpeakerLabel({ ...person, producerV1: null }, {
            session: () => null,
            workflowRun: () => null,
        })).toBe('QA owner');
        expect(resolveDiscussionMessageSpeakerLabel({ ...person, producerV1: {
            v: 1, kind: 'agent', sessionId: 'session-reviewer', runId: 'run-agent',
        } }, {
            session: (sessionId) => sessionId === 'session-reviewer' ? 'Payments reviewer' : null,
            workflowRun: () => null,
        })).toBe('Payments reviewer');
        expect(resolveDiscussionMessageSpeakerLabel({ ...person, producerV1: {
            v: 1, kind: 'workflow', runId: 'run-release', invocationRecordId: 'invocation-release',
            invocationAttempt: '0', execution: { kind: 'action', actionId: 'workflow.discussion.round.project' }, outcome: 'answer',
        } }, {
            session: () => null,
            workflowRun: (runId) => runId === 'run-release' ? 'Release review' : null,
        })).toBe('Release review');
    });
});

describe('external channel provenance', () => {
    // The connection owner's Account posts an inbound email or chat message; the sender picks their own name.
    const owner = { v: 1 as const, accountId: 'owner', profile: { name: 'Maya Chen', firstName: null, lastName: null, username: null, avatarUrl: null } };
    const external = (senderDisplayName?: string) => ({
        id: 'm-ext', authorAccountId: 'owner', accountActor: owner, createdAt: 1, producerV1: null,
        replyTarget: null,
        content: { v: 1 as const, parts: [{ t: 'text' as const, text: 'Can you check the invoice?' }],
            externalSource: { kind: 'channel' as const, providerPluginId: 'happier.channel.email', conversationDisplayName: 'billing@acme.example',
                ...(senderDisplayName ? { senderDisplayName } : {}) } },
    });
    const labels = { account: (accountId: string) => accountId === 'owner' ? 'Maya Chen' : null, session: () => null, workflowRun: () => null };

    it('names the outside sender, never the member whose connection carried it, even when they pick a member name', () => {
        expect(resolveDiscussionMessageSpeakerKind(external('Maya Chen'))).toBe('external');
        expect(resolveDiscussionMessageSpeakerLabel(external('Jordan from Acme'), labels)).toBe('Jordan from Acme');
        expect(resolveDiscussionMessageSpeakerLabel(external(), labels)).not.toBe('Maya Chen');
        expect(resolveDiscussionMessageSpeakerKind({ ...external(), content: { v: 1, parts: [{ t: 'text', text: 'hi' }] } })).toBe('person');
        // Posted by the same Account, the outside sender still opens their own byline after the member's message.
        const memberMessage = { ...external(), content: { v: 1 as const, parts: [{ t: 'text' as const, text: 'Forwarding' }] } };
        expect(startsDiscussionMessageGroup(external('Maya Chen'), memberMessage)).toBe(true);
        expect(startsDiscussionMessageGroup(memberMessage, external('Maya Chen'))).toBe(true);
        expect(startsDiscussionMessageGroup(external('Jordan'), external('Jordan'))).toBe(false);
    });

    it('says a reply under an external message leaves Happier, through any reply depth', () => {
        const root = external('Jordan from Acme');
        const reply = { id: 'm-reply', content: { v: 1 as const, parts: [{ t: 'text' as const, text: 'On it' }] },
            replyTarget: { kind: 'message' as const, messageId: 'm-ext' } };
        const byId = new Map<string, unknown>([['m-ext', root], ['m-reply', reply]]) as Parameters<typeof resolveDiscussionOutwardReply>[1];
        expect(resolveDiscussionOutwardReply('m-ext', byId)?.conversationDisplayName).toBe('billing@acme.example');
        expect(resolveDiscussionOutwardReply('m-reply', byId)?.conversationDisplayName).toBe('billing@acme.example');
        expect(resolveDiscussionOutwardReply(null, byId)).toBeNull();
    });
});

describe('resolveDiscussionReplyAttributionLine', () => {
    const persona = { serverId: 'home', sessionId: 'release-bot' };
    const viewer = { serverId: 'home', accountId: 'viewer' };
    const reply = (requesterAccountId: string | null, actor: { accountId: string; name: string } | null) => ({
        producerV1: { v: 1 as const, kind: 'agent' as const, sessionId: 'release-bot', actionRequestAttributionV1: {
            requestRef: 'req-1', requester: requesterAccountId ? { serverId: 'home', accountId: requesterAccountId } : null, persona, origin: null } },
        requesterAccountActor: actor ? { v: 1 as const, accountId: actor.accountId, profile: { name: actor.name, firstName: null, lastName: null, username: null, avatarUrl: null } } : null,
    });

    it('names who asked, from the stamped cause only (the row already names the agent)', () => {
        expect(resolveDiscussionReplyAttributionLine(reply('bob', { accountId: 'bob', name: 'Bob Keller' }), viewer))
            .toBe(t('session.collaboration.discussion.attribution.askedBy', { requester: 'Bob Keller' }));
        expect(resolveDiscussionReplyAttributionLine(reply('viewer', { accountId: 'viewer', name: 'Maya Chen' }), viewer))
            .toBe(t('session.collaboration.discussion.attribution.askedBy', { requester: t('session.collaboration.discussion.attribution.you') }));
    });

    it('uses the current thread Account presentation instead of an older requester snapshot', () => {
        expect(resolveDiscussionReplyAttributionLine(
            reply('bob', { accountId: 'bob', name: 'Bob Keller' }),
            viewer,
            { account: () => t('message.accountActorFormerMember') },
        )).toBe(t('session.collaboration.discussion.attribution.askedBy', {
            requester: t('message.accountActorFormerMember'),
        }));
    });

    it.each([
        ['former member', { v: 1 as const, accountId: 'bob', accessibility: 'former' as const,
            profile: { name: 'Still visible Bob', firstName: null, lastName: null, username: null, avatarUrl: null } }, t('message.accountActorFormerMember')],
        ['unknown requester', null, t('session.collaboration.discussion.attribution.anotherPerson')],
        ['current member', reply('bob', { accountId: 'bob', name: 'Bob Keller' }).requesterAccountActor, 'Bob Keller'],
        ['unnamed current member', reply('bob', { accountId: 'bob', name: '  ' }).requesterAccountActor, t('message.accountActorUnnamedMember')],
    ] as const)('distinguishes the %s in the admitted requester projection', (_case, requesterAccountActor, name) => {
        expect(resolveDiscussionReplyAttributionLine({ ...reply('bob', null), requesterAccountActor }, viewer))
            .toBe(t('session.collaboration.discussion.attribution.askedBy', { requester: name }));
    });

    it('keeps an unprojected or mismatched requester unknown and says nothing without a person cause', () => {
        const other = t('session.collaboration.discussion.attribution.anotherPerson');
        expect(resolveDiscussionReplyAttributionLine(reply('bob', null), viewer))
            .toBe(t('session.collaboration.discussion.attribution.askedBy', { requester: other }));
        expect(resolveDiscussionReplyAttributionLine(reply('bob', { accountId: 'owner', name: 'Bot Owner' }), viewer))
            .toBe(t('session.collaboration.discussion.attribution.askedBy', { requester: other }));
        expect(resolveDiscussionReplyAttributionLine({ ...reply('bob', null),
            requesterAccountActor: { v: 1, accountId: 'owner', profile: null } }, viewer))
            .toBe(t('session.collaboration.discussion.attribution.askedBy', { requester: other }));
        expect(resolveDiscussionReplyAttributionLine(reply('viewer', null), { serverId: 'elsewhere', accountId: 'viewer' }))
            .toBe(t('session.collaboration.discussion.attribution.askedBy', { requester: other }));
        expect(resolveDiscussionReplyAttributionLine(reply(null, null), viewer)).toBeNull();
        expect(resolveDiscussionReplyAttributionLine({ producerV1: { v: 1, kind: 'agent', sessionId: 'release-bot' }, requesterAccountActor: null }, viewer)).toBeNull();
        expect(resolveDiscussionReplyAttributionLine({ producerV1: null }, viewer)).toBeNull();
    });
});

function workflowRun(id: string, params: Readonly<{ messageId: string; serverId?: string; discussionId?: string }>) {
    return createWorkflowRunSummaryFixture({ id, origin: { kind: 'direct', discussion: {
        discussion: { serverId: params.serverId ?? 'home-1', discussionId: params.discussionId ?? 'discussion-1' },
        messageId: params.messageId, throughSeq: 1,
    } } });
}

function message(id: string, seq: number) {
    return { id, seq };
}

it('shows readable messages before Run decorations settle and retains unchanged rows as they arrive', () => {
    const messages = [message('question', 1), message('answer', 2)];
    const params = { serverId: 'home-1', discussionId: 'discussion-1', messages, subagents: [],
        readExecutionRunEntry: () => null, workflowRunAnswerIds: new Map([['run-ready', ['answer']]]) };
    const cold = buildDiscussionTimelineItems({ ...params, workflowRuns: [] });
    expect(cold.map(item => item.kind)).toEqual(['human_message', 'human_message']);
    const workflowRuns = [{ ...workflowRun('run-ready', { messageId: 'question' }), state: 'succeeded' as const }];
    const shown = buildDiscussionTimelineItems({ ...params, workflowRuns }, cold);
    expect(shown.map(item => item.kind)).toEqual(['human_message', 'workflow_run', 'human_message', 'workflow_run_end']);
    expect(shown[0]).toBe(cold[0]);
    expect(shown[2]).toBe(cold[1]);
    const arrival = message('arrival', 3);
    const pending = buildDiscussionTimelineItems({ ...params, messages: [...messages, arrival], workflowRuns }, shown);
    expect(pending.slice(0, shown.length)).toEqual(shown);
    expect(pending.at(-1)).toMatchObject({ kind: 'human_message', message: arrival });
    expect(pending[0]).toBe(shown[0]);
});

it('publishes only the arriving timeline model across 300 messages and three Runs', () => {
    const messages = Array.from({ length: 300 }, (_, index) => message(`message-${index + 1}`, index + 1));
    const params = { serverId: 'home-1', discussionId: 'discussion-1', messages, subagents: [],
        readExecutionRunEntry: () => null,
        workflowRuns: [100, 200, 300].map(seq => workflowRun(`run-${seq}`, { messageId: `message-${seq}` })),
    };
    const previous = buildDiscussionTimelineItems(params);
    const next = buildDiscussionTimelineItems({ ...params, messages: [...messages, message('arrival', 301)] }, previous);
    const current = new Set(next);
    const republished = previous.filter(item => !current.has(item)).length;
    console.info('Discussion unchanged timeline models republished', republished);
    expect(republished).toBe(0);
    expect(next).toHaveLength(previous.length + 1);
});

it('keeps unchanged requester-card groups stable when another message arrives', () => {
    const messages = Array.from({ length: 300 }, (_, index) => ({ id: `message-${index + 1}`, producerV1: null }));
    const approvals = [50, 100, 200, 300].map(seq => ({ requestRef: `request-${seq}`, originMessageId: `message-${seq}` }));
    const previous = placeDiscussionRequesterApprovals(messages, approvals);
    const next = placeDiscussionRequesterApprovals([...messages, { id: 'arrival', producerV1: null }], approvals, previous);
    const republished = [...previous].filter(([id, group]) => next.get(id) !== group).length;
    console.info('Discussion unchanged approval groups republished', republished);
    expect(republished).toBe(0);
});

function entry(runId: string, startedAtMs: number | null): AgentActivityEntry {
    return {
        id: `execution_run:${runId}`,
        kind: 'execution_run',
        status: 'running',
        title: runId,
        metaDetail: null,
        startedAtMs,
        endedAtMs: null,
        provenance: 'local',
        detailState: 'loaded',
        parentId: null,
        runId,
        sidechainId: null,
        subagentId: `execution_run:${runId}`,
        attentionKinds: NO_SESSION_AGENT_ACTIVITY_ATTENTION,
    };
}

function run(params: Readonly<{
    runId: string;
    serverId?: string;
    discussionId?: string;
    messageIds?: readonly string[];
}>): SessionSubagent {
    return {
        id: `execution_run:${params.runId}`,
        kind: 'execution_run',
        status: 'running',
        display: { title: params.runId },
        transcript: {},
        runRef: {
            runId: params.runId,
            launchOrigin: {
                kind: 'discussion',
                serverId: params.serverId ?? 'home-1',
                discussionId: params.discussionId ?? 'discussion-1',
                messageIds: [...(params.messageIds ?? ['message-1'])],
            },
        },
        recipient: null,
        capabilities: {
            canOpen: true,
            canSend: false,
            canStop: false,
            canLaunchChild: false,
            canDelete: false,
            canOpenAdvancedRun: true,
        },
        timestamps: {},
    };
}

describe('resolveDiscussionReplyOutcome', () => {
    const reply = (outcome?: 'answer' | 'pass' | 'failed' | 'cancelled' | 'terminal_no_result') => ({
        producerV1: { v: 1 as const, kind: 'agent' as const, sessionId: 'checkout-ui',
            ...(outcome ? { replyReturn: { serverId: 'home', requestLocalId: 'ask-1', outcome } } : {}) },
    });

    it('reads how an addressed participant answered from the stamped return, and says nothing for other messages', () => {
        expect(resolveDiscussionReplyOutcome(reply('answer'))).toBe('answer');
        expect(resolveDiscussionReplyOutcome(reply('pass'))).toBe('pass');
        // Ending without a result is a failed answer to the person who asked, not a quiet pass.
        expect(resolveDiscussionReplyOutcome(reply('failed'))).toBe('failed');
        expect(resolveDiscussionReplyOutcome(reply('terminal_no_result'))).toBe('failed');
        expect(resolveDiscussionReplyOutcome(reply('cancelled'))).toBe('cancelled');
        // An agent posting on its own (no addressed question) and a person's message carry no outcome.
        expect(resolveDiscussionReplyOutcome(reply())).toBeNull();
        expect(resolveDiscussionReplyOutcome({ producerV1: null })).toBeNull();
    });
});

describe('buildDiscussionTimelineItems', () => {
    it('anchors linked runs after the highest selected message and orders equal anchors by canonical start then run id', () => {
        const entries = new Map([
            ['run-z', entry('run-z', 20)],
            ['run-b', entry('run-b', 10)],
            ['run-a', entry('run-a', 10)],
        ]);

        const items = buildDiscussionTimelineItems({
            serverId: 'home-1',
            discussionId: 'discussion-1',
            messages: [message('message-1', 1), message('message-2', 2), message('message-3', 3)],
            subagents: [
                run({ runId: 'run-z', messageIds: ['message-1', 'message-3'] }),
                run({ runId: 'run-b', messageIds: ['message-2'] }),
                run({ runId: 'run-a', messageIds: ['message-2'] }),
            ],
            readExecutionRunEntry: (runId) => entries.get(runId) ?? null,
        });

        expect(items.map((item) => {
            switch (item.kind) {
                case 'human_message': return `message:${item.message.id}`;
                case 'agent_activity_reference': return `run:${item.entry.runId}@${item.anchorSeq}`;
                case 'workflow_run': return `workflow:${item.run.id}`;
            }
        })).toEqual([
            'message:message-1',
            'message:message-2',
            'run:run-a@2',
            'run:run-b@2',
            'message:message-3',
            'run:run-z@3',
        ]);
    });

    it('ignores another Home with the same raw Discussion ID and unresolved or non-canonical run sources', () => {
        const validEntry = entry('run-valid', 10);
        const wrongKindEntry = { ...entry('run-not-execution', 11), kind: 'subagent' as const };
        const malformed = {
            ...run({ runId: 'run-malformed' }),
            runRef: {
                runId: 'run-malformed',
                launchOrigin: { kind: 'discussion', serverId: 'home-1' },
            },
        } as unknown as SessionSubagent;

        const entries = new Map<string, AgentActivityEntry>([
            ['run-valid', validEntry],
            ['run-not-execution', wrongKindEntry],
            ['run-cross-session', entry('run-cross-session', 12)],
            ['run-other-discussion', entry('run-other-discussion', 13)],
            ['run-unresolved', entry('run-unresolved', 14)],
            ['run-malformed', entry('run-malformed', 15)],
        ]);

        const items = buildDiscussionTimelineItems({
            serverId: 'home-1',
            discussionId: 'discussion-1',
            messages: [message('message-1', 1)],
            subagents: [
                run({ runId: 'run-valid' }),
                run({ runId: 'run-not-execution' }),
                run({ runId: 'run-cross-session', serverId: 'home-2' }),
                run({ runId: 'run-other-discussion', discussionId: 'discussion-2' }),
                run({ runId: 'run-unresolved', messageIds: ['missing-message'] }),
                malformed,
            ],
            readExecutionRunEntry: (runId) => entries.get(runId) ?? null,
        });

        expect(items).toHaveLength(2);
        expect(items[1]).toMatchObject({
            kind: 'agent_activity_reference',
            anchorSeq: 1,
            entry: { runId: 'run-valid' },
        });
    });

    it('places each managed Pattern run right after the exact message that started it, on this Discussion and Home only', () => {
        const items = buildDiscussionTimelineItems({
            serverId: 'home-1',
            discussionId: 'discussion-1',
            messages: [message('message-1', 1), message('message-2', 2), message('message-3', 3)],
            subagents: [],
            readExecutionRunEntry: () => null,
            workflowRuns: [
                workflowRun('wf-later', { messageId: 'message-2' }),
                workflowRun('wf-first', { messageId: 'message-1' }),
                workflowRun('wf-other-home', { messageId: 'message-1', serverId: 'home-2' }),
                workflowRun('wf-other-discussion', { messageId: 'message-1', discussionId: 'discussion-2' }),
                workflowRun('wf-unloaded', { messageId: 'message-0' }),
                { ...workflowRun('wf-no-origin', { messageId: 'message-1' }), origin: { kind: 'direct' as const } },
            ],
        });

        expect(items.map((item) => item.kind === 'human_message' ? item.message.id
            : item.kind === 'workflow_run' ? `run:${item.run.id}` : 'reference')).toEqual([
            'message-1', 'run:wf-first', 'message-2', 'run:wf-later', 'message-3',
        ]);
    });

    it('reads several runs one message started in the order they started, whatever order the list arrives in', () => {
        const at = (id: string, createdAt: string) => ({ ...workflowRun(id, { messageId: 'message-1' }), createdAt });
        const items = buildDiscussionTimelineItems({
            serverId: 'home-1',
            discussionId: 'discussion-1',
            messages: [message('message-1', 1), message('message-2', 2)],
            subagents: [],
            readExecutionRunEntry: () => null,
            // The Runs list arrives newest first; Run again starts a newer Run under the same message.
            workflowRuns: [
                at('wf-again-b', '2026-11-07T13:20:00.000Z'),
                at('wf-again-a', '2026-11-07T13:20:00.000Z'),
                at('wf-first', '2026-11-07T13:00:00.000Z'),
            ],
        });

        expect(items.map((item) => item.kind === 'human_message' ? item.message.id
            : item.kind === 'workflow_run' ? `run:${item.run.id}` : 'other')).toEqual([
            'message-1', 'run:wf-first', 'run:wf-again-a', 'run:wf-again-b', 'message-2',
        ]);
    });

    it('closes a finished run with one end row right after the last answer it published here', () => {
        const items = buildDiscussionTimelineItems({
            serverId: 'home-1',
            discussionId: 'discussion-1',
            messages: [message('message-1', 1), message('message-2', 2), message('message-3', 3), message('message-4', 4)],
            subagents: [],
            readExecutionRunEntry: () => null,
            workflowRuns: [
                { ...workflowRun('wf-done', { messageId: 'message-1' }), state: 'succeeded' as const },
                workflowRun('wf-live', { messageId: 'message-1' }),
                { ...workflowRun('wf-quiet', { messageId: 'message-1' }), state: 'cancelled' as const },
                { ...workflowRun('wf-next', { messageId: 'message-3' }), state: 'succeeded' as const },
            ],
            workflowRunAnswerIds: new Map([
                ['wf-done', ['message-3', 'message-2']],
                ['wf-live', ['message-2']],
                ['wf-next', ['message-4', 'message-unloaded']],
            ]),
        });

        expect(items.map((item) => item.kind === 'human_message' ? item.message.id
            : item.kind === 'workflow_run' ? `run:${item.run.id}${item.endRow ? ':ends-below' : ''}`
                : item.kind === 'workflow_run_end' ? `end:${item.run.id}` : 'reference')).toEqual([
            'message-1', 'run:wf-done:ends-below', 'run:wf-live', 'run:wf-quiet', 'message-2',
            // The end row closes the earlier run before the next run that message started.
            'message-3', 'end:wf-done', 'run:wf-next:ends-below', 'message-4', 'end:wf-next',
        ]);
    });

});

describe('placeDiscussionRequesterApprovals', () => {
    const persona = { serverId: 'home', sessionId: 'release-bot' };
    const ask = { id: 'ask', producerV1: null };
    const botReply = (id: string, requestRef: string, outcome?: 'answer' | 'pass') => ({ id, producerV1: {
        v: 1 as const, kind: 'agent' as const, sessionId: 'release-bot',
        ...(outcome ? { replyReturn: { serverId: 'home', requestLocalId: 'ask-1', outcome } } : {}),
        actionRequestAttributionV1: { requestRef, requester: { serverId: 'home', accountId: 'bob' }, persona, origin: null } } });
    const approval = { id: 'approval-1', requestRef: 'req-1', originMessageId: 'ask' };

    it('reads under the Bot reply that answered the same admitted ask', () => {
        const placed = placeDiscussionRequesterApprovals([ask, botReply('other', 'req-2'), botReply('reply', 'req-1', 'answer')], [approval]);
        expect([...placed.entries()]).toEqual([['reply', [approval]]]);
    });

    it('reads under the message that asked while the Bot has not replied, or replied with a one-line outcome', () => {
        expect([...placeDiscussionRequesterApprovals([ask], [approval]).entries()]).toEqual([['ask', [approval]]]);
        expect([...placeDiscussionRequesterApprovals([ask, botReply('passed', 'req-1', 'pass')], [approval]).entries()]).toEqual([['ask', [approval]]]);
    });

    it('places nothing whose message is not loaded in this thread', () => {
        expect(placeDiscussionRequesterApprovals([botReply('other', 'req-2')], [approval]).size).toBe(0);
    });
});

describe('Workflow-produced messages', () => {
    const workflow = (outcome: 'answer' | 'pass' | 'failed' | 'cancelled' | 'terminal_no_result') => ({
        id: 'workflow-reply',
        producerV1: { v: 1 as const, kind: 'workflow' as const, runId: 'run-1', invocationRecordId: 'invocation-1', invocationAttempt: '0',
            execution: { kind: 'action' as const, actionId: 'review.verdict' }, outcome },
    });
    const result = (value: unknown, summary = 'Ship it') => DiscussionMessageContentV1Schema.parse({ kind: 'workflow_result', value, summary,
        source: { runId: 'run-1', invocationRecordId: 'invocation-1', invocationAttempt: '0' } });

    it('reads an Agent-produced Workflow reply from committed Run provenance without changing its Agent outcome', () => {
        const producer = DiscussionProducerV1Schema.parse({ v: 1, kind: 'agent', sessionId: 'external-plugin-session', runId: 'run-1',
            replyReturn: { serverId: 'home', requestLocalId: 'ask-1', outcome: 'answer',
                workflow: { runId: 'run-1', invocationRecordId: 'invocation-1', invocationAttempt: '0' } } });
        expect(resolveDiscussionWorkflowAttribution({ producerV1: producer })).toEqual({ runId: 'run-1',
            invocationRecordId: 'invocation-1', outcome: 'answer' });
        expect(resolveDiscussionReplyOutcome({ producerV1: producer })).toBe('answer');
    });

    it.each([false, true])('does not attribute an ordinary execution-run Agent publication to a Workflow (reply return: %s)', (reply) => {
        const producer = DiscussionProducerV1Schema.parse({ v: 1, kind: 'agent', sessionId: 'external-plugin-session', runId: 'execution-run-1',
            ...(reply ? { replyReturn: { serverId: 'home', requestLocalId: 'ordinary-ask', outcome: 'answer' } } : {}) });
        expect(resolveDiscussionWorkflowAttribution({ producerV1: producer })).toBeNull();
        expect(resolveDiscussionReplyOutcome({ producerV1: producer })).toBe(reply ? 'answer' : null);
    });

    it.each(['execution-run-1', undefined])('uses the protected Workflow marker even when the generic runId is %s', (runId) => {
        const producer = DiscussionProducerV1Schema.parse({ v: 1, kind: 'agent', sessionId: 'external-plugin-session',
            ...(runId ? { runId } : {}), replyReturn: { serverId: 'home', requestLocalId: 'workflow-ask', outcome: 'cancelled',
                workflow: { runId: 'workflow-run-1', invocationRecordId: 'invocation-1', invocationAttempt: '0' } } });
        expect(resolveDiscussionWorkflowAttribution({ producerV1: producer })).toEqual({ runId: 'workflow-run-1',
            invocationRecordId: 'invocation-1', outcome: 'cancelled' });
        expect(resolveDiscussionReplyOutcome({ producerV1: producer })).toBe('cancelled');
    });

    it('is attributed to its exact Run with its own outcome, never as an Agent reply', () => {
        const invocation = { runId: 'run-1', invocationRecordId: 'invocation-1' };
        expect(resolveDiscussionWorkflowAttribution(workflow('answer'))).toEqual({ ...invocation, outcome: 'answer' });
        expect(resolveDiscussionWorkflowAttribution(workflow('terminal_no_result'))).toEqual({ ...invocation, outcome: 'failed' });
        expect(resolveDiscussionWorkflowAttribution(workflow('cancelled'))).toEqual({ ...invocation, outcome: 'cancelled' });
        // The Agent reply outcome reads only an Agent's stamped return.
        expect(resolveDiscussionReplyOutcome(workflow('failed'))).toBeNull();
        expect(resolveDiscussionWorkflowAttribution({ producerV1: null })).toBeNull();
        expect(resolveDiscussionWorkflowAttribution({ producerV1: { v: 1, kind: 'agent', sessionId: 'checkout-ui' } })).toBeNull();
    });

    it('names no requester and anchors no requester approval', () => {
        expect(resolveDiscussionReplyAttributionLine(workflow('answer'), { serverId: 'home', accountId: 'bob' })).toBeNull();
        const approval = { id: 'approval-1', requestRef: 'req-1', originMessageId: 'ask' };
        expect([...placeDiscussionRequesterApprovals([{ id: 'ask', producerV1: null }, workflow('answer')], [approval]).entries()])
            .toEqual([['ask', [approval]]]);
    });

    it('reads its summary as the message and keeps a typed value that says more as the result', () => {
        expect(readDiscussionMessagePreview(result({ verdict: 'ship' }))).toBe('Ship it');
        expect(readDiscussionWorkflowResultDetail(result({ verdict: 'ship', blockers: [] })))
            .toBe(JSON.stringify({ verdict: 'ship', blockers: [] }, null, 2));
        expect(readDiscussionWorkflowResultDetail(result('Ship it'))).toBeNull();
        expect(readDiscussionWorkflowResultDetail(result(3))).toBe('3');
        expect(readDiscussionWorkflowResultDetail({ v: 1, parts: [{ t: 'text', text: 'Ship it' }] })).toBeNull();
    });
});

describe('reply outcome presentation and speaker groups', () => {
    type Outcome = 'answer' | 'pass' | 'failed' | 'cancelled' | 'terminal_no_result';
    const body = (text: string) => DiscussionMessageContentV1Schema.parse({ v: 1, parts: [{ t: 'text', text }] });
    const agent = (outcome: Outcome | undefined, content: ReturnType<typeof body> | null = null) => ({
        authorAccountId: 'owner', content,
        producerV1: { v: 1 as const, kind: 'agent' as const, sessionId: 'checkout-ui',
            ...(outcome ? { replyReturn: { serverId: 'home', requestLocalId: 'ask-1', outcome } } : {}) },
    });
    const run = (outcome: Outcome, content: ReturnType<typeof body> | null = null) => ({
        authorAccountId: 'owner', content,
        producerV1: { v: 1 as const, kind: 'workflow' as const, runId: 'run-1', invocationRecordId: 'invocation-1', invocationAttempt: '0',
            execution: { kind: 'action' as const, actionId: 'review.verdict' }, outcome },
    });
    const partial = body('1. **Choose names** that describe intent.\n\n```ts\nconst activeUsers = users.filter(isActive);\n```');

    it('keeps a stopped reply that kept a partial answer as a message, marked stopped', () => {
        expect(resolveDiscussionReplyPresentation(agent('cancelled', partial))).toEqual({ kind: 'message', stopped: true });
        expect(resolveDiscussionReplyPresentation(run('cancelled', partial))).toEqual({ kind: 'message', stopped: true });
    });

    it('reads passed, failed and bodiless stopped outcomes as a compact notice', () => {
        expect(resolveDiscussionReplyPresentation(agent('pass'))).toEqual({ kind: 'notice', outcome: 'pass' });
        expect(resolveDiscussionReplyPresentation(agent('failed', body('Model unavailable')))).toEqual({ kind: 'notice', outcome: 'failed' });
        expect(resolveDiscussionReplyPresentation(agent('terminal_no_result'))).toEqual({ kind: 'notice', outcome: 'failed' });
        expect(resolveDiscussionReplyPresentation(agent('cancelled'))).toEqual({ kind: 'notice', outcome: 'cancelled' });
        expect(resolveDiscussionReplyPresentation(run('failed', body('Step 2 failed')))).toEqual({ kind: 'notice', outcome: 'failed' });
    });

    it('reads answers and ordinary messages as messages', () => {
        expect(resolveDiscussionReplyPresentation(agent('answer', body('Done')))).toEqual({ kind: 'message', stopped: false });
        expect(resolveDiscussionReplyPresentation(agent(undefined, body('FYI')))).toEqual({ kind: 'message', stopped: false });
        expect(resolveDiscussionReplyPresentation({ producerV1: null, content: body('Hi') })).toEqual({ kind: 'message', stopped: false });
    });

    it('starts its own speaker group for every reply with an outcome, even after the same speaker', () => {
        const person = { authorAccountId: 'owner', producerV1: null };
        expect(startsDiscussionMessageGroup(agent('cancelled', partial), person)).toBe(true);
        expect(startsDiscussionMessageGroup(agent('failed'), agent('answer', body('Earlier')))).toBe(true);
        expect(startsDiscussionMessageGroup(run('cancelled'), run('answer', body('Earlier')))).toBe(true);
        // Ordinary messages from one speaker still share a byline.
        expect(startsDiscussionMessageGroup(person, person)).toBe(false);
        expect(startsDiscussionMessageGroup(agent(undefined), agent(undefined))).toBe(false);
        expect(startsDiscussionMessageGroup(person, agent(undefined))).toBe(true);
        expect(startsDiscussionMessageGroup(person, undefined)).toBe(true);
    });
});

// CL-C: rounds use recorded invocation coordinates, never reply order or inferred agreement.
it.each(['workflow', 'agent'] as const)('groups a completed %s debate round around its digest and keeps the next round open', kind => {
    const producer = (invocationRecordId: string) => DiscussionProducerV1Schema.parse(kind === 'workflow'
        ? { v: 1, kind, runId: 'debate', invocationRecordId,
            invocationAttempt: '0', execution: { kind: 'action', actionId: 'review.verdict' }, outcome: 'answer' }
        : { v: 1, kind, sessionId: `session-${invocationRecordId}`, runId: 'ordinary-execution-run',
            replyReturn: { serverId: 'home-1', requestLocalId: `input-${invocationRecordId}`, outcome: 'answer',
                workflow: { runId: 'debate', invocationRecordId, invocationAttempt: '0' } } });
    const messages = [
        { ...message('ask', 1), producerV1: null },
        { ...message('first-answer', 2), producerV1: producer('reply-0') },
        { ...message('digest', 3), producerV1: producer('digest-0') },
        { ...message('second-answer', 4), producerV1: producer('reply-1') },
    ];
    const invocation = (id: string, blockId: string, index: number, result?: string) => ({
        index: { id, runId: 'debate', sequence: String(index), parentRecordId: null, memberOrdinal: '0', attempt: '0',
            contentRevision: '0', lifecycle: 'completed' as const, createdAt: '2026-11-07T10:00:00Z', updatedAt: '2026-11-07T10:00:00Z' },
        progress: { kind: 'happier.workflow-progress.v1' as const, logicalInvocationRecordId: id, invocationPath: { blockId,
            scope: [{ kind: 'iteration' as const, blockId: 'rounds', index }] }, blockKind: 'step' as const, attempt: '0', ...(result ? { result } : {}) },
        parentRevision: 1,
    });
    const facts = [invocation('reply-0', 'reply', 0), invocation('digest-0', 'default-digest', 0, 'Retain the dissent'),
        invocation('reply-1', 'reply', 1)];
    const rounds = projectDiscussionWorkflowRounds({ messages, run: workflowRun('debate', { messageId: 'ask' }), invocations: facts });
    expect(rounds).toMatchObject([
        { runId: 'debate', index: 0, digestMessageId: 'digest', finished: true, allPassed: false, messageIds: ['first-answer', 'digest'] },
        { runId: 'debate', index: 1, digestMessageId: null, finished: false, messageIds: ['second-answer'] },
    ]);
    const params = { serverId: 'home-1', discussionId: 'discussion-1', messages, subagents: [], readExecutionRunEntry: () => null,
        workflowRuns: [workflowRun('debate', { messageId: 'ask' })], workflowRounds: rounds };
    const items = buildDiscussionTimelineItems(params);
    expect(items.map(item => item.kind)).toEqual(['human_message', 'workflow_run', 'workflow_round', 'workflow_round']);
    expect(items.filter(item => item.kind === 'workflow_round').map(item => item.rows.map(row => row.message.id)))
        .toEqual([['first-answer', 'digest'], ['second-answer']]);
    expect(buildDiscussionTimelineItems(params, items)).toBe(items);
    const interleaved = buildDiscussionTimelineItems({ ...params, messages: [messages[0]!, messages[1]!,
        { ...message('interruption', 2.5), producerV1: null }, messages[2]!, messages[3]!] });
    expect(interleaved.flatMap(item => item.kind === 'human_message' ? [item.message.id]
        : item.kind === 'workflow_round' ? item.rows.map(row => row.message.id) : []))
        .toEqual(['ask', 'first-answer', 'interruption', 'digest', 'second-answer']);
    expect(projectDiscussionWorkflowRounds({ messages, run: { ...workflowRun('debate', { messageId: 'ask' }), state: 'failed' }, invocations: facts })[1]?.finished).toBe(false);
    const participant = (sessionId: string) => ({ kind: 'session' as const, session: { serverId: 'home-1', sessionId } });
    const outcomes = (index: number, allPassed: boolean) => ({
        ...invocation(`outcomes-${index}`, 'outcomes', index),
        progress: { ...invocation(`outcomes-${index}`, 'outcomes', index).progress,
            result: { allPassed, hasNext: !allPassed, nextParticipants: allPassed ? [] : [participant('remaining-speaker')],
                outcomeReferences: [{ runId: 'debate', invocationRecordId: `reply-${index}`,
                    participant: participant(index === 0 ? 'passed-speaker' : 'remaining-speaker'), kind: 'pass' as const }] } },
    });
    const withOutcomes = projectDiscussionWorkflowRounds({ messages, run: workflowRun('debate', { messageId: 'ask' }),
        invocations: [...facts, outcomes(0, false), outcomes(1, true)] });
    expect(withOutcomes[1]).toMatchObject({ allPassed: true, finished: true, sitOut: ['passed-speaker'] });
    const withoutEndDecision = projectDiscussionWorkflowRounds({ messages, run: workflowRun('debate', { messageId: 'ask' }),
        invocations: [...facts, outcomes(0, false), outcomes(1, false)] });
    expect(withoutEndDecision[1]?.allPassed).toBe(false);
    // A partially loaded or ordinary Workflow never guesses the round from the message position.
    expect(projectDiscussionWorkflowRounds({ messages, run: workflowRun('debate', { messageId: 'ask' }), invocations: [] })).toEqual([]);
});

 it('places each unanswered addressed participant after the question and removes only its stamped return', () => {
    const question = { id: 'question', seq: 1, addressingV1: { throughSeq: 1,
        participantSessionIds: ['reviewer', 'watcher', 'offline'], watcherSessionIds: ['watcher'] },
        participantDeliveryV1: [{ participantSessionId: 'offline', disposition: 'held' as const, code: 'session_input_target_unavailable' as const }] };
    const base = { serverId: 'home', discussionId: 'discussion', subagents: [], readExecutionRunEntry: () => null };
    const first = buildDiscussionTimelineItems({ ...base, messages: [question] });
    expect(first.map(item => item.kind)).toEqual(['human_message', 'participant_reply', 'participant_reply']);
    expect(first.slice(1)).toMatchObject([{ message: question, sessionId: 'reviewer' },
        { message: question, sessionId: 'offline', delivery: question.participantDeliveryV1[0] }]);
    expect(buildDiscussionTimelineItems({ ...base, messages: [question] }, first)).toBe(first);
    const unrelated = { id: 'unrelated', seq: 2, replyTarget: { kind: 'message' as const, messageId: question.id },
        producerV1: DiscussionProducerV1Schema.parse({ v: 1, kind: 'agent', sessionId: 'reviewer' }) };
    const next = buildDiscussionTimelineItems({ ...base, messages: [question, unrelated] }, first);
    expect(next[1]).toBe(first[1]);
    const returned = { ...unrelated, producerV1: DiscussionProducerV1Schema.parse({ v: 1, kind: 'agent', sessionId: 'reviewer',
        replyReturn: { serverId: 'home', requestLocalId: 'request', outcome: 'pass' } }) };
    const final = buildDiscussionTimelineItems({ ...base, messages: [question, returned] }, next);
    expect(final.map(item => item.kind)).toEqual(['human_message', 'participant_reply', 'human_message']);
    expect(final[1]).toBe(first[2]);
 });
