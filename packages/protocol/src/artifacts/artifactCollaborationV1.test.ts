import { describe, expect, it } from 'vitest';
import { DocEditProposalV1Schema, DocPassageRefV1Schema } from './artifactCollaborationV1.js';
import { DocCommentReplyInputV1Schema, prepareDocDiscussionMutationV1 } from './artifactCollaborationActionsV1.js';
import { DOC_COLLABORATION_ACTION_SPECS_V1 } from '../actions/specs/docCollaboration.js';
import { requiresPresentUserExecutionAuthorityForActionInputV1, resolveCredentialActionAdmissionV1 } from '../actions/decisionAuthority.js';
import { isAgentInitiatedApprovalRequiredByDefault } from '../actions/actionApprovalPolicy.js';

const passage = {
  ref: { kind: 'doc' as const, artifactId: 'doc-1', serverId: 'home-1' },
  revision: { headerVersion: 2, bodyVersion: 3 },
  range: { start: 8, end: 13 },
  quote: 'again',
};

describe('Doc collaboration authored content', () => {
  it('classifies initial invitations as present-user sharing while preserving ordinary comments and agent Ask', () => {
    const spec = DOC_COLLABORATION_ACTION_SPECS_V1.find(spec => spec.id === 'doc.comment.reply')!;
    const ordinary = { target: passage, localId: 'comment', content: { v: 1, parts: [{ t: 'text', text: 'Review' }] } };
    const inviting = { ...ordinary, participants: [{ kind: 'session', sessionId: 'reviewer' }] };
    expect(requiresPresentUserExecutionAuthorityForActionInputV1(spec, inviting)).toBe(true);
    expect(requiresPresentUserExecutionAuthorityForActionInputV1(spec, ordinary)).toBe(false);
    expect(resolveCredentialActionAdmissionV1({ spec, authority: 'account_automation', grant: null,
      surface: 'api', hasExternalCredential: true, actionInput: inviting })).toEqual({ ok: false, errorCode: 'present_user_required' });
    expect(resolveCredentialActionAdmissionV1({ spec, authority: 'account_automation', grant: null,
      surface: 'api', hasExternalCredential: true, actionInput: ordinary })).toEqual({ ok: true });
    expect(resolveCredentialActionAdmissionV1({ spec, authority: 'present_user', grant: null,
      surface: 'ui', actionInput: inviting })).toEqual({ ok: true });
    expect(isAgentInitiatedApprovalRequiredByDefault('doc.comment.reply')).toBe(true);
  });

  it('retains explicit initial Session invitations only when creating a passage Discussion', () => {
    const input = { target: passage, localId: 'initial-comment', content: { v: 1, parts: [{ t: 'text', text: 'Review' }] },
      participants: [{ kind: 'session', sessionId: 'selected-session' }] };
    const parsed = DocCommentReplyInputV1Schema.parse(input);
    expect(prepareDocDiscussionMutationV1('doc.comment.reply', parsed, 'home-1'))
      .toMatchObject({ actionId: 'discussion.create', input: { participants: input.participants,
        anchor: { kind: 'doc', doc: { ref: passage.ref, revision: passage.revision } },
        firstMessage: { localId: input.localId, content: { kind: 'doc_passage_comment', passage } } } });
    const discussion = { serverId: 'home-1', discussionId: 'thread' };
    expect(DocCommentReplyInputV1Schema.safeParse({ ...input, discussionRef: discussion }).success).toBe(false);
    expect(DocCommentReplyInputV1Schema.safeParse({ ...input,
      parentMessageRef: { kind: 'discussion', discussion, messageId: 'root' } }).success).toBe(false);
    expect(DocCommentReplyInputV1Schema.safeParse({ ...input, participants: [], discussionRef: discussion }).success).toBe(true);
  });

  it('retains the exact source occurrence and full revision without treating context as authority', () => {
    expect(DocPassageRefV1Schema.parse({ ...passage, prefix: 'again / ', suffix: '!' }))
      .toEqual({ ...passage, prefix: 'again / ', suffix: '!' });
    expect(DocPassageRefV1Schema.safeParse({ ...passage, range: { start: 13, end: 8 } }).success).toBe(false);
    expect(DocPassageRefV1Schema.safeParse({ ...passage, quote: 'different' }).success).toBe(false);
    expect(DocPassageRefV1Schema.safeParse({ ...passage, ref: { ...passage.ref, accountId: 'forged' } }).success).toBe(false);
    expect(DocPassageRefV1Schema.safeParse({ ...passage, range: { ...passage.range, unit: 'dom' } }).success).toBe(false);
  });

  it('admits replacement or deletion only on the exact quoted revision basis', () => {
    const proposal = { target: passage, baseRevision: passage.revision, before: 'again', after: '', reason: 'Remove repetition' };
    expect(DocEditProposalV1Schema.parse(proposal)).toEqual(proposal);
    expect(DocEditProposalV1Schema.safeParse({ ...proposal, baseRevision: { headerVersion: 3, bodyVersion: 3 } }).success).toBe(false);
    expect(DocEditProposalV1Schema.safeParse({ ...proposal, before: 'other' }).success).toBe(false);
    expect(DocEditProposalV1Schema.safeParse({ ...proposal, decidedBy: { accountId: 'forged', atMs: 1 } }).success).toBe(false);
  });

  it('counts UTF-16 code units rather than Unicode code points', () => {
    expect(DocPassageRefV1Schema.safeParse({ ...passage, range: { start: 0, end: 2 }, quote: '😀' }).success).toBe(true);
    expect(DocPassageRefV1Schema.safeParse({ ...passage, range: { start: 0, end: 1 }, quote: '😀' }).success).toBe(false);
  });
});
