import { describe, expect, it } from 'vitest';
import { captureDocPassageV1, prepareDocEditBodyV1 } from '../artifacts/artifactPassageV1.js';
import { createActionExecutor, type ActionExecutorDeps, type ActionExecutorContext } from './actionExecutor.js';
import { ApprovalRequestV2Schema, type ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { decideApprovalRequestTransition } from '../approvals/approvalRequestTransition.js';
import { DocEditAcceptHostInputV1Schema, DocEditDecisionResultV1Schema } from '../artifacts/artifactCollaborationActionsV1.js';
import { ArtifactDocumentV1Schema } from '../artifacts/artifactActionsV1.js';
import { getActionSpec } from './actionSpecs.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import { isAgentInitiatedApprovalRequiredByDefault } from './actionApprovalPolicy.js';
import { actionInputValidationFailure } from './executor/actionInputValidation.js';
import { DISCUSSION_ACTION_INPUT_SCHEMAS_V1, DiscussionPostResultV1Schema, DiscussionOpenedSummaryV1Schema,
  type DiscussionOpenedSummaryV1 } from '../discussions/actions.js';

const ref = { kind: 'doc' as const, artifactId: 'doc', serverId: 'home' };
const revision = { headerVersion: 2, bodyVersion: 3 };
const artifact = ArtifactDocumentV1Schema.parse({ artifactId: 'doc', ownerAccountId: 'owner', access: 'view',
  header: { title: 'Shared notes', kind: 'markdown' }, body: '# Notes\n\nRead this.', revision,
  publicAudience: 'none', seq: 1, createdAt: 1, updatedAt: 1 });
const context = { surface: 'agent', authority: 'account_automation', serverId: 'home', expectedAccountId: 'reader' } as const;
const discussionRef = { serverId: 'home', discussionId: 'thread' };
const proposalRef = { kind: 'discussion' as const, discussion: discussionRef, messageId: 'candidate' };
const target = { ref, revision, range: { start: 9, end: 18 }, quote: 'Read this' };
const proposal = { target, discussionRef, localId: 'propose-retry', baseRevision: revision,
  before: target.quote, after: 'Read that', reason: 'Clarify the instruction' };
const decisionInputs = {
  'doc.edit.accept': { proposalRef, expectedRevision: revision },
  'doc.edit.decline': { proposalRef },
} as const;

function fixture(value: unknown = { artifact }) {
  // Opened authenticated Artifact transport is the boundary; catalog, admission and schemas stay real.
  const artifactAction: NonNullable<ActionExecutorDeps['artifactAction']> = async () => value;
  return createActionExecutor({ artifactAction });
}

const person = { ...context, surface: 'ui' as const, authority: 'present_user' as const };
const text = { v: 1 as const, parts: [{ t: 'text' as const, text: 'Please clarify' }] };
const rootMessage = {
  id: 'root', discussionId: 'thread', localId: 'root-local', seq: 1,
  authorAccountId: 'reader', accountActor: { v: 1, accountId: 'reader', profile: null }, producerV1: null,
  content: { kind: 'doc_passage_comment', passage: target, content: text },
  replyTarget: { kind: 'doc_passage', doc: { ref, revision } }, mentionedAccountIds: [], createdAt: 1,
  messageRef: { kind: 'discussion', discussion: discussionRef, messageId: 'root' },
};

function discussionFixture() {
  // The opened Home transport is the boundary; C3 semantic/result schemas stay real.
  const writes: unknown[] = [];
  const discussionAction: NonNullable<ActionExecutorDeps['discussionAction']> = async ({ actionId, input }) => {
    const request = DISCUSSION_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
    if (actionId === 'discussion.read') {
      const read = DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.read'].parse(request);
      const older = read.messageId === rootMessage.id;
      return { v: 1, serverId: 'home', discussionId: 'thread',
        messages: older ? [rootMessage] : [{ ...rootMessage, id: 'later', seq: 2,
          messageRef: { ...rootMessage.messageRef, messageId: 'later' } }],
        messageSeq: 2, hasMoreOlder: !older, incomplete: false };
    }
    if (actionId !== 'discussion.post' && actionId !== 'discussion.reply') throw new Error('Unexpected transport request');
    const post = DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.post'].parse(request);
    writes.push(post);
    return DiscussionPostResultV1Schema.parse({ v: 1, serverId: 'home', messageSeq: 2,
      message: { ...rootMessage, id: 'saved', localId: post.localId, seq: 2, content: post.content,
        replyTarget: post.replyTarget, messageRef: { ...rootMessage.messageRef, messageId: 'saved' } } });
  };
  return { executor: createActionExecutor({ discussionAction }), writes };
}

function countSummary(id: string, changes: Partial<DiscussionOpenedSummaryV1> = {}) {
  return DiscussionOpenedSummaryV1Schema.parse({ id, ownerAccountId: 'reader', encryptionMode: 'plain',
    anchor: { kind: 'doc', doc: { ref: { ...ref, serverId: 'creator-cli-only-profile' }, revision } },
    access: 'view', keyReadiness: true, dataEncryptionKey: null, creationLocalId: null, title: 'Passage thread',
    openCommentCount: 1,
    latestMessage: { id: `${id}-latest`, localId: null, seq: 2, authorAccountId: 'reader',
      accountActor: rootMessage.accountActor, producerV1: null, createdAt: 1 },
    messageSeq: 2, lastReadSeq: 2, unreadCount: 0, unreadMentionCount: 0, recentAuthorAccountIds: ['reader'], archivedAt: null,
    firstMessage: countRoot(id),
    capabilities: { postMessages: false, rename: false, archive: false, restore: false, askAgent: false,
      sendToSession: false, manageAccess: false, leave: true }, ...changes });
}

function countRoot(discussionId: string) {
  return { ...rootMessage, id: `${discussionId}-root`, discussionId, messageRef: { ...rootMessage.messageRef, messageId: `${discussionId}-root`,
    discussion: { ...discussionRef, discussionId } } };
}

it.each(['captured', 'legacy'] as const)('proposes and applies whole sentences for a mid-clause %s selection', async basis => {
  const sentence = 'This spring we will keep prices steady for regulars while the new oven pays for itself.';
  const source = `Earlier plans.\n\n${sentence}\n\nNext steps.`;
  const selected = 'keep prices steady for regulars';
  const start = source.indexOf(selected);
  const captured = captureDocPassageV1({ ref, revision, source, range: { start, end: start + selected.length } });
  const { prefix: _prefix, suffix: _suffix, ...legacy } = captured;
  const passage = basis === 'legacy' ? legacy : captured;
  const after = 'This spring we will keep prices steady for our regulars while the new oven gradually pays for itself.';
  const executor = createActionExecutor({
    // Authenticated opened-resource transport is the boundary; all proposal and apply logic is real.
    artifactAction: async () => ({ artifact: { ...artifact, body: source } }),
    discussionAction: async ({ actionId, input }) => {
      if (actionId === 'discussion.list') return { v: 1, serverId: 'home', discussions: [], nextCursor: null };
      if (actionId === 'discussion.read') return { v: 1, serverId: 'home', discussionId: 'thread', messageSeq: 1,
        hasMoreOlder: false, incomplete: false, messages: [{ ...rootMessage, content: { ...rootMessage.content, passage } }] };
      const post = DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.post'].parse(input);
      return DiscussionPostResultV1Schema.parse({ v: 1, serverId: 'home', messageSeq: 2,
        message: { ...rootMessage, id: 'candidate', messageRef: proposalRef, seq: 2, localId: post.localId, content: post.content } });
    },
  });
  const result = await executor.execute('doc.edit.propose', { discussionRef, localId: 'whole-sentence', after }, person);
  expect(result).toMatchObject({ ok: true, result: { message: { content: { kind: 'doc_edit_proposal',
    proposal: { before: sentence, after, target: { quote: sentence } } } } } });
  if (!result.ok) throw new Error('Expected a published suggestion');
  const content = DiscussionPostResultV1Schema.parse(result.result).message.content;
  if (!content || !('kind' in content) || content.kind !== 'doc_edit_proposal') throw new Error('Expected a Doc suggestion');
  expect(prepareDocEditBodyV1({ ref, revision, source, proposal: content.proposal })).toBe(`Earlier plans.\n\n${after}\n\nNext steps.`);
  expect(passage.quote).toBe(selected);
  expect(() => prepareDocEditBodyV1({ ref, revision: { ...revision, bodyVersion: 99 }, source, proposal: content.proposal })).toThrow('version_mismatch');
  expect(() => prepareDocEditBodyV1({ ref, revision, source: source.replace('regulars', 'visitors'), proposal: content.proposal })).toThrow('doc_passage_mismatch');
});

describe('Doc collaboration Actions', () => {
  it.each(['same-paragraph', 'accepted-undo', 'selection-changed', 'ambiguous-selection'] as const)(
    'resolves redo from the retained selection in the current paragraph (%s)', async scenario => {
      const sentence = 'Alex can join the early shift, which ends by two.';
      const source = `# Plans\n\n${sentence}\n\nOther work.`;
      const selected = 'can join the early shift';
      const start = source.indexOf(selected);
      const passage = captureDocPassageV1({ ref, revision, source, range: { start, end: start + selected.length } });
      const currentRevision = { ...revision, bodyVersion: revision.bodyVersion + 2 };
      const currentSentence = scenario === 'accepted-undo' ? sentence
        : scenario === 'selection-changed' ? sentence.replace(selected, 'will work late').replace('two', 'three')
          : scenario === 'ambiguous-selection' ? `${sentence.replace('two', 'three')} Alex ${selected} too.`
            : sentence.replace('two', 'three');
      const currentSource = source.replace(sentence, currentSentence);
      const root = { ...rootMessage, content: { ...rootMessage.content, passage } };
      const accepted = { ...rootMessage, id: 'accepted', seq: 2,
        messageRef: { ...rootMessage.messageRef, messageId: 'accepted' },
        content: { kind: 'doc_edit_proposal', proposal: {
          target: { ref, revision, range: { start: source.indexOf(sentence), end: source.indexOf(sentence) + sentence.length }, quote: sentence },
          baseRevision: revision, before: sentence, after: 'Alex is welcome on the morning team.', reason: '' } },
        docEditProposalDispositionV1: { state: 'accepted', acceptedRevision: { ...revision, bodyVersion: revision.bodyVersion + 1 },
          decidedBy: { accountId: 'reader', atMs: 2 } } };
      let published = 0;
      const after = currentSentence.replace(selected, 'is welcome to join the early shift');
      const executor = createActionExecutor({
        // Authenticated opened-resource transports are the boundaries; resolution, publication and apply stay real.
        artifactAction: async () => ({ artifact: { ...artifact, body: currentSource, revision: currentRevision } }),
        discussionAction: async ({ actionId, input }) => {
          if (actionId === 'discussion.list') return { v: 1, serverId: 'home', discussions: [], nextCursor: null };
          if (actionId === 'discussion.read') return { v: 1, serverId: 'home', discussionId: 'thread', messageSeq: 2,
            hasMoreOlder: false, incomplete: false, messages: scenario === 'accepted-undo' ? [root, accepted] : [root] };
          const post = DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.post'].parse(input);
          published++;
          return DiscussionPostResultV1Schema.parse({ v: 1, serverId: 'home', messageSeq: 3,
            message: { ...rootMessage, id: 'candidate', seq: 3, localId: post.localId, content: post.content,
              replyTarget: post.replyTarget, messageRef: proposalRef } });
        },
      });
      const result = await executor.execute('doc.edit.propose', { discussionRef, localId: 'redo', after }, person);
      if (scenario === 'selection-changed' || scenario === 'ambiguous-selection') {
        expect(result).toMatchObject({ ok: false, errorCode: 'doc_passage_mismatch' });
        expect(published).toBe(0);
        return;
      }
      expect(result).toMatchObject({ ok: true, result: { message: { content: { kind: 'doc_edit_proposal',
        proposal: { before: currentSentence, after, baseRevision: currentRevision } } } } });
      if (!result.ok) throw new Error('Expected a redo suggestion');
      const content = DiscussionPostResultV1Schema.parse(result.result).message.content;
      if (!content || !('kind' in content) || content.kind !== 'doc_edit_proposal') throw new Error('Expected a Doc suggestion');
      expect(prepareDocEditBodyV1({ ref, revision: currentRevision, source: currentSource, proposal: content.proposal }))
        .toBe(currentSource.replace(currentSentence, after));
      expect(() => prepareDocEditBodyV1({ ref, revision: { ...currentRevision, bodyVersion: currentRevision.bodyVersion + 1 },
        source: currentSource, proposal: content.proposal })).toThrow('version_mismatch');
    });

  it.each(['direct', 'explicit-approval'] as const)('resolves a thread-addressed proposal before review and preserves that basis on replay (%s)', async path => {
    let stored: ApprovalRequest | undefined;
    let reads = 0;
    const writes: unknown[] = [];
    const storedTarget = { ...target, prefix: 'Notes\n\n', suffix: '.',
      ref: { ...ref, serverId: 'creator-cli-only-profile' } };
    const executor = createActionExecutor({
      // Opened authenticated Discussion HTTP and approval Artifact storage are the boundaries.
      artifactAction: async () => ({ artifact }),
      discussionAction: async ({ actionId, input }) => {
        if (actionId === 'discussion.read') {
          reads++;
          expect(input).toEqual({ discussionId: 'thread' });
          return { v: 1, serverId: 'home', discussionId: 'thread', messageSeq: 2, hasMoreOlder: false, incomplete: false,
            messages: [{ ...rootMessage, content: { ...rootMessage.content, passage: storedTarget } }] };
        }
        if (actionId !== 'discussion.post') throw new Error('Unexpected Discussion operation');
        const post = DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.post'].parse(input);
        writes.push(post);
        return DiscussionPostResultV1Schema.parse({ v: 1, serverId: 'home', messageSeq: 2,
          message: { ...rootMessage, id: 'candidate', messageRef: proposalRef, localId: post.localId,
            content: post.content, replyTarget: post.replyTarget } });
      },
      approvalsCreate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(request); return { artifactId: 'thread-proposal' }; },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(request); return { ok: true }; },
      isApprovalExecutionOriginCurrent: async () => true,
      sessionSendMessage: async ({ localId }) => ({ status: 'accepted', localId }),
    });
    const authored = { discussionRef, localId: proposal.localId, after: proposal.after };
    const invocation: ActionExecutorContext = { ...context, defaultSessionId: 'receiver', defaultSessionMachineId: 'machine',
      runtimeAccountId: 'reader', serverIdentityId: 'srv_home', actionRequestId: 'thread-proposal-request',
      actionCaller: { kind: 'session', sessionId: 'receiver', starterDepth: 0, turnDepth: 0 } };
    const result = path === 'direct' ? await executor.execute('doc.edit.propose', authored, invocation)
      : await executor.execute('approval.request.create', { actionId: 'doc.edit.propose', actionArgs: authored,
        summary: 'Propose a document edit', createdBy: { surface: 'agent' } }, invocation);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: path === 'direct'
      ? { kind: 'approval_request_created' } : { artifactId: 'thread-proposal' } });
    expect(stored?.actionArgs).toEqual({ discussionRef, localId: proposal.localId,
      target: { ...target, ref, range: { start: 9, end: 19 }, quote: 'Read this.', prefix: '', suffix: '' }, baseRevision: revision, before: 'Read this.', after: proposal.after, reason: '' });
    expect(writes).toEqual([]);
    expect(reads).toBe(1);
    const decision = await executor.execute('approval.request.decide', { artifactId: 'thread-proposal', decision: 'approve' },
      { ...person, runtimeAccountId: 'reader', serverIdentityId: 'srv_home', actionCaller: { kind: 'host' } });
    expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true });
    expect(writes).toEqual([{ discussionId: 'thread', localId: proposal.localId,
      content: { kind: 'doc_edit_proposal', proposal: { target: { ...target, ref, range: { start: 9, end: 19 }, quote: 'Read this.', prefix: '', suffix: '' }, baseRevision: revision,
        before: 'Read this.', after: proposal.after, reason: '' } }, replyTarget: rootMessage.replyTarget }]);
    expect(reads).toBe(1);
    expect(stored?.status).toBe('executed');
  });

  it.each(['accepted', 'accepted-paged', 'unchanged-passage', 'reattached', 'reattached-paged', 'missing-passage', 'ambiguous-passage'] as const)(
    'bases a later thread proposal on the current Doc after an accepted edit (%s)', async scenario => {
      const current = { ...revision, bodyVersion: revision.bodyVersion + 1 };
      const acceptedText = scenario === 'accepted' || scenario === 'accepted-paged' ? 'Read the revised instruction' : proposal.after;
      const body = scenario === 'unchanged-passage' ? '# Updated notes\n\nRead this.'
        : scenario === 'ambiguous-passage' ? 'Read this / Read this'
          : scenario === 'missing-passage' ? '# Notes\n\nDifferent words.' : `# Notes\n\n${acceptedText}.`;
      const reattached = scenario === 'reattached' || scenario === 'reattached-paged';
      const fresh = { ...target, revision: current, quote: acceptedText, range: { start: 9, end: 9 + acceptedText.length } };
      const accepted = { ...rootMessage, id: 'accepted', seq: 3,
        messageRef: { ...rootMessage.messageRef, messageId: 'accepted' },
        content: { kind: 'doc_edit_proposal', proposal: { target, baseRevision: revision,
          before: target.quote, after: acceptedText, reason: proposal.reason } },
        docEditProposalDispositionV1: { state: 'accepted', acceptedRevision: current,
          decidedBy: { accountId: 'reader', atMs: 2 } } };
      const messages = [rootMessage, ...(scenario === 'unchanged-passage' ? [] : [accepted]), ...(reattached ? [{ ...rootMessage,
        id: 'reattached', seq: 2, messageRef: { ...rootMessage.messageRef, messageId: 'reattached' },
        content: { ...rootMessage.content, passage: fresh }, replyTarget: { kind: 'doc_passage', doc: { ref, revision: current } } }] : [])];
      const writes: unknown[] = [];
      const pageCursors: Array<number | undefined> = [];
      const executor = createActionExecutor({
        // Opened authenticated Artifact and Discussion transports are the system boundaries.
        artifactAction: async () => ({ artifact: { ...artifact, body, revision: current } }),
        discussionAction: async ({ actionId, input }) => {
          if (actionId === 'discussion.list') return { v: 1, serverId: 'home', discussions: [], nextCursor: null, incomplete: false };
          if (actionId === 'discussion.read') {
            const read = DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.read'].parse(input);
            pageCursors.push(read.beforeSeq);
            const firstPage = (scenario === 'reattached-paged' || scenario === 'accepted-paged') && read.beforeSeq === undefined;
            return { v: 1, serverId: 'home', discussionId: 'thread',
              messages: firstPage ? [accepted] : messages.filter(message => read.beforeSeq === undefined || message.seq < read.beforeSeq),
              messageSeq: 3, hasMoreOlder: firstPage, incomplete: false };
          }
          const post = DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.post'].parse(input);
          writes.push(post);
          return DiscussionPostResultV1Schema.parse({ v: 1, serverId: 'home', messageSeq: 4,
            message: { ...rootMessage, id: 'fresh-proposal', seq: 4, localId: post.localId,
              content: post.content, replyTarget: post.replyTarget,
              messageRef: { ...rootMessage.messageRef, messageId: 'fresh-proposal' } } });
        },
      });
      const result = await executor.execute('doc.edit.propose', { discussionRef, localId: 'next', after: 'Read again' }, person);
      if (scenario === 'missing-passage' || scenario === 'ambiguous-passage') {
        expect(result).toMatchObject({ ok: false, errorCode: 'doc_passage_mismatch' });
        expect(writes).toEqual([]);
      } else {
        const quote = (scenario === 'unchanged-passage' ? target.quote : fresh.quote) + '.';
        expect(result).toMatchObject({ ok: true, result: { message: { content: { kind: 'doc_edit_proposal',
          proposal: { target: { ref, revision: current, quote,
            range: { start: body.indexOf(quote), end: body.indexOf(quote) + quote.length } },
          baseRevision: current, before: quote } } } } });
      }
      expect(pageCursors).toEqual(scenario === 'reattached-paged' || scenario === 'accepted-paged' ? [undefined, 3] : [undefined]);
    });

  it.each(['unavailable', 'not-a-passage', 'foreign-home'] as const)(
    'does not create a proposal from a %s thread anchor', async problem => {
      let writes = 0;
      const executor = createActionExecutor({ discussionAction: async ({ actionId }) => {
        if (actionId !== 'discussion.read') { writes++; throw new Error('Must not publish'); }
        return { v: 1, serverId: problem === 'foreign-home' ? 'other' : 'home', discussionId: 'thread',
          messageSeq: 2, hasMoreOlder: false, incomplete: problem === 'unavailable',
          messages: [{ ...rootMessage, ...(problem === 'unavailable' ? { content: null }
            : problem === 'not-a-passage' ? { content: text, replyTarget: undefined } : {}) }] };
      } });
      expect(await executor.execute('doc.edit.propose', { discussionRef, localId: 'compact', after: proposal.after },
        { ...context, bypassApprovals: true })).toMatchObject({ ok: false, errorCode:
          problem === 'unavailable' ? 'content_unavailable' : problem === 'foreign-home' ? 'invalid_action_output' : 'doc_passage_mismatch' });
      expect(writes).toBe(0);
    });

  it('refuses API initial invitations before publication while admitting present-user invitations and ordinary agent comments', async () => {
    const publications: unknown[] = [];
    const executor = createActionExecutor({ discussionAction: async ({ actionId, input }) => {
      if (actionId !== 'discussion.create') throw new Error('Expected the canonical initial Discussion owner');
      const request = DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.create'].parse(input);
      publications.push(request);
      return { v: 1, serverId: 'home', discussion: countSummary('thread'), firstMessage: { ...rootMessage,
        localId: request.firstMessage.localId, content: request.firstMessage.content } };
    } });
    const ordinary = { target, localId: 'initial-comment', content: text };
    const inviting = { ...ordinary, participants: [{ kind: 'session', sessionId: 'reviewer' }] };
    expect(await executor.execute('doc.comment.reply', inviting, { ...context, surface: 'api', bypassApprovals: true }))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(publications).toEqual([]);
    expect(await executor.execute('doc.comment.reply', inviting, person)).toMatchObject({ ok: true });
    expect(publications[0]).toMatchObject({ participants: inviting.participants });
    expect(await executor.execute('doc.comment.reply', ordinary, { ...context, bypassApprovals: true })).toMatchObject({ ok: true });
    expect(publications[1]).not.toHaveProperty('participants');
  });

  it('sums active readable Doc root counts once across every list page, excluding archived, locked and source-withheld roots', async () => {
    let empty = false;
    const cursors: Array<string | undefined> = [];
    const oldRevision = { headerVersion: 1, bodyVersion: 1 };
    const first = countSummary('first', { openCommentCount: 3 });
    const second = countSummary('settled', { anchor: { kind: 'doc', doc: { ref, revision: oldRevision } },
      firstMessage: { ...countRoot('settled'),
        content: { kind: 'doc_edit_proposal', proposal: { target: { ...target, revision: oldRevision }, baseRevision: oldRevision,
          before: target.quote, after: 'Already reviewed', reason: 'Clarify' } },
        replyTarget: { kind: 'doc_passage', doc: { ref, revision: oldRevision } },
        docEditProposalDispositionV1: { state: 'declined', decidedBy: { accountId: 'reader', atMs: 3 } } } });
    const executor = createActionExecutor({
      artifactAction: async () => ({ artifact }),
      // Opened, authenticated C3 HTTP responses are the boundary; count, paging and source checks stay real.
      discussionAction: async ({ actionId, input }) => {
        if (actionId !== 'discussion.list') throw new Error('Count must use one existing batch page, not per-thread reads or writes');
        const args = DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.list'].parse(input);
        expect(args).toMatchObject({ state: 'active', anchorDocArtifactId: 'doc' });
        cursors.push(args.cursor);
        if (empty) return { v: 1, serverId: 'home', discussions: [], nextCursor: null, incomplete: false };
        const discussions = args.cursor === 'last' ? [first, second] : args.cursor === 'middle'
          ? [countSummary('other-doc', { anchor: { kind: 'doc', doc: { ref: { ...ref, artifactId: 'other' }, revision } } })]
          : [first, countSummary('archived', { archivedAt: 1 }),
            countSummary('locked', { keyReadiness: false, firstMessage: null }), countSummary('denied', { firstMessage: null })];
        return { v: 1, serverId: 'home', discussions, nextCursor: args.cursor === 'last' ? null
          : args.cursor === 'middle' ? 'last' : 'middle', incomplete: true };
      },
    });
    expect(await executor.execute('doc.read', { ref }, context)).toMatchObject({ ok: true, result: { artifact, openCommentCount: 4 } });
    expect(cursors).toEqual([undefined, 'middle', 'last']);
    empty = true;
    expect(await executor.execute('doc.read', { ref }, context)).toMatchObject({ ok: true, result: { openCommentCount: 0 } });
    expect(cursors).toEqual([undefined, 'middle', 'last', undefined]);
  });

  it.each(['later-list-failure', 'invalid-page', 'repeated-cursor', 'foreign-home', 'missing-root-fact', 'missing-count-fact', 'zero-count-fact',
    'unopenable-root', 'later-ordinary-row', 'wrong-root'] as const)(
    'returns an explicitly unavailable count, never a partial total, after %s', async problem => {
      const executor = createActionExecutor({ artifactAction: async () => ({ artifact }),
        discussionAction: async ({ actionId, input }) => {
          if (actionId !== 'discussion.list') throw new Error('Unexpected count operation');
          const args = DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.list'].parse(input);
          if (args.cursor && problem === 'later-list-failure') return { ok: false, errorCode: 'outcome_unknown', error: 'network' };
          if (problem === 'invalid-page') return { discussions: [] };
          const summary = countSummary('first');
          const { firstMessage: _firstMessage, ...missing } = summary;
          const root = countRoot('first');
          const candidate = problem === 'missing-root-fact' ? missing
            : problem === 'missing-count-fact' ? { ...summary, openCommentCount: null }
              : problem === 'zero-count-fact' ? { ...summary, openCommentCount: 0 }
            : problem === 'unopenable-root' ? { ...summary, firstMessage: { ...root, content: null } }
              : problem === 'later-ordinary-row' ? { ...summary, firstMessage: { ...root, seq: 2, content: text, replyTarget: undefined } }
                : problem === 'wrong-root' ? { ...summary, firstMessage: { ...root, discussionId: 'different-thread',
                  messageRef: { ...root.messageRef, discussion: { ...discussionRef, discussionId: 'different-thread' } } } } : summary;
          return { v: 1, serverId: problem === 'foreign-home' ? 'foreign' : 'home', discussions: [candidate],
            nextCursor: problem === 'repeated-cursor' || problem === 'later-list-failure' ? 'next' : null, incomplete: false };
        } });
      expect(await executor.execute('doc.read', { ref }, context)).toMatchObject({ ok: true, result: { artifact, openCommentCount: null } });
    });

  it('propagates cancellation during comment enumeration and rejects a foreign Doc before either read owner', async () => {
    const controller = new AbortController();
    const operations: string[] = [];
    const executor = createActionExecutor({ artifactAction: async () => { operations.push('artifact'); return { artifact }; },
      discussionAction: async ({ actionId }) => { operations.push(actionId); controller.abort();
        return { v: 1, serverId: 'home', discussions: [], nextCursor: null, incomplete: false }; } });
    expect(await executor.execute('doc.read', { ref: { ...ref, serverId: 'foreign' } }, context))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(operations).toEqual([]);
    expect(await executor.execute('doc.read', { ref }, { ...context, signal: controller.signal })).toMatchObject({ ok: false });
    expect(operations).toEqual(['artifact', 'discussion.list']);
  });
  it('uses established Home equivalence for reads, parent replies and prepared decisions without admitting a foreign Home', async () => {
    const portableHome = 'srv_doc_home';
    const proposalRefOnPortableHome = { ...proposalRef, discussion: { ...discussionRef, serverId: portableHome } };
    const accepted = { state: 'accepted', acceptedRevision: { ...revision, bodyVersion: 4 }, decidedBy: { accountId: 'editor', atMs: 5 } } as const;
    const decisions: unknown[] = [];
    const writes: unknown[] = [];
    const executor = createActionExecutor({
      resolveServerProfileScopeId: identifier => identifier === 'home' || identifier === portableHome ? portableHome : identifier,
      // Authenticated opened Artifact/Discussion transports are the boundaries, not Home identity or preparation logic.
      artifactAction: async request => {
        if (request.actionId === 'artifact.get') return { artifact: { ...artifact, access: 'edit' } };
        decisions.push(request);
        return { proposalRef, docEditProposalDispositionV1: accepted };
      },
      discussionAction: async request => {
        if (request.actionId === 'discussion.read') {
          const isProposal = DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.read'].parse(request.input).messageId === proposalRef.messageId;
          return { v: 1, serverId: 'home', discussionId: 'thread', messageSeq: 2, hasMoreOlder: isProposal, incomplete: false,
            messages: [isProposal ? { ...rootMessage, id: 'candidate', seq: 2, messageRef: proposalRef,
              content: { kind: 'doc_edit_proposal', proposal: { target: { ...target,
                ref: { ...ref, serverId: 'creator-cli-only-profile' } }, baseRevision: revision, before: target.quote,
                after: proposal.after, reason: proposal.reason } }, replyTarget: { kind: 'doc_passage', doc: {
                  ref: { ...ref, serverId: 'creator-cli-only-profile' }, revision,
                } }, docEditProposalDispositionV1: { state: 'open' } } : { ...rootMessage,
                  content: { ...rootMessage.content, passage: { ...target, ref: { ...ref, serverId: 'creator-cli-only-profile' } } },
                  replyTarget: { kind: 'doc_passage', doc: { ref: { ...ref, serverId: 'creator-cli-only-profile' }, revision } },
                }] };
        }
        const posted = DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.reply'].parse(request.input);
        writes.push(posted);
        return { v: 1, serverId: 'home', messageSeq: 3, message: { ...rootMessage, id: 'alias-reply', seq: 3,
          localId: posted.localId, content: posted.content, replyTarget: posted.replyTarget,
          messageRef: { ...rootMessage.messageRef, messageId: 'alias-reply' } } };
      },
    });
    const onPortableHome = { ...person, serverId: portableHome, serverIdentityId: portableHome };
    expect(await executor.execute('doc.read', { ref }, onPortableHome)).toMatchObject({ ok: true });
    expect(await executor.execute('doc.comment.reply', { target, localId: 'alias-reply', content: text,
      parentMessageRef: rootMessage.messageRef }, onPortableHome)).toMatchObject({ ok: true });
    expect(writes).toHaveLength(1);
    const acceptedResult = await executor.execute('doc.edit.accept', { proposalRef: proposalRefOnPortableHome, expectedRevision: revision }, onPortableHome);
    expect(acceptedResult, JSON.stringify(acceptedResult)).toMatchObject({ ok: true, result: { docEditProposalDispositionV1: accepted } });
    expect(decisions[0]).toMatchObject({ input: { proposalRef: proposalRefOnPortableHome,
      preparation: { doc: { ref: { ...ref, serverId: portableHome } }, body: '# Notes\n\nRead that.' } } });
    expect(await executor.execute('doc.edit.decline', { proposalRef: { ...proposalRef,
      discussion: { ...discussionRef, serverId: 'foreign-home' } } }, onPortableHome))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(decisions).toHaveLength(1);
  });
  it('prepares acceptance from the exact stored proposal and current Doc, rejoins settled decisions, and declines without a body', async () => {
    const accepted = { state: 'accepted', acceptedRevision: { ...revision, bodyVersion: 4 }, decidedBy: { accountId: 'editor', atMs: 5 } } as const;
    const declined = { state: 'declined', decidedBy: { accountId: 'editor', atMs: 6 } } as const;
    let disposition: unknown = { state: 'open' };
    const decisions: unknown[] = [];
    let recipientWrites = 0;
    const executor = createActionExecutor({
      // Opened C3/Artifact transport and the host codec/decision endpoint are genuine boundaries.
      discussionAction: async () => ({ v: 1, serverId: 'home', discussionId: 'thread', messageSeq: 1,
        messages: [{ ...rootMessage, id: 'candidate', messageRef: proposalRef,
          content: { kind: 'doc_edit_proposal', proposal: { target, baseRevision: revision,
            before: target.quote, after: proposal.after, reason: proposal.reason } }, docEditProposalDispositionV1: disposition }],
        hasMoreOlder: false, incomplete: false }),
      artifactAction: async (request) => {
        if (request.actionId === 'artifact.get') {
          // Ordinary host reads may prepare envelopes; decision preparation is read-only.
          if (!('readOnly' in request) || request.readOnly !== true) recipientWrites += 1;
          return { artifact: { ...artifact, access: 'edit' } };
        }
        decisions.push(request);
        if (typeof disposition === 'object' && disposition !== null && 'state' in disposition && disposition.state === 'open') {
          disposition = request.actionId === 'doc.edit.accept' ? accepted : declined;
        }
        return { proposalRef, docEditProposalDispositionV1: disposition };
      },
    });
    expect(await executor.execute('doc.edit.accept', decisionInputs['doc.edit.accept'], person))
      .toMatchObject({ ok: true, result: { proposalRef, docEditProposalDispositionV1: accepted } });
    expect(decisions[0]).toMatchObject({ actionId: 'doc.edit.accept', input: { ...decisionInputs['doc.edit.accept'],
      preparation: { doc: { ref, revision }, body: '# Notes\n\nRead that.' } } });
    expect(recipientWrites).toBe(0);
    expect(await executor.execute('doc.edit.accept', decisionInputs['doc.edit.accept'], person)).toMatchObject({ ok: true });
    expect(decisions[1]).toMatchObject({ actionId: 'doc.edit.accept', input: decisionInputs['doc.edit.accept'] });
    expect(decisions[1]).not.toHaveProperty('input.preparation');
    expect(await executor.execute('doc.edit.decline', decisionInputs['doc.edit.decline'], person))
      .toMatchObject({ ok: true, result: { docEditProposalDispositionV1: accepted } });
    expect(decisions[2]).toMatchObject({ actionId: 'doc.edit.decline', input: decisionInputs['doc.edit.decline'] });
    expect(decisions[2]).not.toHaveProperty('input.preparation');
    disposition = { state: 'open' };
    expect(await executor.execute('doc.edit.decline', decisionInputs['doc.edit.decline'], person))
      .toMatchObject({ ok: true, result: { docEditProposalDispositionV1: declined } });
    const count = decisions.length;
    for (const actionId of ['doc.edit.accept', 'doc.edit.decline'] as const) {
      for (const executionContext of [{ ...context, bypassApprovals: true }, { ...context, actionsSettings: normalizeActionsSettingsV1({
        v: 1, approvalWaivedSurfaces: { [actionId]: ['agent'] },
      }) }]) {
        // A user waiver (or an approved bypass) runs the decision; there is no present-user floor.
        expect(await executor.execute(actionId, decisionInputs[actionId], executionContext))
          .not.toMatchObject({ ok: false, errorCode: 'present_user_required' });
      }
    }
    expect(decisions.length).toBeGreaterThan(count);
  });
  it('refuses stale full revisions, mismatched Doc identity and changed source quote before decision transport', async () => {
    const stored = { ...rootMessage, id: 'candidate', messageRef: proposalRef,
      content: { kind: 'doc_edit_proposal', proposal: { target, baseRevision: revision,
        before: target.quote, after: proposal.after, reason: proposal.reason } }, docEditProposalDispositionV1: { state: 'open' } };
    for (const [current, errorCode] of [
      [{ ...artifact, revision: { ...revision, headerVersion: 3 } }, 'version_mismatch'],
      [{ ...artifact, revision: { ...revision, bodyVersion: 4 } }, 'version_mismatch'],
      [{ ...artifact, artifactId: 'different' }, 'doc_target_mismatch'],
      [{ ...artifact, body: '# Notes\n\nDifferent.' }, 'doc_passage_mismatch'],
    ] as const) {
      let decisions = 0;
      const executor = createActionExecutor({
        discussionAction: async () => ({ v: 1, serverId: 'home', discussionId: 'thread', messages: [stored],
          messageSeq: 1, hasMoreOlder: false, incomplete: false }),
        artifactAction: async request => {
          if (request.actionId !== 'artifact.get') decisions += 1;
          return { artifact: current };
        },
      });
      expect(await executor.execute('doc.edit.accept', decisionInputs['doc.edit.accept'], person)).toMatchObject({ ok: false, errorCode });
      expect(decisions).toBe(0);
    }
    expect(DocEditAcceptHostInputV1Schema.safeParse({ ...decisionInputs['doc.edit.accept'], preparation: {
      doc: { ref, revision: { ...revision, headerVersion: 4 } }, body: 'unreviewed',
    } }).success).toBe(false);
    expect(DocEditDecisionResultV1Schema.safeParse({ proposalRef, docEditProposalDispositionV1: { state: 'open' } }).success).toBe(false);
  });
  it('replays an approved Agent decision only through actual present-person host authority', async () => {
    let stored: ApprovalRequest = ApprovalRequestV2Schema.parse({ v: 2, status: 'approved', createdAtMs: 1, updatedAtMs: 2,
      createdBy: { surface: 'agent', sessionId: 'receiver' }, requestedSurface: 'agent', actionId: 'doc.edit.decline',
      actionArgs: decisionInputs['doc.edit.decline'], summary: 'Review proposal', decision: { kind: 'approve', decidedAtMs: 2 },
      executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent',
        caller: { kind: 'session', sessionId: 'receiver', starterDepth: 0, turnDepth: 0 },
        sessionId: 'receiver', serverId: 'home', accountId: 'reader', machineId: 'machine', actionId: 'doc.edit.decline', requestId: 'decision' } });
    const effects: ActionExecutorContext[] = [];
    const executor = createActionExecutor({
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => {
        const next = ApprovalRequestV2Schema.parse(request);
        const transition = decideApprovalRequestTransition(stored, next);
        if (!transition.ok) return transition;
        stored = next;
        return { ok: true };
      },
      isApprovalExecutionOriginCurrent: async () => true,
      artifactAction: async request => {
        effects.push(request.context);
        return { proposalRef, docEditProposalDispositionV1: { state: 'declined', decidedBy: { accountId: 'reader', atMs: 3 } } };
      },
    });
    expect(await executor.replayApprovedApprovalRequest({ artifactId: 'human-decision', callerAuthority: 'account_automation' }))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(effects).toHaveLength(0);
    expect(await executor.execute('approval.request.decide', { artifactId: 'human-decision', decision: 'approve' },
      { ...person, runtimeAccountId: 'reader', actionCaller: { kind: 'host' }, defaultSessionId: 'reviewer-focused-session' }))
      .toMatchObject({ ok: true, result: { status: 'executed' } });
    // Host/person authority and the original request's Session default are separate facts.
    expect(effects).toEqual([expect.objectContaining({ authority: 'present_user', actionCaller: { kind: 'host' },
      defaultSessionId: 'receiver' })]);
  });
  it.each(['doc.comment.reply', 'doc.edit.propose'] as const)('retains the original Session and approved replay witness at the C3 publisher for %s', async actionId => {
    const actionArgs = actionId === 'doc.comment.reply' ? { target, discussionRef, localId: 'comment-retry', content: text } : proposal;
    let stored: ApprovalRequest = ApprovalRequestV2Schema.parse({ v: 2, status: 'approved', createdAtMs: 1, updatedAtMs: 2,
      createdBy: { surface: 'agent', sessionId: 'receiver' }, requestedSurface: 'agent', actionId, actionArgs, summary: 'Publish',
      decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user' },
      executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent',
        caller: { kind: 'session', sessionId: 'receiver', starterDepth: 0, turnDepth: 0 },
        sessionId: 'receiver', serverId: 'home', accountId: 'reader', machineId: 'machine', actionId, requestId: 'publication' } });
    const publications: ActionExecutorContext[] = [];
    const executor = createActionExecutor({
      // Approval Artifact persistence, live Session custody and opened C3 HTTP are genuine host boundaries.
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => {
        const next = ApprovalRequestV2Schema.parse(request);
        const transition = decideApprovalRequestTransition(stored, next);
        if (!transition.ok) return transition;
        stored = next;
        return { ok: true };
      },
      isApprovalExecutionOriginCurrent: async () => true,
      discussionAction: async ({ actionId: child, input, context: executionContext }) => {
        if (child !== 'discussion.post') throw new Error('Unexpected C3 publication');
        const post = DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.post'].parse(input);
        publications.push(executionContext);
        return DiscussionPostResultV1Schema.parse({ v: 1, serverId: 'home', messageSeq: 2,
          message: { ...rootMessage, localId: post.localId, content: post.content, replyTarget: post.replyTarget } });
      },
    });
    expect(await executor.replayApprovedApprovalRequest({ artifactId: 'approved-doc' })).toMatchObject({ ok: true });
    expect(publications).toEqual([expect.objectContaining({ authority: 'account_automation', surface: 'agent', defaultSessionId: 'receiver',
      actionCaller: { kind: 'session', sessionId: 'receiver', starterDepth: 0, turnDepth: 0 },
      approvedActionReplay: { artifactId: 'approved-doc', origin: { surface: 'agent', sessionId: 'receiver', accountId: 'reader',
        caller: { kind: 'session', sessionId: 'receiver', starterDepth: 0, turnDepth: 0 } } } })]);
    expect(stored.status).toBe('executed');
  });
  it('posts a qualified encrypted-content passage root through the existing C3 writer', async () => {
    const { executor, writes } = discussionFixture();
    expect(await executor.execute('doc.comment.reply', { discussionRef, target: { ...target,
      ref: { kind: 'doc', artifactId: 'doc' } }, localId: 'comment-retry', content: text }, person))
      .toMatchObject({ ok: true, result: { message: { content: rootMessage.content,
        replyTarget: rootMessage.replyTarget, messageRef: { messageId: 'saved' } } } });
    expect(writes).toEqual([{ discussionId: 'thread', localId: 'comment-retry', content: rootMessage.content,
      replyTarget: rootMessage.replyTarget }]);
  });

  it('re-attaches a thread as a new comment basis at the current revision in the same thread, without a parent or a relocated anchor', async () => {
    const { executor, writes } = discussionFixture();
    const current = { headerVersion: 2, bodyVersion: 5 };
    const fresh = { ref, revision: current, range: { start: 2, end: 8 }, quote: 'Reword' };
    expect(await executor.execute('doc.comment.reply', { discussionRef, target: fresh, localId: 'reattach-1', content: text }, person))
      .toMatchObject({ ok: true });
    expect(writes).toEqual([{ discussionId: 'thread', localId: 'reattach-1',
      content: { kind: 'doc_passage_comment', passage: fresh, content: text },
      replyTarget: { kind: 'doc_passage', doc: { ref, revision: current } } }]);
  });

  it('uses the committed root for replies and permits a new-revision redo proposal only on the same Doc', async () => {
    const { executor, writes } = discussionFixture();
    const parentMessageRef = rootMessage.messageRef;
    expect(await executor.execute('doc.comment.reply', { target, parentMessageRef, localId: 'reply-retry', content: text }, person))
      .toMatchObject({ ok: true, result: { message: { content: text, replyTarget: { kind: 'message', messageId: 'root' } } } });
    const nextRevision = { ...revision, bodyVersion: 4 };
    const redo = { ...proposal, target: { ...target, revision: nextRevision }, baseRevision: nextRevision,
      replyTo: parentMessageRef };
    expect(await executor.execute('doc.edit.propose', redo, person)).toMatchObject({ ok: true,
      result: { message: { content: { kind: 'doc_edit_proposal', proposal: {
        target: redo.target, baseRevision: nextRevision, before: redo.before, after: redo.after, reason: redo.reason,
      } }, replyTarget: { kind: 'message', messageId: 'root' } } } });
    expect(await executor.execute('doc.comment.reply', { target: { ...target, range: { start: 0, end: 9 } },
      parentMessageRef, localId: 'wrong-passage', content: text }, person))
      .toMatchObject({ ok: false, errorCode: 'doc_passage_mismatch' });
    expect(await executor.execute('doc.edit.propose', { ...redo, target: { ...redo.target, ref: { ...ref, artifactId: 'another' } } }, person))
      .toMatchObject({ ok: false, errorCode: 'doc_passage_mismatch' });
    expect(writes).toHaveLength(2);
  });

  it('publishes strict revision-qualified comment/proposal inputs without author-controlled decisions', () => {
    const comment = getActionSpec('doc.comment.reply');
    const propose = getActionSpec('doc.edit.propose');
    expect(comment.inputSchema.safeParse({ target, localId: 'comment-retry',
      content: { v: 1, parts: [{ t: 'text', text: 'Please clarify' }] } }).success).toBe(true);
    expect(propose.inputSchema.safeParse(proposal).success).toBe(true);
    expect(propose.inputSchema.safeParse({ ...proposal, baseRevision: { ...revision, headerVersion: 1 } }).success).toBe(false);
    expect(propose.inputSchema.safeParse({ ...proposal, before: 'Different passage' }).success).toBe(false);
    expect(propose.inputSchema.safeParse({ ...proposal, decidedBy: { accountId: 'forged', atMs: 1 } }).success).toBe(false);
    expect(getActionSpec('doc.edit.accept').inputSchema.safeParse({
      ...decisionInputs['doc.edit.accept'], body: 'Unreviewed replacement',
    }).success).toBe(false);
    expect(getActionSpec('doc.edit.decline').inputSchema.safeParse({
      ...decisionInputs['doc.edit.decline'], authority: 'present_user',
    }).success).toBe(false);
    for (const id of ['doc.comment.reply', 'doc.edit.propose', 'doc.edit.accept', 'doc.edit.decline'] as const) {
      expect(isAgentInitiatedApprovalRequiredByDefault(id), id).toBe(true);
      expect(getActionSpec(id).surfaces).toMatchObject({ ui: true, agent: true, mcp: true, cli: true, plugin: true });
    }
  });

  it('rejects cross-Home passage and thread operands while leaving an omitted passage Home for execution scope', () => {
    const comment = getActionSpec('doc.comment.reply').inputSchema;
    const propose = getActionSpec('doc.edit.propose').inputSchema;
    const commentInput = { target, discussionRef, localId: 'comment-retry',
      content: { v: 1, parts: [{ t: 'text', text: 'Please clarify' }] } };
    const foreignTarget = { ...target, ref: { ...ref, serverId: 'other' } };
    expect(comment.safeParse({ ...commentInput, target: foreignTarget }).success).toBe(false);
    const { discussionRef: _discussionRef, ...withoutDiscussion } = commentInput;
    expect(comment.safeParse({ ...withoutDiscussion, target: foreignTarget, parentMessageRef: proposalRef }).success).toBe(false);
    expect(propose.safeParse({ ...proposal, target: foreignTarget }).success).toBe(false);
    const unqualifiedTarget = { ...target, ref: { kind: 'doc', artifactId: 'doc' } };
    expect(comment.safeParse({ ...commentInput, target: unqualifiedTarget }).success).toBe(true);
    expect(propose.safeParse({ ...proposal, target: unqualifiedTarget }).success).toBe(true);
  });

  it('returns unsupported when the safe codec/transaction host producer is absent', async () => {
    const executor = createActionExecutor({});
    const person = { ...context, surface: 'ui' as const, authority: 'present_user' as const };
    for (const actionId of ['doc.edit.accept', 'doc.edit.decline'] as const) {
      expect(await executor.execute(actionId, decisionInputs[actionId], person))
        .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    }
    expect(await executor.execute('doc.comment.reply', { target, localId: 'comment-retry',
      content: { v: 1, parts: [{ t: 'text', text: 'Please clarify' }] } }, person))
      .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    expect(await executor.execute('doc.edit.propose', proposal, person))
      .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
  });

  it('reads canonical text and full revision through the existing authenticated Artifact reader', async () => {
    const executor = fixture();
    expect(await executor.execute('doc.read', { ref }, context)).toMatchObject({ ok: true,
      result: { ref, artifact, openCommentCount: null } });
    expect(await executor.execute('doc.read', { ref: { kind: 'doc', artifactId: 'doc' }, revision }, context))
      .toMatchObject({ ok: true, result: { ref, artifact } });
  });

  it('keeps the failing Doc operand path in refusals from validation and the Artifact reader', async () => {
    const parsed = getActionSpec('doc.read').inputSchema.safeParse({ ref: { kind: 'doc' } });
    if (parsed.success) throw new Error('Missing document identity must fail input admission');
    const refusal = actionInputValidationFailure(parsed.error);
    const malformed = await fixture().execute('doc.read', { ref: { kind: 'doc' } }, context);
    const forwarded = await fixture(refusal).execute('doc.read', { ref }, context);
    for (const failure of [malformed, forwarded]) {
      expect(failure).toMatchObject({ ok: false, errorCode: 'invalid_parameters', details: {
        issues: [expect.objectContaining({ path: ['ref', 'artifactId'], code: 'invalid_type' })],
      } });
    }
    expect(forwarded).toEqual(refusal);
  });

  it('fails closed for a different Home, unavailable source, or either changed revision component', async () => {
    expect(await fixture().execute('doc.read', { ref: { ...ref, serverId: 'other' } }, context))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(await fixture({ artifact: null }).execute('doc.read', { ref }, context))
      .toMatchObject({ ok: false, errorCode: 'not_found' });
    for (const expected of [{ ...revision, headerVersion: 1 }, { ...revision, bodyVersion: 2 }]) {
      expect(await fixture().execute('doc.read', { ref, revision: expected }, context))
        .toMatchObject({ ok: false, errorCode: 'version_mismatch' });
    }
    expect(await fixture({ ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' })
      .execute('doc.read', { ref }, context)).toMatchObject({ ok: false, errorCode: 'content_unavailable' });
  });

  it('does not expose structured Memory, HTML, or internal content through a prose reader', async () => {
    for (const kind of ['memory_doc.v1', 'prompt_doc.v2', 'html', 'approval_request.v1']) {
      expect(await fixture({ artifact: { ...artifact, header: { ...artifact.header, kind } } })
        .execute('doc.read', { ref }, context)).toMatchObject({ ok: false, errorCode: 'doc_kind_not_prose' });
    }
  });
});
