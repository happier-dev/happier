import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { PluginContributionIdentityV1Schema } from '../../plugins/contributionIdentity.js';
import {
  MENTION_BOUNDS,
  MENTION_KIND_V1,
  MENTION_REF_SCHEME_V1,
  admitMentionRefsV1ForText,
  buildMentionRefForKindV1,
  buildMentionRefV1,
  parseMentionRefV1,
  readMentionRefOpaqueForKindV1,
  sanitizeMentionRefsV1,
  type MentionRefV1,
} from './mentionRefV1.js';
import {
  AgentDispatchStructuredInputV1Schema,
  HappierStructuredInputV1Schema,
  hasRawComposerAttachmentSelectionV1,
  hasRawStructuredInputSemanticContentV1,
  readAdmittedHappierStructuredInputV1FromMeta,
  readHappierStructuredInputV1FromMeta,
  readStructuredInputMentionSourcesV1,
  sanitizeHappierStructuredInputV1,
  sanitizeSessionStructuredInputMeta,
} from './structuredInputV1.js';
import * as composerAttachmentV1 from './composerAttachmentV1.js';
import {
  buildComposerAttachmentDedupeKeyV1,
  ComposerAttachmentInputV1Schema,
  ComposerAttachmentValueV1Schema,
  MAX_COMPOSER_ATTACHMENT_VALUE_JSON_BYTES_V1,
} from './composerAttachmentV1.js';

function mention(overrides: Partial<MentionRefV1> = {}): Record<string, unknown> {
  return {
    kind: MENTION_KIND_V1.file,
    ref: 'file:src/index.ts',
    token: '@src/index.ts',
    ...overrides,
  };
}

describe('mention reference grammar', () => {
  it('round-trips an opaque component losslessly through percent-encoding', () => {
    const opaque = 'vendor:codex:review a skill/100% "quoted"';
    const ref = buildMentionRefV1('skill', opaque);
    expect(parseMentionRefV1(ref)).toEqual({ scheme: 'skill', opaque });
  });

  it('keeps the readable case readable and splits on the first colon only', () => {
    expect(buildMentionRefV1('skill', 'vendor:codex:review')).toBe('skill:vendor:codex:review');
    expect(parseMentionRefV1('skill:vendor:codex:review')).toEqual({
      scheme: 'skill',
      opaque: 'vendor:codex:review',
    });
  });

  it('rejects an authority form, a malformed escape and an empty opaque part', () => {
    // D-8: the authority form would embed a device-local profile id in a persisted reference.
    expect(parseMentionRefV1('session://scope/abc')).toEqual({ scheme: 'session', opaque: '//scope/abc' });
    expect(parseMentionRefV1('skill:%zz')).toBeNull();
    expect(parseMentionRefV1('skill:')).toBeNull();
    expect(parseMentionRefV1(':abc')).toBeNull();
    expect(parseMentionRefV1('1skill:abc')).toBeNull();
  });
});

/**
 * These literals are a CROSS-REPOSITORY, one-way persisted contract (D-13). A reference is
 * written by one build and resolved by another — and by the other repository, which declares
 * the same table at `packages/protocol/src/mentionRefV1.ts`. Asserting only `build -> read`
 * round trips would be self-satisfying: renaming a scheme changes both halves at once and
 * every such test stays green while every reference already on the wire stops resolving.
 * The wire strings are therefore pinned literally.
 */
