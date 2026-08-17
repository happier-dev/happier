import { describe, expect, it } from 'vitest';

import {
  ComposerReferenceCandidatePageV1Schema,
  ComposerReferenceResolutionV1Schema,
  MAX_COMPOSER_REFERENCE_RESOLUTION_JSON_BYTES_V1,
  PluginComposerReferenceProviderContributionV1Schema,
  normalizeComposerReferenceQueryV1,
} from './composerReferenceProviders.js';
import { PluginComposerAttachmentContributionV1Schema } from './composerAttachments.js';
import { PluginComposerControlContributionV1Schema } from './composerControls.js';
import { PluginContributesV2Schema } from './v2.js';

describe('composer reference provider contribution contract', () => {
  it('admits a declared composer reference with localized static launcher facts while rejecting an undeclared callback shape', () => {
    expect(PluginComposerReferenceProviderContributionV1Schema.parse({
      id: 'issues',
      title: 'Issues',
      description: { key: 'composer.references.issues.description', fallback: 'Search project issues' },
      icon: 'error',
    })).toEqual({
      id: 'issues',
      title: 'Issues',
      description: { key: 'composer.references.issues.description', fallback: 'Search project issues' },
      icon: 'error',
      triggers: ['@'],
    });
    expect(PluginComposerReferenceProviderContributionV1Schema.safeParse({
      id: 'issues',
      icon: 'error',
    }).success).toBe(false);
    expect(PluginComposerReferenceProviderContributionV1Schema.safeParse({
      id: 'issues',
      title: 'Issues',
      icon: 'error',
      onTrigger: () => undefined,
    }).success).toBe(false);
  });

  it('normalizes the query once and rejects oversized or malformed candidate pages', () => {
    expect(normalizeComposerReferenceQueryV1('e\u0301')).toBe('é');
    expect(() => normalizeComposerReferenceQueryV1('x'.repeat(257))).toThrow();

    expect(ComposerReferenceCandidatePageV1Schema.safeParse([
      { id: 'issue-1', label: 'Issue 1', description: 'Current issue' },
    ]).success).toBe(true);
    expect(ComposerReferenceCandidatePageV1Schema.safeParse(
      Array.from({ length: 33 }, (_, index) => ({ id: `issue-${index}`, label: `Issue ${index}` })),
    ).success).toBe(false);
    expect(ComposerReferenceCandidatePageV1Schema.safeParse([
      { id: 'issue-1', label: 'x'.repeat(129) },
    ]).success).toBe(false);
  });

  it('accepts only bounded prompt-safe string context from resolve', () => {
    expect(ComposerReferenceResolutionV1Schema.safeParse({
      id: 'issue-1',
      label: 'Issue 1',
      context: 'Issue 1 is ready for review.',
    }).success).toBe(true);

    // A structured value could carry a host path, Action, Resource, or callback-shaped
    // capability. Provider context is model-visible text only, never a second authority
    // envelope.
    expect(ComposerReferenceResolutionV1Schema.safeParse({
      id: 'issue-1',
      label: 'Issue 1',
      context: { path: '/workspace/secret.txt' },
    }).success).toBe(false);
    expect(ComposerReferenceResolutionV1Schema.safeParse({
      id: 'issue-1',
      label: 'Issue 1',
      context: 'x'.repeat(MAX_COMPOSER_REFERENCE_RESOLUTION_JSON_BYTES_V1),
    }).success).toBe(false);
  });

  it('projects only a manifest-declared composer reference into its final normalized family', () => {
    expect(PluginContributesV2Schema.parse({
      composerReferences: [{ id: 'issues', title: 'Issues', icon: 'error' }],
    }).composerReferences).toEqual([{
      id: 'issues',
      title: 'Issues',
      icon: 'error',
      triggers: ['@'],
    }]);
    expect(PluginContributesV2Schema.safeParse({
      composerReferenceProviders: [{ id: 'issues', title: 'Issues', icon: 'error' }],
    }).success).toBe(false);
  });

  it('admits independent attachment, control, and region declarations under the composer catalog', () => {
    const contributes = PluginContributesV2Schema.parse({
      composerAttachments: [{
        id: 'issue',
        title: 'Issue',
        icon: 'error',
        cardinality: 'many',
        valueSchema: { type: 'object' },
        display: { kind: 'badge' },
      }],
      composerControls: [{
        id: 'issue',
        label: 'Issue',
        icon: 'error',
        interaction: {
          kind: 'attachmentPicker',
          attachment: 'issue',
          presentation: 'popover',
          layout: 'content',
        },
      }],
      composerRegions: [{
        id: 'warning',
        placement: 'beforeComposer',
        renderer: { renderer: 'warning-surface' },
      }],
    });

    expect(contributes.composerAttachments).toHaveLength(1);
    expect(contributes.composerControls).toHaveLength(1);
    expect(contributes.composerRegions).toHaveLength(1);
  });

  it('keeps composer control state Resource-only and rejects held attachment-derived state', () => {
    const declaration = {
      id: 'issue-control',
      label: 'Issue',
      icon: 'error',
      interaction: { kind: 'action' as const, action: 'refresh-issue' },
    };

    expect(PluginComposerControlContributionV1Schema.safeParse({
      ...declaration,
      state: { resource: 'issue-control-state' },
    }).success).toBe(true);
    expect(PluginComposerControlContributionV1Schema.safeParse({
      ...declaration,
      state: {
        attachmentSelection: {
          attachments: ['issue'],
          one: 'selectedLabel',
          many: 'count',
          icon: 'selectedIcon',
        },
      },
    }).success).toBe(false);
  });

  it('rejects lossy whitespace around declared control-choice identities', () => {
    const declaration = {
      id: 'issue-control',
      label: 'Issue',
      icon: 'error',
      interaction: {
        kind: 'choices' as const,
        selection: 'single' as const,
        options: [{
          id: ' issue-42 ',
          label: 'Issue 42',
          effect: { kind: 'action' as const, action: 'refresh-issue' },
        }],
      },
    };

    expect(PluginComposerControlContributionV1Schema.safeParse(declaration).success).toBe(false);
    expect(PluginComposerControlContributionV1Schema.safeParse({
      ...declaration,
      interaction: {
        ...declaration.interaction,
        options: [{
          ...declaration.interaction.options[0],
          id: 'issue-42',
        }],
      },
    }).success).toBe(true);
  });

  it('requires an explicitly declared prepare role only when an attachment changes its prepared schema', () => {
    const declaration = {
      id: 'issue',
      title: 'Issue',
      icon: 'error',
      cardinality: 'many' as const,
      valueSchema: { type: 'object' as const },
    };

    expect(PluginComposerAttachmentContributionV1Schema.safeParse({
      ...declaration,
      runtime: {},
    }).success).toBe(false);
    expect(PluginComposerAttachmentContributionV1Schema.safeParse({
      ...declaration,
      preparedValueSchema: { type: 'string' },
    }).success).toBe(false);
    expect(PluginComposerAttachmentContributionV1Schema.safeParse({
      ...declaration,
      preparedValueSchema: { type: 'string' },
      runtime: { prepareForSend: true },
    }).success).toBe(true);
  });

  it('admits the approved staged-media display and host-preview declarations without opening a generic-file arm', () => {
    const declaration = {
      id: 'issue',
      title: 'Issue',
      icon: 'error',
      cardinality: 'many' as const,
      valueSchema: { type: 'object' as const },
    };

    expect(PluginComposerAttachmentContributionV1Schema.safeParse({
      ...declaration,
      display: { kind: 'media', media: 'image' },
      preview: { kind: 'host', presentation: 'image' },
    }).success).toBe(true);
    expect(PluginComposerAttachmentContributionV1Schema.safeParse({
      ...declaration,
      display: { kind: 'media', media: 'video' },
      preview: { kind: 'host', presentation: 'video' },
    }).success).toBe(true);
    expect(PluginComposerAttachmentContributionV1Schema.safeParse({
      ...declaration,
      display: { kind: 'media', media: 'file' },
    }).success).toBe(false);
    expect(PluginComposerAttachmentContributionV1Schema.safeParse({
      ...declaration,
      preview: { kind: 'host', presentation: 'file' },
    }).success).toBe(false);
  });
});
