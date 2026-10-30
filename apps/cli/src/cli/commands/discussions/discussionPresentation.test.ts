import { describe, expect, it } from 'vitest';

import type { DiscussionOpenedMessageV1 } from '@happier-dev/protocol';

import { buildDiscussionMentionLabels, formatDiscussionMessageForHuman } from './discussionPresentation';

function message(overrides: Partial<DiscussionOpenedMessageV1> = {}): DiscussionOpenedMessageV1 {
  return {
    id: 'message-1',
    discussionId: 'discussion-1',
    messageRef: { kind: 'discussion', discussion: { serverId: 'server-1', discussionId: 'discussion-1' }, messageId: 'message-1' },
    localId: null,
    seq: 1,
    authorAccountId: 'private-account-id',
    accountActor: {
      v: 1,
      accountId: 'private-account-id',
      profile: { firstName: 'Alice', lastName: 'Chen', username: null, avatarUrl: null, name: null },
    },
    producerV1: null,
    content: { v: 1, parts: [{ t: 'text', text: 'Ready' }] },
    mentionedAccountIds: [],
    createdAt: 1,
    ...overrides,
  };
}

describe('Discussion human presentation', () => {
  it('presents files and empty folders without treating them as participant mentions', () => {
    expect(formatDiscussionMessageForHuman(message({ content: { v: 1, parts: [
      { t: 'attachment', attachment: { kind: 'file', id: '7578de54-3f59-4d6d-8293-ff6e4682fd10', name: 'notes.txt', file: {
        blobId: '7578de54-3f59-4d6d-8293-ff6e4682fd10', mime: 'text/plain', sizeBytes: 0, sha256: 'a'.repeat(64),
      } } },
      { t: 'attachment', attachment: { kind: 'folder', id: '7578de54-3f59-4d6d-8293-ff6e4682fd11', name: 'project', entries: [], directories: [] } },
    ] } }))).toBe('1. Alice Chen: [File: notes.txt][Folder: project]');
  });
  it('renders opened passage comments and proposal text through the existing transcript formatter', () => {
    const revision = { headerVersion: 1, bodyVersion: 2 };
    const passage = { ref: { kind: 'doc' as const, artifactId: 'doc', serverId: 'home' }, revision,
      range: { start: 0, end: 3 }, quote: 'old' };
    expect(formatDiscussionMessageForHuman(message({ content: {
      kind: 'doc_passage_comment', passage, content: { v: 1, parts: [
        { t: 'text', text: 'Please check ' }, { t: 'mention', participant: { kind: 'account', accountId: 'private-mentioned' } },
      ] },
    } }))).toBe('1. Alice Chen: Please check @Happier member');
    expect(formatDiscussionMessageForHuman(message({ content: { kind: 'doc_edit_proposal', proposal: {
      target: passage, baseRevision: revision, before: 'old', after: 'new', reason: 'clarify',
    } } }))).toBe('1. Alice Chen: old\nnew\nclarify');
  });
  it('renders the sanitized Account actor and Agent provenance as sibling facts', () => {
    const output = formatDiscussionMessageForHuman(message({
      producerV1: { v: 1, kind: 'agent', sessionId: 'session-1', runId: 'run-1' },
    }));

    expect(output).toBe('1. Alice Chen · Via Agent: Ready');
    expect(output).not.toContain('private-account-id');
  });

  it('uses the approved deleted-Account fallback without exposing the raw id', () => {
    const output = formatDiscussionMessageForHuman(message({
      accountActor: { v: 1, accountId: 'private-account-id', accessibility: 'former',
        profile: { name: 'Retained name', firstName: null, lastName: null, username: null, avatarUrl: null } },
    }));

    expect(output).toBe('1. Former member: Ready');
    expect(output).not.toContain('private-account-id');
  });

  it('renders an explicitly unavailable author without inventing a profile identity', () => {
    const output = formatDiscussionMessageForHuman(message({
      authorAccountId: null,
      accountActor: null,
    }));

    expect(output).toBe('1. Unknown author: Ready');
    expect(output).not.toContain('private-account-id');
  });

  it('names two mentioned collaborators apart using the actors this page already carries', () => {
    const page = [
      message({ id: 'message-1', seq: 1, authorAccountId: 'account-a', accountActor: {
        v: 1,
        accountId: 'account-a',
        profile: { firstName: 'Alice', lastName: 'Chen', username: null, avatarUrl: null, name: null },
      } }),
      message({ id: 'message-2', seq: 2, authorAccountId: 'account-b', accountActor: {
        v: 1,
        accountId: 'account-b',
        profile: { firstName: null, lastName: null, username: 'bo', avatarUrl: null, name: null },
      } }),
      message({
        id: 'message-3',
        seq: 3,
        content: { v: 1, parts: [
          { t: 'mention', participant: { kind: 'account', accountId: 'account-a' } },
          { t: 'text', text: ' and ' },
          { t: 'mention', participant: { kind: 'account', accountId: 'account-b' } },
        ] },
        mentionedAccountIds: ['account-a', 'account-b'],
      }),
    ];
    const labels = buildDiscussionMentionLabels(page);

    const output = formatDiscussionMessageForHuman(page[2]!, labels);

    expect(output).toBe('3. Alice Chen: @Alice Chen and @bo');
    expect(output).not.toContain('account-a');
    expect(output).not.toContain('account-b');
  });

  it('summarizes structured mentions without printing their Account ids', () => {
    const output = formatDiscussionMessageForHuman(message({
      content: {
        v: 1,
        parts: [
          { t: 'text', text: 'Please check ' },
          { t: 'mention', participant: { kind: 'account', accountId: 'private-mentioned-account-id' } },
        ],
      },
      mentionedAccountIds: ['private-mentioned-account-id'],
    }));

    expect(output).toBe('1. Alice Chen: Please check @Happier member');
    expect(output).not.toContain('private-mentioned-account-id');
  });

  it('keeps actual Session mentions distinct without exposing their private ids', () => {
    const output = formatDiscussionMessageForHuman(message({ content: { v: 1, parts: [
      { t: 'mention', participant: { kind: 'session', sessionId: 'private-agent-session' } },
    ] } }));
    expect(output).toBe('1. Alice Chen: @Happier Agent');
    expect(output).not.toContain('private-agent-session');
  });
});
