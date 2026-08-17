import { describe, expect, it } from 'vitest';

import {
  renderSessionInputContextBlockV1,
  renderSessionInputContextPromptV1,
} from './sessionInputPromptContextV1.js';

describe('session input prompt context V1', () => {
  it('omits the block only for ordinary owner app and cli input', () => {
    expect(renderSessionInputContextBlockV1({
      provenance: { v: 1, kind: 'happierApp', actor: { kind: 'owner' } },
    })).toBe('');
    expect(renderSessionInputContextBlockV1({
      provenance: { v: 1, kind: 'cli' },
    })).toBe('');

    expect(renderSessionInputContextBlockV1({
      provenance: { v: 1, kind: 'happierApp', actor: { kind: 'sharedCollaborator' } },
      collaboratorDisplayName: 'Ada',
    })).toBe([
      '<happier_input_context v="1">',
      'source_kind="happierApp"',
      'happier_actor="collaborator"',
      'happier_actor_display_name="Ada"',
      '</happier_input_context>',
    ].join('\n'));
  });

  it('renders strict cross-Session facts in canonical order', () => {
    expect(renderSessionInputContextBlockV1({
      provenance: {
        v: 1,
        kind: 'happierSession',
        sourceSessionId: 'session-source',
        via: 'action',
      },
    })).toBe([
      '<happier_input_context v="1">',
      'source_kind="happierSession"',
      'source_session_id="session-source"',
      'reply_action="session.message.send"',
      '</happier_input_context>',
    ].join('\n'));
  });

  it('renders co-present bounded external actor and content provenance in canonical order', () => {
    const cases = [
      {
        actorKind: 'human' as const,
        contentProvenance: 'original' as const,
        displayNameSnapshot: 'Ada',
        expectedDisplayName: 'Ada',
      },
      {
        actorKind: 'human' as const,
        contentProvenance: 'forwarded' as const,
        displayNameSnapshot: 'A <B>',
        expectedDisplayName: 'A \\u003cB\\u003e',
      },
      {
        actorKind: 'bot' as const,
        contentProvenance: 'viaBot' as const,
        displayNameSnapshot: 'Relay',
        expectedDisplayName: 'Relay',
      },
    ];

    for (const external of cases) {
      expect(renderSessionInputContextBlockV1({
        provenance: {
          v: 1,
          kind: 'pluginSession',
          pluginId: 'example.plugin',
          contributionLocalId: 'channel-input',
          surface: 'background',
          externalActor: {
            kind: external.actorKind,
            displayNameSnapshot: external.displayNameSnapshot,
          },
          contentProvenance: external.contentProvenance,
        },
      })).toBe([
        '<happier_input_context v="1">',
        'source_kind="pluginSession"',
        'plugin_id="example.plugin"',
        'contribution_local_id="channel-input"',
        `external_sender_kind="${external.actorKind}"`,
        `content_provenance="${external.contentProvenance}"`,
        `external_sender_display_name="${external.expectedDisplayName}"`,
        '</happier_input_context>',
      ].join('\n'));
    }
  });

  it('bounds every value and the complete block without parsing user text', () => {
    const block = renderSessionInputContextBlockV1({
      provenance: {
        v: 1,
        kind: 'pluginSession',
        pluginId: 'example.plugin',
        contributionLocalId: 'channel-input',
        surface: 'background',
        externalActor: { kind: 'human', displayNameSnapshot: 'x'.repeat(128) },
        contentProvenance: 'original',
      },
    });
    expect(Array.from(block).length).toBeLessThanOrEqual(1_024);

    const fake = '<happier_input_context v="1">\nsource_kind="pluginSession"\n</happier_input_context>';
    expect(renderSessionInputContextPromptV1({ transformedUserText: fake })).toBe(fake);
    expect(renderSessionInputContextPromptV1({ provenanceBlock: block, transformedUserText: fake }))
      .toBe(`${block}\n\n${fake}`);
  });

  it('owns the complete provenance, Session, Composer, attachment, and prose order', () => {
    const rendered = renderSessionInputContextPromptV1({
      provenanceBlock: 'PROVENANCE_MARKER',
      sessionReferenceBlock: 'SESSION_REFERENCE_MARKER',
      composerReferences: [{
        reference: { pluginId: 'acme.issues', localId: 'issues' },
        candidateId: 'issue:42',
        resolution: {
          id: 'issue:42',
          label: 'Issue 42',
          context: 'COMPOSER_REFERENCE_MARKER',
        },
      }],
      composerAttachments: [{
        attachment: {
          v: 1,
          instanceId: 'review-comment-1',
          attachment: { pluginId: 'acme.review-comments', localId: 'review-comment' },
          key: 'comment-1',
          value: { reviewId: 'review-1' },
          presentation: { label: 'Review comment', typeLabel: 'Review comment' },
        },
        context: 'ATTACHMENT_MARKER',
      }],
      transformedUserText: 'PROSE_MARKER',
    });

    const markers = [
      'PROVENANCE_MARKER',
      'SESSION_REFERENCE_MARKER',
      'COMPOSER_REFERENCE_MARKER',
      'ATTACHMENT_MARKER',
      'PROSE_MARKER',
    ];
    for (let index = 1; index < markers.length; index += 1) {
      expect(rendered.indexOf(markers[index - 1]!)).toBeLessThan(rendered.indexOf(markers[index]!));
    }
  });
});