describe('built-in kind reference schemes', () => {
  it('pins the wire scheme of every built-in kind', () => {
    expect(MENTION_REF_SCHEME_V1).toEqual({
      'happier.file': 'file',
      'happier.skill': 'skill',
      'happier.vendorPlugin': 'vendorPlugin',
      'happier.session': 'session',
    });
    expect(buildMentionRefForKindV1(MENTION_KIND_V1.skill, 'vendor:codex:review'))
      .toBe('skill:vendor:codex:review');
    expect(buildMentionRefForKindV1(MENTION_KIND_V1.vendorPlugin, 'plugin://linear@happier'))
      .toBe('vendorPlugin:plugin://linear@happier');
    expect(buildMentionRefForKindV1(MENTION_KIND_V1.session, 'sess_1')).toBe('session:sess_1');
    expect(buildMentionRefForKindV1(MENTION_KIND_V1.file, 'src/a.ts')).toBe('file:src/a.ts');
  });

  it('reads back only through the kind that wrote it (INV-4)', () => {
    const ref = buildMentionRefForKindV1(MENTION_KIND_V1.skill, 'vendor:codex:review');
    expect(readMentionRefOpaqueForKindV1(MENTION_KIND_V1.skill, ref)).toBe('vendor:codex:review');
    // A reference tagged with one kind but schemed for another must never resolve as the
    // kind asked for — that is what stops a known kind from swallowing a foreign reference.
    expect(readMentionRefOpaqueForKindV1(MENTION_KIND_V1.vendorPlugin, ref)).toBeNull();
    expect(readMentionRefOpaqueForKindV1(MENTION_KIND_V1.skill, 'ticket:ACME-1')).toBeNull();
    expect(readMentionRefOpaqueForKindV1(MENTION_KIND_V1.skill, 'skill:%zz')).toBeNull();
  });
});

describe('sanitizeMentionRefsV1', () => {
  it('drops a malformed element individually and keeps its siblings (INV-4)', () => {
    const sanitized = sanitizeMentionRefsV1([
      mention({ token: '@a.ts' }),
      // `b.ts` has no `<scheme>:` head, so it is not a reference at all.
      { kind: 'happier.file', ref: 'b.ts', token: '@b.ts' },
      mention({ token: '@c.ts', ref: 'file:c.ts' }),
    ]);
    expect(sanitized.map((entry) => entry.token)).toEqual(['@a.ts', '@c.ts']);
  });

  it('preserves an unknown kind inert and never reinterprets it as a known kind', () => {
    const sanitized = sanitizeMentionRefsV1([
      mention({ kind: 'acme.ticket', ref: 'ticket:ACME-1', token: '@ACME-1' }),
    ]);
    expect(sanitized).toHaveLength(1);
    expect(sanitized[0]?.kind).toBe('acme.ticket');
  });

  it('preserves unknown fields on an element so an older build does not strip newer data', () => {
    const sanitized = sanitizeMentionRefsV1([mention()].map((entry) => ({
      ...entry,
      futureField: { nested: true },
    })));
    expect(sanitized[0]).toMatchObject({ futureField: { nested: true } });
  });

  it('keeps first-occurrence order and collapses a repeated reference (D-26)', () => {
    const sanitized = sanitizeMentionRefsV1([
      mention({ token: '@b.ts', ref: 'file:b.ts' }),
      mention({ token: '@a.ts', ref: 'file:a.ts' }),
      // The same reference mentioned a second time in the text carries nothing extra.
      mention({ token: '@b.ts', ref: 'file:b.ts' }),
    ]);
    expect(sanitized.map((entry) => entry.ref)).toEqual(['file:b.ts', 'file:a.ts']);
  });

  it('enforces the per-message and per-field bounds', () => {
    const many = Array.from({ length: MENTION_BOUNDS.maxPerMessage + 5 }, (_, index) => mention({
      token: '@ab',
      ref: `file:${index}`,
    }));
    expect(sanitizeMentionRefsV1(many)).toHaveLength(MENTION_BOUNDS.maxPerMessage);

    expect(sanitizeMentionRefsV1([mention({ ref: `file:${'x'.repeat(MENTION_BOUNDS.maxRefChars)}` })])).toEqual([]);
    expect(sanitizeMentionRefsV1([mention({ kind: 'k'.repeat(MENTION_BOUNDS.maxKindChars + 1) })])).toEqual([]);
    expect(sanitizeMentionRefsV1([mention({ token: 't'.repeat(MENTION_BOUNDS.maxTokenChars + 1) })])).toEqual([]);
    expect(sanitizeMentionRefsV1([mention({ label: 'l'.repeat(MENTION_BOUNDS.maxLabelChars + 1) })])).toEqual([]);
  });
});

