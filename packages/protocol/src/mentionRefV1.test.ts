import { describe, expect, it } from 'vitest';

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
  HappierStructuredInputV1EnvelopeSchema,
  readHappierStructuredInputV1FromMeta,
  readStructuredInputMentionSourcesV1,
  sanitizeHappierStructuredInputV1,
  sanitizeSessionUserMessageSendMeta,
} from './sessionUserMessageRpc.js';

function mention(overrides: Partial<MentionRefV1> = {}): Record<string, unknown> {
  return {
    kind: MENTION_KIND_V1.file,
    ref: 'file:src/index.ts',
    token: '@src/index.ts',
    start: 0,
    end: 13,
    ...overrides,
  };
}

describe('mention reference grammar', () => {
  it('round-trips an opaque component losslessly through percent-encoding', () => {
    const opaque = 'vendor:codex:review a skill/100% "quoted"';
    expect(parseMentionRefV1(buildMentionRefV1('skill', opaque))).toEqual({ scheme: 'skill', opaque });
  });

  it('keeps the readable case readable and splits on the first colon only', () => {
    expect(buildMentionRefV1('skill', 'vendor:codex:review')).toBe('skill:vendor:codex:review');
    expect(parseMentionRefV1('skill:vendor:codex:review')).toEqual({
      scheme: 'skill',
      opaque: 'vendor:codex:review',
    });
  });

  it('rejects a malformed escape, an empty opaque part and a non-scheme head', () => {
    expect(parseMentionRefV1('skill:%zz')).toBeNull();
    expect(parseMentionRefV1('skill:')).toBeNull();
    expect(parseMentionRefV1(':abc')).toBeNull();
    expect(parseMentionRefV1('1skill:abc')).toBeNull();
  });
});

