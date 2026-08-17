import { describe, expect, it } from 'vitest';

import * as runtime from '../index.js';
import { sanitizeHappierStructuredInputV1 } from '../input/structuredInputV1.js';
import { SkillCatalogItemV1Schema, resolveSkillCatalogOriginV1 } from './skills.js';

type SchemaExport = Readonly<{
  safeParse?: (value: unknown) => unknown;
}>;

function readSchemaExport(name: string): SchemaExport | undefined {
  return (runtime as Record<string, unknown>)[name] as SchemaExport | undefined;
}

/**
 * The whole legacy origin vocabulary and the canonical triple each token folds to. Every
 * decision-maker over this vocabulary must reproduce this table — that is what makes it one
 * table rather than several that agree by coincidence.
 */
const LEGACY_SKILL_ORIGIN_FOLD = [
  { origin: 'vendor', triple: { origin: 'vendor', backendId: null, projectionRef: null } },
  { origin: 'happier', triple: { origin: 'happier', backendId: null, projectionRef: null } },
  { origin: 'codex_native', triple: { origin: 'vendor', backendId: 'codex', projectionRef: null } },
  { origin: 'opencode_native', triple: { origin: 'vendor', backendId: 'opencode', projectionRef: null } },
  { origin: 'claude_native', triple: { origin: 'vendor', backendId: 'claude', projectionRef: null } },
  { origin: 'pi_native', triple: { origin: 'vendor', backendId: 'pi', projectionRef: null } },
  { origin: 'happier_projected', triple: { origin: 'happier', backendId: null, projectionRef: 'happier_projected' } },
  { origin: 'text_fallback_only', triple: { origin: 'happier', backendId: null, projectionRef: 'text_fallback_only' } },
] as const;

/**
 * Tokens no producer has ever emitted. `cursor_native` and `gemini_native` matter most: they
 * fit the `<backendId>_native` shape, so a decision-maker that pattern-matches the suffix
 * instead of reading the table invents `vendor` for a skill the catalog schema refuses to
 * admit at all.
 */
const UNRECOGNIZED_SKILL_ORIGINS = ['cursor_native', 'gemini_native', 'derived', 'wat'] as const;

function readTriple(value: Record<string, unknown> | null | undefined) {
  return {
    origin: (value?.origin as string | undefined) ?? null,
    backendId: (value?.backendId as string | undefined) ?? null,
    projectionRef: (value?.projectionRef as string | undefined) ?? null,
  };
}

function sanitizeSkillMention(origin: unknown): Record<string, unknown> | null {
  const envelope = sanitizeHappierStructuredInputV1({
    v: 1,
    skillMentions: [{ name: 'review', path: '/skills/review/SKILL.md', origin }],
  });
  return (envelope?.skillMentions?.[0] as Record<string, unknown> | undefined) ?? null;
}