describe('admitMentionRefsV1ForText', () => {
  const text = 'see @src/a.ts and @src/b.ts';
  const first = sanitizeMentionRefsV1([
    mention({ ref: 'file:src/a.ts', token: '@src/a.ts' }),
    mention({ ref: 'file:src/b.ts', token: '@src/b.ts' }),
  ]);

  it('admits references whose token the submitted text carries', () => {
    expect(admitMentionRefsV1ForText(text, first)).toHaveLength(2);
  });

  it('rejects a reference whose token is gone from the submitted text, keeping siblings', () => {
    const stale = sanitizeMentionRefsV1([
      mention({ ref: 'file:src/a.ts', token: '@src/a.ts' }),
      mention({ ref: 'file:src/z.ts', token: '@src/z.ts' }),
    ]);
    const admitted = admitMentionRefsV1ForText(text, stale);
    expect(admitted.map((entry) => entry.ref)).toEqual(['file:src/a.ts']);
  });

  it('rejects every reference when the submitted text carries none of them', () => {
    expect(admitMentionRefsV1ForText('short', first)).toEqual([]);
  });

  it('admits a reference whose token moved between composition and submission', () => {
    // The submitted text is a TRANSFORM of the text the composer authored against: a trim,
    // an attachments block, a review-comments wrapper. The reference is still the one the
    // user picked, and it still names itself in the text, so it is admitted.
    const composed = sanitizeMentionRefsV1([
      mention({ ref: 'file:src/a.ts', token: '@src/a.ts' }),
    ]);
    expect(admitMentionRefsV1ForText('\nsee @src/a.ts', composed).map((entry) => entry.ref))
      .toEqual(['file:src/a.ts']);
    expect(admitMentionRefsV1ForText('review this\n\nsee @src/a.ts', composed).map((entry) => entry.ref))
      .toEqual(['file:src/a.ts']);
  });

  it('matches the token verbatim, without trimming or normalizing it', () => {
    const quoted = sanitizeMentionRefsV1([
      mention({ ref: 'file:my notes.md', token: '@"my notes.md"' }),
    ]);
    expect(admitMentionRefsV1ForText('read @"my notes.md" first', quoted)).toHaveLength(1);
    expect(admitMentionRefsV1ForText('read @my notes.md first', quoted)).toEqual([]);
  });
});

