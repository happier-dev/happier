import { describe, expect, it } from 'vitest';

import { DiscussionPostInputV1Schema } from '../discussions/actions.js';
import { describeApprovalActionFields } from './actionApprovalPresentation.js';
import { getActionSpec } from './actionSpecs.js';

describe('Discussion message approval', () => {
  it.each(['discussion.post', 'discussion.reply'] as const)('keeps %s routing and retry identities out of the readable draft', actionId => {
    const actionArgs = getActionSpec(actionId).inputSchema.parse({
      discussionId: 'cmw71uacn00bvmc5wlr1nwuze',
      localId: 'reply-v1:6DQIvaaGNqcJyOWw0fhsFp6LGIgJzKWzohMKKgZIkDU',
      replyTarget: { kind: 'message', messageId: 'cmw71uagq00bxmc5wo1hqg2xb' },
      content: { v: 1, parts: [{ t: 'text', text: 'Run two practice mornings before opening.' }] },
    });
    const presentation = describeApprovalActionFields({ actionId, actionArgs });
    expect(presentation.unrepresentable).toBeNull();
    const visible = presentation.rows.filter(row => row.kind !== 'value' || !row.technical);
    expect(JSON.stringify(visible)).toContain('Run two practice mornings before opening.');
    for (const identity of ['cmw71uacn00bvmc5wlr1nwuze', 'reply-v1:6DQIvaaGNqcJyOWw0fhsFp6LGIgJzKWzohMKKgZIkDU', 'cmw71uagq00bxmc5wo1hqg2xb']) {
      expect(JSON.stringify(visible)).not.toContain(identity);
    }
  });

  it('shows the proposed before/after and reason without passage routing or retry identities', () => {
    const actionArgs = getActionSpec('doc.edit.propose').inputSchema.parse({
      target: { ref: { kind: 'doc', artifactId: 'doc-1', serverId: 'home-1' },
        revision: { headerVersion: 1, bodyVersion: 1 }, range: { start: 0, end: 3 }, quote: 'Old' },
      baseRevision: { headerVersion: 1, bodyVersion: 1 }, before: 'Old', after: 'New', reason: 'Clarify the wording',
      discussionRef: { serverId: 'home-1', discussionId: 'discussion-1' },
      replyTo: { kind: 'discussion', discussion: { serverId: 'home-1', discussionId: 'discussion-1' }, messageId: 'message-1' },
      localId: 'proposal-retry-1',
    });
    const presentation = describeApprovalActionFields({ actionId: 'doc.edit.propose', actionArgs });
    expect(presentation.unrepresentable).toBeNull();
    const visible = presentation.rows.filter(row => row.kind !== 'value' || !row.technical);
    for (const value of ['Old', 'New', 'Clarify the wording']) expect(JSON.stringify(visible)).toContain(value);
    for (const identity of ['doc-1', 'home-1', 'discussion-1', 'message-1', 'proposal-retry-1']) {
      expect(JSON.stringify(visible)).not.toContain(identity);
    }
  });

  it('reads an inbound message and its outside sender and conversation without routing or document structure', () => {
    const actionArgs = DiscussionPostInputV1Schema.parse({
      discussionId: 'discussion-1', localId: 'channels:9:binding-1:delivery-1',
      content: { v: 1, parts: [{ t: 'text', text: 'Can you check the invoice?' }],
        externalSource: { kind: 'channel', providerPluginId: 'happier.channel.email',
          conversationDisplayName: 'Acme billing', senderDisplayName: 'Jordan from Acme',
          inputLocalId: 'channels:9:binding-1:original-delivery' } },
    });
    const presentation = describeApprovalActionFields({ actionId: 'discussion.post', actionArgs });
    expect(presentation.unrepresentable).toBeNull();
    const visible = presentation.rows.filter(row => row.kind !== 'value' || !row.technical);
    expect(visible).toEqual([
      { kind: 'value', path: 'content.externalSource.senderDisplayName', title: 'From', value: 'Jordan from Acme' },
      { kind: 'value', path: 'content.externalSource.conversationDisplayName', title: 'Conversation', value: 'Acme billing' },
      { kind: 'value', path: 'content.parts.[].text', title: 'Message', value: 'Can you check the invoice?' },
    ]);
    expect(JSON.stringify(visible)).not.toContain('binding-1');
    expect(JSON.stringify(visible)).not.toContain('happier.channel.email');
    expect(presentation.rows).toContainEqual(expect.objectContaining({ path: 'discussionId', technical: true }));
  });

  it('keeps ordinary authored text and document proposals reviewable', () => {
    for (const content of [
      { v: 1, parts: [{ t: 'text', text: 'The invoice is ready.' }] },
      { kind: 'doc_edit_proposal', proposal: {
        target: { ref: { kind: 'doc', artifactId: 'doc-1', serverId: 'home-1' },
          revision: { headerVersion: 1, bodyVersion: 1 }, range: { start: 0, end: 3 }, quote: 'Old' },
        baseRevision: { headerVersion: 1, bodyVersion: 1 }, before: 'Old', after: 'New', reason: 'Clarify the wording',
      } },
    ]) {
      const actionArgs = DiscussionPostInputV1Schema.parse({ discussionId: 'discussion-1', content });
      const presentation = describeApprovalActionFields({ actionId: 'discussion.post', actionArgs });
      expect(presentation.unrepresentable).toBeNull();
      const visible = presentation.rows.filter(row => row.kind !== 'value' || !row.technical);
      expect(JSON.stringify(visible)).toContain('parts' in content ? 'The invoice is ready.' : 'Clarify the wording');
      expect(visible.some(row => row.path === 'discussionId')).toBe(false);
    }
  });

  it('retains attachments and mentioned people beside an inbound message', () => {
    const blobId = '762847e4-14cb-45c2-9e3a-06db902a417a';
    const actionArgs = DiscussionPostInputV1Schema.parse({ discussionId: 'discussion-1',
      content: { v: 1, externalSource: { kind: 'channel', providerPluginId: 'happier.channel.email',
        conversationDisplayName: 'Acme billing', senderDisplayName: 'Jordan from Acme' }, parts: [
        { t: 'text', text: 'Please review ' },
        { t: 'mention', participant: { kind: 'account', accountId: 'person-1' } },
        { t: 'attachment', attachment: { kind: 'file', id: blobId, name: 'invoice.pdf',
          file: { blobId, mime: 'application/pdf', sizeBytes: 3, sha256: 'a'.repeat(64) } } },
      ] },
    });
    const presentation = describeApprovalActionFields({ actionId: 'discussion.post', actionArgs });
    expect(presentation.unrepresentable).toBeNull();
    const visible = presentation.rows.filter(row => row.kind !== 'value' || !row.technical);
    expect(visible).toContainEqual(expect.objectContaining({ path: 'content.parts.[].text', value: 'Please review' }));
    expect(JSON.stringify(visible)).toContain('invoice.pdf');
    expect(JSON.stringify(visible)).toContain('person-1');
    expect(JSON.stringify(visible)).not.toContain('"label":"T"');
  });
});