/**
 * These literals are a CROSS-REPOSITORY, one-way persisted contract (D-13). A reference is
 * written by one build and resolved by another — and by the other repository, which declares
 * the same table at `packages/protocol/src/runtime/input/mentionRefV1.ts`. Asserting only
 * `build → read` round trips would be self-satisfying: renaming a scheme changes both halves
 * at once and every such test stays green while every reference already on the wire stops
 * resolving. The wire strings are therefore pinned literally.
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
      mention({ start: 0, end: 5, token: '@a.ts', ref: 'file:a.ts' }),
      { kind: 'happier.file', ref: 'file:b.ts', token: '@b.ts', start: 12, end: 9 },
      mention({ start: 6, end: 11, token: '@c.ts', ref: 'file:c.ts' }),
    ]);
    expect(sanitized.map((entry) => entry.token)).toEqual(['@a.ts', '@c.ts']);
  });

  it('preserves an unknown kind inert and never reinterprets it as a known kind', () => {
    const sanitized = sanitizeMentionRefsV1([
      mention({ kind: 'acme.ticket', ref: 'ticket:ACME-1', token: '@ACME-1', start: 0, end: 7 }),
    ]);
    expect(sanitized).toHaveLength(1);
    expect(sanitized[0]?.kind).toBe('acme.ticket');
  });

  it('canonicalizes order, drops an overlapping element and enforces the bounds', () => {
    expect(sanitizeMentionRefsV1([
      mention({ start: 10, end: 15, token: '@b.ts', ref: 'file:b.ts' }),
      mention({ start: 0, end: 5, token: '@a.ts', ref: 'file:a.ts' }),
      mention({ start: 12, end: 18, token: '@c.ts', ref: 'file:c.ts' }),
    ]).map((entry) => entry.start)).toEqual([0, 10]);

    const many = Array.from({ length: MENTION_BOUNDS.maxPerMessage + 5 }, (_, index) => mention({
      start: index * 4,
      end: index * 4 + 3,
      token: '@ab',
      ref: `file:${index}`,
    }));
    expect(sanitizeMentionRefsV1(many)).toHaveLength(MENTION_BOUNDS.maxPerMessage);
    expect(sanitizeMentionRefsV1([mention({ ref: `file:${'x'.repeat(MENTION_BOUNDS.maxRefChars)}` })])).toEqual([]);
    expect(sanitizeMentionRefsV1([mention({ token: 't'.repeat(MENTION_BOUNDS.maxTokenChars + 1) })])).toEqual([]);
    expect(sanitizeMentionRefsV1([mention({ kind: 'k'.repeat(MENTION_BOUNDS.maxKindChars + 1) })])).toEqual([]);
    expect(sanitizeMentionRefsV1([mention({ label: 'l'.repeat(MENTION_BOUNDS.maxLabelChars + 1) })])).toEqual([]);
  });
});

describe('admitMentionRefsV1ForText', () => {
  const text = 'see @src/a.ts and @src/b.ts';

  it('rejects a reference whose range does not match the submitted text, keeping siblings', () => {
    const refs = sanitizeMentionRefsV1([
      mention({ ref: 'file:src/a.ts', token: '@src/a.ts', start: 4, end: 13 }),
      mention({ ref: 'file:src/z.ts', token: '@src/z.ts', start: 18, end: 27 }),
    ]);
    expect(admitMentionRefsV1ForText(text, refs).map((entry) => entry.ref)).toEqual(['file:src/a.ts']);
  });

  it('uses UTF-16 code-unit offsets so a surrogate pair shifts a following reference', () => {
    const emojiText = '\u{1F600} @src/a.ts';
    expect(admitMentionRefsV1ForText(emojiText, sanitizeMentionRefsV1([
      mention({ ref: 'file:src/a.ts', token: '@src/a.ts', start: 3, end: 12 }),
    ]))).toHaveLength(1);
    expect(admitMentionRefsV1ForText(emojiText, sanitizeMentionRefsV1([
      mention({ ref: 'file:src/a.ts', token: '@src/a.ts', start: 2, end: 11 }),
    ]))).toEqual([]);
  });
});

describe('envelope carries mentions additively', () => {
  it('keeps v: 1, sanitizes element-wise and survives a load -> save round trip', () => {
    const envelope = sanitizeHappierStructuredInputV1({
      v: 1,
      mentions: [
        mention({ kind: 'acme.ticket', ref: 'ticket:ACME-1', token: '@ACME-1', start: 0, end: 7 }),
        { kind: 'happier.file', ref: 'not a ref', token: '@b', start: 8, end: 10 },
      ],
    });
    expect(envelope?.v).toBe(1);
    expect(envelope?.mentions?.map((entry) => entry.kind)).toEqual(['acme.ticket']);
    expect(sanitizeHappierStructuredInputV1(envelope)?.mentions).toEqual(envelope?.mentions);
  });

  it('is accepted by the passthrough envelope schema an older reader parses with', () => {
    const parsed = HappierStructuredInputV1EnvelopeSchema.safeParse({
      v: 1,
      mentions: [mention({ ref: 'file:a.ts', token: '@a.ts', start: 0, end: 5 })],
      skillMentions: [{ name: 'review', path: '/skills/review.md' }],
    });
    expect(parsed.success).toBe(true);
  });
});

describe('canonical meta reader and D-4 precedence', () => {
  const bothShapes = {
    happierStructuredInputV1: {
      v: 1,
      mentions: [mention({
        kind: MENTION_KIND_V1.skill,
        ref: buildMentionRefV1('skill', 'vendor:codex:review'),
        token: '$review',
        start: 0,
        end: 7,
      })],
      skillMentions: [{ name: 'review', path: '/skills/review.md' }],
    },
    happierSkillMentions: [{ name: 'review', path: '/skills/review.md' }],
  };

  it('folds the meta-root aliases into the envelope when no mentions are present (SB-9)', () => {
    const envelope = readHappierStructuredInputV1FromMeta({
      happierStructuredInputV1: { v: 1, skillMentions: [{ name: 'review', path: '/skills/review.md' }] },
      happierSkillMentions: [{ name: 'audit', path: '/skills/audit.md' }],
    });
    expect(readStructuredInputMentionSourcesV1(envelope).skillMentions.map((entry) => entry.name))
      .toEqual(['review', 'audit']);
  });

  it('yields exactly one enumerated reference when both shapes are present', () => {
    const sources = readStructuredInputMentionSourcesV1(readHappierStructuredInputV1FromMeta(bothShapes));
    expect(sources.mentions).toHaveLength(1);
    expect(sources.skillMentions).toEqual([]);
    expect(sources.vendorPluginMentions).toEqual([]);
  });

  it('keeps the legacy array on the envelope so an older build still reads it', () => {
    const envelope = readHappierStructuredInputV1FromMeta(bothShapes);
    expect(envelope?.skillMentions).toHaveLength(1);
    expect(readStructuredInputMentionSourcesV1(envelope).skillMentions).toEqual([]);
  });

  it('reads an alias-only message with no envelope at all', () => {
    const envelope = readHappierStructuredInputV1FromMeta({
      happierSkillMentions: [{ name: 'audit', path: '/skills/audit.md' }],
    });
    expect(readStructuredInputMentionSourcesV1(envelope).skillMentions.map((entry) => entry.name))
      .toEqual(['audit']);
  });
});

describe('request admission composes references with the submitted text', () => {
  const meta = {
    happierStructuredInputV1: {
      v: 1,
      mentions: [
        mention({ ref: 'file:src/a.ts', token: '@src/a.ts', start: 4, end: 13 }),
        mention({ ref: 'file:src/z.ts', token: '@src/z.ts', start: 18, end: 27 }),
      ],
    },
  };

  it('rejects the reference whose range does not describe its token', () => {
    const admitted = sanitizeSessionUserMessageSendMeta(meta, { text: 'see @src/a.ts and @src/b.ts' });
    const envelope = admitted.happierStructuredInputV1 as { mentions?: readonly MentionRefV1[] };
    expect(envelope.mentions?.map((entry) => entry.ref)).toEqual(['file:src/a.ts']);
  });

  it('parses metadata independently of the text when no text is supplied', () => {
    const unchecked = sanitizeSessionUserMessageSendMeta(meta);
    expect((unchecked.happierStructuredInputV1 as { mentions?: readonly MentionRefV1[] }).mentions)
      .toHaveLength(2);
  });
});