describe('HappierStructuredInputV1 envelope carries mentions additively', () => {
  it('keeps v: 1 and sanitizes mentions element-wise', () => {
    const envelope = sanitizeHappierStructuredInputV1({
      v: 1,
      mentions: [
        mention({ ref: 'file:a.ts', token: '@a.ts' }),
        { kind: 'happier.file', ref: 'not a ref', token: '@b' },
      ],
    });
    expect(envelope?.v).toBe(1);
    expect(envelope?.mentions?.map((entry) => entry.ref)).toEqual(['file:a.ts']);
  });

  it('is accepted by the passthrough envelope schema an older reader parses with', () => {
    // R-4 / D-24: `../dev`'s OpenCode projection rejects an envelope that fails this schema.
    const parsed = HappierStructuredInputV1Schema.safeParse({
      v: 1,
      mentions: [mention({ ref: 'file:a.ts', token: '@a.ts' })],
      skillMentions: [{ name: 'review', path: '/skills/review.md' }],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.skillMentions?.[0]?.name).toBe('review');
  });

  it('survives a load -> save round trip with an unknown kind unreinterpreted', () => {
    const source = {
      v: 1,
      mentions: [mention({ kind: 'acme.ticket', ref: 'ticket:ACME-1', token: '@ACME-1' })],
    };
    const loaded = sanitizeHappierStructuredInputV1(source);
    const saved = sanitizeHappierStructuredInputV1(loaded);
    expect(saved?.mentions).toEqual(loaded?.mentions);
    expect(saved?.mentions?.[0]?.kind).toBe('acme.ticket');
    expect(saved?.skillMentions).toBeUndefined();
  });

  it('carries bounded admitted composer attachments without treating them as mentions or images', () => {
    const attachment = {
      v: 1,
      instanceId: 'instance-1',
      attachment: {
        pluginId: 'com.acme.review',
        localId: 'review',
      },
      key: 'review-42',
      value: { reviewId: '42' },
      presentation: { label: 'Review #42', typeLabel: 'Review comment', icon: 'info' },
    };
    expect(ComposerAttachmentInputV1Schema.safeParse(attachment).success).toBe(true);
    expect(HappierStructuredInputV1Schema.parse({
      v: 1,
      composerAttachments: [attachment],
    }).composerAttachments).toEqual([attachment]);
    expect(HappierStructuredInputV1Schema.safeParse({
      v: 1,
      composerAttachments: Array.from({ length: 65 }, () => attachment),
    }).success).toBe(false);
  });

  it('keeps an attachment value at the exact canonical JSON byte boundary and rejects one byte over without truncation', () => {
    const emptyEnvelopeBytes = new TextEncoder().encode(JSON.stringify({ payload: '' })).byteLength;
    const exactValue = {
      payload: 'x'.repeat(MAX_COMPOSER_ATTACHMENT_VALUE_JSON_BYTES_V1 - emptyEnvelopeBytes),
    };
    const oneByteOver = { payload: `${exactValue.payload}x` };

    expect(new TextEncoder().encode(JSON.stringify(exactValue)).byteLength)
      .toBe(MAX_COMPOSER_ATTACHMENT_VALUE_JSON_BYTES_V1);
    expect(ComposerAttachmentValueV1Schema.safeParse(exactValue).success).toBe(true);
    expect(ComposerAttachmentValueV1Schema.safeParse(oneByteOver).success).toBe(false);
    expect(oneByteOver.payload).toHaveLength(exactValue.payload.length + 1);
  });

  it('fails closed on a raw malformed composer attachment selection before sanitization', () => {
    expect(hasRawComposerAttachmentSelectionV1({
      happierStructuredInputV1: { v: 1 },
    })).toBe(false);
    expect(hasRawComposerAttachmentSelectionV1({
      happierStructuredInputV1: { v: 1, composerAttachments: [] },
    })).toBe(false);
    expect(hasRawComposerAttachmentSelectionV1({
      happierStructuredInputV1: { v: 1, composerAttachments: [{ malformed: true }] },
    })).toBe(true);
    expect(hasRawComposerAttachmentSelectionV1({
      happierStructuredInputV1: { v: 1, composerAttachments: 'malformed' },
    })).toBe(true);
  });

  it('identifies raw structured-input semantics a text-only editor cannot faithfully project', () => {
    expect(hasRawStructuredInputSemanticContentV1({})).toBe(false);
    expect(hasRawStructuredInputSemanticContentV1({
      happierStructuredInputV1: { v: 1 },
    })).toBe(false);
    expect(hasRawStructuredInputSemanticContentV1({
      happierStructuredInputV1: {
        v: 1,
        mentions: [],
        imageInputs: [],
        composerAttachments: [],
      },
    })).toBe(false);
    expect(hasRawStructuredInputSemanticContentV1({
      happierStructuredInputV1: { v: 1, mentions: [mention()] },
    })).toBe(true);
    expect(hasRawStructuredInputSemanticContentV1({
      happierStructuredInputV1: { v: 1, imageInputs: [{ kind: 'image' }] },
    })).toBe(true);
    expect(hasRawStructuredInputSemanticContentV1({
      happierStructuredInputV1: { v: 1, composerAttachments: [{ malformed: true }] },
    })).toBe(true);
    expect(hasRawStructuredInputSemanticContentV1({
      happierStructuredInputV1: { v: 1, mentions: 'malformed' },
    })).toBe(true);
    expect(hasRawStructuredInputSemanticContentV1({
      happierStructuredInputV1: { v: 1, futureSemanticField: { opaque: true } },
    })).toBe(true);
    expect(hasRawStructuredInputSemanticContentV1({
      happierStructuredInputV1: 'malformed-envelope',
    })).toBe(true);
  });

  it('rejects surrounding whitespace instead of collapsing attachment identity or persisted presentation bytes', () => {
    const attachment = {
      v: 1,
      instanceId: 'instance-1',
      attachment: {
        pluginId: 'com.acme.review',
        localId: 'review',
      },
      key: 'review-42',
      value: { reviewId: '42' },
      presentation: {
        label: 'Review #42',
        description: 'Requested change',
        typeLabel: 'Review comment',
      },
    };

    expect(ComposerAttachmentInputV1Schema.safeParse(attachment).success).toBe(true);
    expect(ComposerAttachmentInputV1Schema.safeParse({ ...attachment, instanceId: ' instance-1 ' }).success).toBe(false);
    expect(ComposerAttachmentInputV1Schema.safeParse({ ...attachment, key: ' review-42 ' }).success).toBe(false);
    expect(ComposerAttachmentInputV1Schema.safeParse({
      ...attachment,
      presentation: { ...attachment.presentation, label: ' Review #42 ' },
    }).success).toBe(false);
    expect(ComposerAttachmentInputV1Schema.safeParse({
      ...attachment,
      presentation: { ...attachment.presentation, description: ' Requested change ' },
    }).success).toBe(false);
    expect(ComposerAttachmentInputV1Schema.safeParse({
      ...attachment,
      presentation: { ...attachment.presentation, typeLabel: ' Review comment ' },
    }).success).toBe(false);
    expect(ComposerAttachmentInputV1Schema.safeParse({
      ...attachment,
      content: [{ mediaId: 'media-42' }],
    }).success).toBe(false);
  });

  it('drops bounded future presentation fields without erasing the known attachment fallback', () => {
    const attachment = {
      v: 1,
      instanceId: 'instance-1',
      attachment: {
        pluginId: 'com.acme.review',
        localId: 'review',
      },
      key: 'review-42',
      value: { reviewId: '42' },
      presentation: {
        label: 'Review #42',
        description: 'Requested change',
        typeLabel: 'Review comment',
        futureDisplayField: { emphasis: 'high' },
      },
    };

    const parsed = ComposerAttachmentInputV1Schema.parse(attachment);
    expect(parsed.presentation).toEqual({
      label: 'Review #42',
      description: 'Requested change',
      typeLabel: 'Review comment',
    });
    expect(sanitizeHappierStructuredInputV1({
      v: 1,
      composerAttachments: [attachment],
    })?.composerAttachments).toEqual([parsed]);
    expect(ComposerAttachmentInputV1Schema.safeParse({
      ...attachment,
      presentation: { ...attachment.presentation, label: '' },
    }).success).toBe(false);
  });

  it('sanitizes composer attachments element-wise and never preserves dispatch-only resolution', () => {
    const valid = {
      v: 1,
      instanceId: 'instance-1',
      attachment: { pluginId: 'com.acme.review', localId: 'review' },
      key: 'review-42',
      value: { reviewId: '42' },
      presentation: { label: 'Review #42', typeLabel: 'Review comment', icon: 'info' },
    };
    const sanitized = sanitizeHappierStructuredInputV1({
      v: 1,
      composerAttachments: [valid, { ...valid, attachment: { kind: 'host', owner: 'forged' } }],
      resolvedComposerAttachments: [{ instanceId: 'forged' }],
    });

    expect(sanitized?.composerAttachments).toEqual([valid]);
    expect(sanitized).not.toHaveProperty('resolvedComposerAttachments');
  });

  it('admits resolved attachment dispatch records only after raw composer attachments are removed', () => {
    const attachment = {
      v: 1,
      instanceId: 'instance-1',
      attachment: { pluginId: 'com.acme.review', localId: 'review' },
      key: 'review-42',
      value: { reviewId: '42' },
      presentation: { label: 'Review #42', typeLabel: 'Review comment', icon: 'info' },
    };
    const resolved = { ...attachment, data: { fresh: true } };

    expect(AgentDispatchStructuredInputV1Schema.safeParse({
      v: 1,
      resolvedComposerAttachments: [resolved],
    }).success).toBe(true);
    expect(AgentDispatchStructuredInputV1Schema.safeParse({
      v: 1,
      composerAttachments: [attachment],
    }).success).toBe(false);
    expect(AgentDispatchStructuredInputV1Schema.safeParse({
      v: 1,
      composerAttachments: [],
    }).success).toBe(false);
    expect(AgentDispatchStructuredInputV1Schema.safeParse({
      v: 1,
      composerAttachments: [attachment],
      resolvedComposerAttachments: [resolved],
    }).success).toBe(false);
    expect(AgentDispatchStructuredInputV1Schema.safeParse({
      v: 1,
      resolvedComposerAttachments: [{ ...resolved, content: { custody: 'forged' } }],
    }).success).toBe(false);
  });

  it('reads an admitted envelope without rerunning raw local-image trust and rejects dispatch-only data', () => {
    const admitted = {
      v: 1,
      imageInputs: [{
        id: 'image-1',
        kind: 'localImage',
        path: '.happier/uploads/messages/message-1/image.png',
        mimeType: 'image/png',
        provenance: { kind: 'sessionAttachmentUpload' },
      }],
    };

    expect(readAdmittedHappierStructuredInputV1FromMeta({
      happierStructuredInputV1: admitted,
    })).toEqual({ status: 'admitted', structuredInput: admitted });
    expect(readAdmittedHappierStructuredInputV1FromMeta({
      happierStructuredInputV1: {
        ...admitted,
        resolvedComposerAttachments: [{ instanceId: 'forged' }],
      },
    })).toEqual({ status: 'invalid' });
    expect(readAdmittedHappierStructuredInputV1FromMeta({
      happier: { kind: 'attachments.v1' },
    })).toEqual({ status: 'absent' });
  });

  it('uses only the canonical qualified plugin contribution schema for attachment identities', () => {
    expect(PluginContributionIdentityV1Schema.safeParse({
      kind: 'host',
      owner: 'browserContext',
    }).success).toBe(false);
    expect(PluginContributionIdentityV1Schema.safeParse({
      pluginId: 'com.acme.review',
      localId: 'review',
    }).success).toBe(true);
    expect(PluginContributionIdentityV1Schema.safeParse({
      kind: 'plugin',
      contribution: { pluginId: 'com.acme.review', localId: 'review' },
    }).success).toBe(false);
  });

  it('does not publish a Composer-specific alias for the canonical attachment identity', async () => {
    expect(composerAttachmentV1).not.toHaveProperty('ComposerAttachmentDefinitionIdentityV1Schema');
    const publicBarrel = await readFile(new URL('../../index.ts', import.meta.url), 'utf8');
    expect(publicBarrel).not.toContain('ComposerAttachmentDefinitionIdentityV1');
    expect(publicBarrel).toContain('PluginContributionIdentityV1Schema');
  });

  it('dedupes attachment drafts by the exact direct contribution identity and key', () => {
    const review = { pluginId: 'com.acme.review', localId: 'review' } as const;

    expect(buildComposerAttachmentDedupeKeyV1(review, 'review-42')).toBe('plugin:com.acme.review/review:review-42');
    expect(buildComposerAttachmentDedupeKeyV1(review, 'review-42')).toBe(
      buildComposerAttachmentDedupeKeyV1({ pluginId: 'com.acme.review', localId: 'review' }, 'review-42'),
    );
    expect(buildComposerAttachmentDedupeKeyV1(review, 'review-42')).not.toBe(
      buildComposerAttachmentDedupeKeyV1({ pluginId: 'com.acme.issue', localId: 'review' }, 'review-42'),
    );
    expect(buildComposerAttachmentDedupeKeyV1(review, 'review-42')).not.toBe(
      buildComposerAttachmentDedupeKeyV1(review, 'review-43'),
    );
  });
});

describe('D-4 precedence', () => {
  const skillRef = buildMentionRefV1('skill', 'vendor:codex:review');
  const bothShapes = {
    happierStructuredInputV1: {
      v: 1,
      mentions: [mention({
        kind: MENTION_KIND_V1.skill,
        ref: skillRef,
        token: '$review',
      })],
      skillMentions: [{ name: 'review', path: '/skills/review.md' }],
    },
    happierSkillMentions: [{ name: 'review', path: '/skills/review.md' }],
  };

  it('yields exactly one enumerated reference when both shapes are present', () => {
    const envelope = readHappierStructuredInputV1FromMeta(bothShapes);
    const sources = readStructuredInputMentionSourcesV1(envelope);
    expect(sources.mentions).toHaveLength(1);
    expect(sources.skillMentions).toEqual([]);
    expect(sources.vendorPluginMentions).toEqual([]);
  });

  it('ignores the meta-root aliases entirely when mentions are present', () => {
    const envelope = readHappierStructuredInputV1FromMeta(bothShapes);
    // The envelope still carries the legacy array so a dual-written message stays
    // readable on an older build; only the enumeration decision changes.
    expect(envelope?.skillMentions).toHaveLength(1);
    expect(readStructuredInputMentionSourcesV1(envelope).skillMentions).toEqual([]);
  });

  it('falls back to the legacy arrays and aliases when mentions are absent', () => {
    const envelope = readHappierStructuredInputV1FromMeta({
      happierStructuredInputV1: { v: 1, skillMentions: [{ name: 'review', path: '/skills/review.md' }] },
      happierSkillMentions: [{ name: 'audit', path: '/skills/audit.md' }],
    });
    const sources = readStructuredInputMentionSourcesV1(envelope);
    expect(sources.mentions).toEqual([]);
    expect(sources.skillMentions.map((entry) => entry.name)).toEqual(['review', 'audit']);
  });

  it('admits references against the submitted text at the request boundary', () => {
    const meta = {
      happierStructuredInputV1: {
        v: 1,
        mentions: [
          mention({ ref: 'file:src/a.ts', token: '@src/a.ts' }),
          mention({ ref: 'file:src/z.ts', token: '@src/z.ts' }),
        ],
      },
    };

    const admitted = sanitizeSessionStructuredInputMeta(meta, { text: 'see @src/a.ts and @src/b.ts' });
    const envelope = admitted.happierStructuredInputV1 as { mentions?: readonly MentionRefV1[] };
    expect(envelope.mentions?.map((entry) => entry.ref)).toEqual(['file:src/a.ts']);

    // Without the composed step the metadata is parsed independently of the text.
    const unchecked = sanitizeSessionStructuredInputMeta(meta);
    expect((unchecked.happierStructuredInputV1 as { mentions?: readonly MentionRefV1[] }).mentions)
      .toHaveLength(2);
  });

  it('leaves image inputs untouched by the precedence rule', () => {
    const envelope = readHappierStructuredInputV1FromMeta({
      happierStructuredInputV1: {
        v: 1,
        mentions: [mention({ ref: 'file:a.ts', token: '@a.ts' })],
        imageInputs: [{ kind: 'image', url: 'https://example.test/a.png' }],
      },
    });
    expect(envelope?.imageInputs).toHaveLength(1);
  });
});