describe('runtime catalog protocol contracts', () => {
  it('folds every legacy skill origin into the canonical triple, from one owner', () => {
    // The single owner of the legacy origin table: the catalog schema below,
    // the composer's catalog reader and the composer's envelope writer all
    // consume this, so a drifted copy can no longer canonicalize the read and
    // write halves of one round trip differently.
    expect(typeof (runtime as Record<string, unknown>).resolveSkillCatalogOriginV1).toBe('function');
    expect(resolveSkillCatalogOriginV1('vendor')).toEqual({ origin: 'vendor' });
    expect(resolveSkillCatalogOriginV1('happier')).toEqual({ origin: 'happier' });
    expect(resolveSkillCatalogOriginV1('codex_native')).toEqual({ origin: 'vendor', backendId: 'codex' });
    expect(resolveSkillCatalogOriginV1('opencode_native')).toEqual({ origin: 'vendor', backendId: 'opencode' });
    expect(resolveSkillCatalogOriginV1('claude_native')).toEqual({ origin: 'vendor', backendId: 'claude' });
    expect(resolveSkillCatalogOriginV1('pi_native')).toEqual({ origin: 'vendor', backendId: 'pi' });
    expect(resolveSkillCatalogOriginV1('happier_projected'))
      .toEqual({ origin: 'happier', projectionRef: 'happier_projected' });
    expect(resolveSkillCatalogOriginV1('text_fallback_only'))
      .toEqual({ origin: 'happier', projectionRef: 'text_fallback_only' });
    // An unrecognized or absent origin contributes nothing, so a caller's own
    // backendId/projectionRef are never overwritten by a guess.
    expect(resolveSkillCatalogOriginV1('cursor_native')).toEqual({});
    expect(resolveSkillCatalogOriginV1(undefined)).toEqual({});
    expect(resolveSkillCatalogOriginV1('  ')).toEqual({});
  });

  it('synthesizes a catalog item id from the folded triple for a legacy item', () => {
    expect(readSchemaExport('SkillCatalogItemV1Schema')?.safeParse?.({
      name: 'debugger',
      origin: 'codex_native',
      path: '/skills/debugger/SKILL.md',
    })).toMatchObject({
      success: true,
      data: expect.objectContaining({
        id: 'vendor:codex:debugger',
        origin: 'vendor',
        backendId: 'codex',
      }),
    });
    expect(readSchemaExport('SkillCatalogItemV1Schema')?.safeParse?.({
      name: 'team-style',
      origin: 'text_fallback_only',
    })).toMatchObject({
      success: true,
      data: expect.objectContaining({
        id: 'happier:text_fallback_only:team-style',
        origin: 'happier',
        projectionRef: 'text_fallback_only',
      }),
    });
  });

  it('folds a legacy origin identically on the catalog and envelope halves of one round trip', () => {
    // A skill the composer offers came through the catalog schema; the mention it writes is
    // read back through the envelope sanitizer. If those two fold the same token differently
    // the round trip loses `backendId`/`projectionRef` — and with them the identity a
    // `happier.skill` reference resolves by (D-23).
    for (const { origin, triple } of LEGACY_SKILL_ORIGIN_FOLD) {
      const catalogItem = SkillCatalogItemV1Schema.parse({ name: 'review', origin, path: '/skills/review/SKILL.md' });
      expect({ origin, ...readTriple(catalogItem as Record<string, unknown>) }).toEqual({ origin, ...triple });
      expect({ origin, ...readTriple(sanitizeSkillMention(origin)) }).toEqual({ origin, ...triple });
    }
  });

  it('never invents a canonical origin for a token the catalog schema refuses', () => {
    for (const origin of UNRECOGNIZED_SKILL_ORIGINS) {
      expect({ origin, accepted: SkillCatalogItemV1Schema.safeParse({ v: 1, name: 'review', origin }).success })
        .toEqual({ origin, accepted: false });
      // The mention survives — a user selected this skill and `name`/`path` are what every
      // provider consumer reads — but the unreadable origin is dropped rather than guessed at.
      expect({ origin, mention: readTriple(sanitizeSkillMention(origin)) })
        .toEqual({ origin, mention: { origin: null, backendId: null, projectionRef: null } });
      expect(sanitizeSkillMention(origin)).toMatchObject({ name: 'review', path: '/skills/review/SKILL.md' });
    }
  });

  it('exports vendor plugin and skill catalog schemas from the runtime package', () => {
    expect(typeof readSchemaExport('VendorPluginCatalogItemV1Schema')?.safeParse).toBe('function');
    expect(typeof readSchemaExport('VendorPluginCatalogV1Schema')?.safeParse).toBe('function');
    expect(typeof readSchemaExport('SkillCatalogItemV1Schema')?.safeParse).toBe('function');
    expect(typeof readSchemaExport('SkillCatalogV1Schema')?.safeParse).toBe('function');
  });

  it('parses canonical vendor plugin and skill catalog item metadata', () => {
    const vendorPluginItemSchema = readSchemaExport('VendorPluginCatalogItemV1Schema');
    const skillItemSchema = readSchemaExport('SkillCatalogItemV1Schema');

    expect(vendorPluginItemSchema?.safeParse?.({
      v: 1,
      backendId: 'codex',
      agentId: 'codex-agent',
      vendorPluginRef: 'plugin://gmail@openai-curated',
      displayName: 'Gmail',
      installed: true,
      enabled: true,
    })).toMatchObject({
      success: true,
      data: expect.objectContaining({
        backendId: 'codex',
        agentId: 'codex-agent',
        mentionable: true,
      }),
    });

    expect(skillItemSchema?.safeParse?.({
      v: 1,
      id: 'codex:review',
      origin: 'vendor',
      name: 'review',
      backendId: 'codex',
      agentId: 'codex-agent',
      projectionRef: 'codex-native:review',
    })).toMatchObject({
      success: true,
      data: expect.objectContaining({
        origin: 'vendor',
        backendId: 'codex',
        agentId: 'codex-agent',
        projectionRef: 'codex-native:review',
      }),
    });
  });
});
