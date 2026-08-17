import { describe, expect, it } from 'vitest';

import { MENTION_BOUNDS } from './mentionRefV1.js';
import {
  buildComposerReferenceMentionPayloadV1,
  readComposerReferenceMentionV1,
  renderComposerReferenceContextBlockV1,
} from './composerReferenceProviderV1.js';

const REFERENCE = { pluginId: 'acme.issues', localId: 'issues' } as const;

describe('composer reference persisted identity', () => {
  it('writes only the qualified reference, opaque candidate id, and advisory label into the incumbent mention element', () => {
    const payload = buildComposerReferenceMentionPayloadV1({
      reference: REFERENCE,
      candidate: { id: 'issue:42', label: 'Issue 42', description: 'Current sprint issue' },
    });

    expect(payload).toEqual({
      kind: 'happier.composerReference',
      ref: 'composerReference:issue:42',
      composerReference: REFERENCE,
      label: 'Issue 42',
    });
    expect(readComposerReferenceMentionV1({
      ...payload,
      token: '@issue-42',
    })).toEqual({
      reference: REFERENCE,
      candidateId: 'issue:42',
      label: 'Issue 42',
    });
    expect(readComposerReferenceMentionV1({
      ...payload,
      ref: 'other:issue:42',
      token: '@issue-42',
    })).toBeNull();
    expect(readComposerReferenceMentionV1({
      kind: 'happier.composerReference',
      ref: 'composerReference:issue:42',
      composerReferenceProvider: REFERENCE,
      token: '@issue-42',
    })).toBeNull();
  });
});

describe('composer reference prompt context block', () => {
  it('renders current qualified reference context as model-visible text, not an authority envelope', () => {
    const block = renderComposerReferenceContextBlockV1([{
      reference: REFERENCE,
      candidateId: 'issue:42',
      resolution: {
        id: 'issue:42',
        label: 'Issue 42',
        description: 'Current sprint issue',
        context: 'Status is <ready>.',
      },
    }]);

    expect(block).toContain('<happier_composer_reference_context v="1">');
    expect(block).toContain('reference_plugin_id="acme.issues"');
    expect(block).toContain('reference_local_id="issues"');
    expect(block).toContain('candidate_id="issue:42"');
    expect(block).toContain('context="Status is \\u003cready\\u003e."');
    expect(block).toContain('</happier_composer_reference_context>');
  });

  it('keeps complete reference entries in first-occurrence order and states deterministic aggregate omissions', () => {
    const contexts = Array.from({ length: 4 }, (_, index) => ({
      reference: REFERENCE,
      candidateId: `issue:${index}`,
      resolution: {
        id: `issue:${index}`,
        label: `Issue ${index}`,
        context: 'x'.repeat(MENTION_BOUNDS.maxResolvedContextChars),
      },
    }));

    const block = renderComposerReferenceContextBlockV1(contexts);

    expect(Array.from(block).length).toBeLessThanOrEqual(MENTION_BOUNDS.maxReferenceBlockChars);
    expect(block).toMatch(/reference\(s\) omitted to stay within the reference budget/);
    expect(block.endsWith('</happier_composer_reference_context>')).toBe(true);
  });

  it('renders resolved attachment context in author order with host-authored escaped delimiters only', () => {
    const block = renderComposerReferenceContextBlockV1([], [
      {
        attachment: {
          v: 1,
          instanceId: 'instance-1',
          attachment: { pluginId: 'acme.issues', localId: 'issue' },
          key: 'issue-42',
          value: { privateValue: 'must not render' },
          presentation: { label: 'Issue 42', typeLabel: 'Issue' },
          data: { internalData: 'must not render' },
        },
        context: 'First <external> attachment context',
      },
      {
        attachment: {
          v: 1,
          instanceId: 'instance-2',
          attachment: { pluginId: 'acme.issues', localId: 'issue' },
          key: 'issue-43',
          value: { privateValue: 'must not render' },
          presentation: { label: 'Issue 43', typeLabel: 'Issue' },
        },
        context: 'Second attachment context',
      },
    ]);

    expect(block).toContain('<happier_composer_attachment_context');
    expect(block).toContain('attachment_plugin_id="acme.issues"');
    expect(block).toContain('attachment_local_id="issue"');
    expect(block).toContain('attachment_instance_id="instance-1"');
    expect(block).toContain('attachment_key="issue-42"');
    expect(block).toContain('context="First \\u003cexternal\\u003e attachment context"');
    expect(block.indexOf('attachment_key="issue-42"')).toBeLessThan(block.indexOf('attachment_key="issue-43"'));
    expect(block).not.toContain('privateValue');
    expect(block).not.toContain('internalData');
  });

  it('renders a selected attachment host-identity enclosure when plugin context is absent', () => {
    const block = renderComposerReferenceContextBlockV1([], [{
      attachment: {
        v: 1,
        instanceId: 'instance-without-context',
        attachment: { pluginId: 'acme.review', localId: 'review-comment' },
        key: 'comment-42',
        value: { privateValue: 'must not render' },
        presentation: { label: 'Review comment', typeLabel: 'Review comment' },
      },
    }]);

    expect(block).toContain('<happier_composer_attachment_context');
    expect(block).toContain('attachment_plugin_id="acme.review"');
    expect(block).toContain('attachment_local_id="review-comment"');
    expect(block).toContain('attachment_instance_id="instance-without-context"');
    expect(block).toContain('attachment_key="comment-42"');
    expect(block).not.toContain('context=');
    expect(block).not.toContain('privateValue');
  });
});
