import { describe, expect, it } from 'vitest';

import {
  LEGACY_SKILL_CATALOG_ORIGINS_V1,
  resolveSkillCatalogItemIdentityV1,
} from './skillCatalogItemIdentityV1.js';
import { SessionSkillCatalogItemV1Schema } from './sessionWorkStateRpc.js';

/**
 * These expectations are a CROSS-REPOSITORY contract, not a local preference. A
 * `happier.skill` reference is persisted and transmitted, so a reference written by one
 * repository must resolve in the other. `../dev` owns the same derivation at
 * `packages/protocol/src/runtime/catalog/skills.ts` and asserts this identical table; if the
 * two ever disagree, every skill mention that crosses builds silently stops resolving.
 */
const IDENTITY_CASES: ReadonlyArray<Readonly<{ label: string; item: Record<string, unknown>; id: string }>> = [
  {
    label: 'a canonical vendor item',
    item: { name: 'review', origin: 'vendor', backendId: 'codex' },
    id: 'vendor:codex:review',
  },
  {
    label: "Codex's legacy origin, folded to the canonical triple",
    item: { name: 'review', origin: 'codex_native', path: '/w/.codex/skills/review/SKILL.md' },
    id: 'vendor:codex:review',
  },
  {
    label: "OpenCode's legacy origin",
    item: { name: 'plan', origin: 'opencode_native' },
    id: 'vendor:opencode:plan',
  },
  {
    label: 'a projected happier skill',
    item: { name: 'triage', origin: 'happier_projected' },
    id: 'happier:happier_projected:triage',
  },
  {
    label: 'an explicit projectionRef winning over the legacy origin',
    item: { name: 'triage', origin: 'happier_projected', projectionRef: 'workflow/triage' },
    id: 'happier:workflow/triage:triage',
  },
  {
    label: 'a provider-supplied id, preserved verbatim',
    item: { id: 'skill-uuid-1', name: 'review', origin: 'codex_native' },
    id: 'skill-uuid-1',
  },
];

describe('resolveSkillCatalogItemIdentityV1', () => {
  it.each(IDENTITY_CASES)('derives $label', ({ item, id }) => {
    expect(resolveSkillCatalogItemIdentityV1(item)?.id).toBe(id);
  });

  it('does not let a machine-local path enter the identity', () => {
    // `path` is the one field Codex hard-requires at dispatch, and the one that goes stale.
    // It is provider context, re-resolved at send time (D-3/INV-9) — never identity.
    const withPath = resolveSkillCatalogItemIdentityV1({
      name: 'review',
      origin: 'codex_native',
      path: '/machine-a/.codex/skills/review/SKILL.md',
    });
    const withoutPath = resolveSkillCatalogItemIdentityV1({ name: 'review', origin: 'codex_native' });
    expect(withPath?.id).toBe(withoutPath?.id);
  });

  it('returns null for an item that cannot be identified', () => {
    expect(resolveSkillCatalogItemIdentityV1({ origin: 'vendor' })).toBeNull();
    expect(resolveSkillCatalogItemIdentityV1({ name: 'review' })).toBeNull();
    expect(resolveSkillCatalogItemIdentityV1({ name: 'review', origin: 'wat' })).toBeNull();
    expect(resolveSkillCatalogItemIdentityV1(null)).toBeNull();
  });

  it('folds every legacy origin the catalog wire schema accepts', () => {
    // One vocabulary, two readers: the schema decides what arrives, this module decides
    // what can be referenced. A legacy origin accepted on the wire but unfoldable here
    // would yield a catalog item no reference could ever resolve to.
    expect(LEGACY_SKILL_CATALOG_ORIGINS_V1.length).toBeGreaterThan(0);
    for (const origin of LEGACY_SKILL_CATALOG_ORIGINS_V1) {
      expect(SessionSkillCatalogItemV1Schema.safeParse({ name: 'review', origin }).success).toBe(true);
      expect(resolveSkillCatalogItemIdentityV1({ name: 'review', origin })).not.toBeNull();
    }
  });

  it('reports the canonical triple alongside the id', () => {
    expect(resolveSkillCatalogItemIdentityV1({ name: 'review', origin: 'codex_native' })).toEqual({
      id: 'vendor:codex:review',
      origin: 'vendor',
      name: 'review',
      backendId: 'codex',
      projectionRef: null,
    });
  });
});
