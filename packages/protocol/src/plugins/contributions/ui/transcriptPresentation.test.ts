import { describe, expect, it } from 'vitest';

import { PluginDeclarativeNodeV2Schema } from './v2.js';
import {
  PLUGIN_TRANSCRIPT_PRESENTATION_NODE_V1_KINDS,
  PluginTranscriptPresentationNodeV1Schema,
} from './index.js';

describe('PluginTranscriptPresentationNodeV1', () => {
  it('accepts the immutable subset of the canonical declarative vocabulary', () => {
    const snapshot = {
      kind: 'stack',
      children: [
        { kind: 'text', text: 'Preparing review', tone: 'muted' },
        { kind: 'markdown', text: '## Findings' },
        {
          kind: 'group',
          title: 'Summary',
          children: [
            { kind: 'status', label: 'State', value: 'Ready', tone: 'success' },
            { kind: 'metadata', entries: [{ label: 'Files', value: '3' }] },
            {
              kind: 'list',
              children: [
                {
                  kind: 'section',
                  title: 'Changed files',
                  children: [
                    { kind: 'item', title: 'src/main.ts', detail: 'Modified' },
                    { kind: 'state', state: 'loading', title: 'Checking tests' },
                  ],
                },
              ],
            },
            {
              kind: 'actionPanel',
              children: [{ kind: 'action', action: 'open-review', label: 'Open review' }],
            },
          ],
        },
      ],
    };

    expect(PluginTranscriptPresentationNodeV1Schema.safeParse(snapshot).success).toBe(true);
    expect(PLUGIN_TRANSCRIPT_PRESENTATION_NODE_V1_KINDS).toEqual([
      'text',
      'markdown',
      'stack',
      'group',
      'status',
      'action',
      'list',
      'section',
      'item',
      'state',
      'metadata',
      'actionPanel',
    ]);
  });

  it('rejects a field at any depth even though the canonical declarative grammar accepts it', () => {
    const liveField = {
      kind: 'group',
      children: [{
        kind: 'field',
        label: 'Account',
        control: { kind: 'text', settingId: 'account-name' },
      }],
    };

    expect(PluginDeclarativeNodeV2Schema.safeParse(liveField).success).toBe(true);
    expect(PluginTranscriptPresentationNodeV1Schema.safeParse(liveField).success).toBe(false);
  });

  it('rejects an Account Collection list because persisted transcripts have no live Data owner', () => {
    const liveCollectionList = {
      kind: 'collectionList',
      source: {
        collectionId: 'tasks',
        uiQueryId: 'open-tasks',
      },
      projection: {
        titleField: { field: 'title', kind: 'string' },
      },
    };

    expect(PluginDeclarativeNodeV2Schema.safeParse(liveCollectionList).success).toBe(true);
    expect(PluginTranscriptPresentationNodeV1Schema.safeParse(liveCollectionList).success).toBe(false);
  });

  it('rejects a targeted Surface recursively because transcript replay must not resolve live contributors', () => {
    const liveTargetedSurface = {
      kind: 'group',
      children: [{
        kind: 'targetedSurface',
        surface: {
          point: { pointId: 'details', protocol: { id: 'review-detail', version: 1 } },
          contributor: { pluginId: 'com.acme.review', contributionId: 'detail' },
          role: 'detail',
        },
        input: { reviewId: 'review-42' },
        instanceKey: 'review-42',
      }],
    };

    expect(PluginDeclarativeNodeV2Schema.safeParse(liveTargetedSurface).success).toBe(true);
    expect(PluginTranscriptPresentationNodeV1Schema.safeParse(liveTargetedSurface).success).toBe(false);
  });

  it('rejects a composerApply effect because transcript replay has no live Composer owner', () => {
    const liveComposerApply = {
      kind: 'action',
      label: 'Replace draft',
      effect: {
        kind: 'composerApply',
        expectedRevision: 2,
        operations: [{ kind: 'text.set', text: 'Review this incident' }],
      },
    };

    expect(PluginDeclarativeNodeV2Schema.safeParse(liveComposerApply).success).toBe(true);
    expect(PluginTranscriptPresentationNodeV1Schema.safeParse(liveComposerApply).success).toBe(false);
  });

  it.each([
    ['heading', { kind: 'heading', text: 'Findings' }],
    ['codeBlock', { kind: 'codeBlock', code: 'const findings = []', language: 'typescript' }],
    ['link', { kind: 'link', label: 'Open review', href: 'https://example.test/review' }],
  ])('rejects %s because presentation components are not transcript grammar nodes', (_kind, node) => {
    expect(PluginDeclarativeNodeV2Schema.safeParse(node).success).toBe(false);
    expect(PluginTranscriptPresentationNodeV1Schema.safeParse(node).success).toBe(false);
  });

  it('retains the canonical grammar strictness rather than accepting a transcript-only bag', () => {
    expect(PluginTranscriptPresentationNodeV1Schema.safeParse({
      kind: 'text',
      text: 'Safe text',
      resource: { id: 'live-resource' },
    }).success).toBe(false);
  });
});
