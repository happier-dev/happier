import { describe, expect, it } from 'vitest';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1, PublicProfileSnapshotV1Schema } from '@happier-dev/protocol/account/publicProfile';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, PublicProfileOwnerRecordV1Schema, type PublicProfileLayoutV1, type PublicProfileOwnerRecordV1 } from '@happier-dev/protocol/account/publicProfilePublication';

import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { ScmCredentialFreeRepositorySelectorV1Schema } from '@happier-dev/protocol/scm/repositoryClone';

import { createPublicProfileDraft, draftLookPresentation, draftVisitorTheme, publicProfileDraftQuery, resolvePublicFieldPlacements, resolvePublicProfileDraftChanges, setPublicProfileDraftField,
  setPublicProfileDraftTheme } from './publicProfileDraft';

const coverage = { status: 'complete_for_supplied_facts', method: 'runtime' } as const;
const snapshot = PublicProfileSnapshotV1Schema.parse({ v: 1, computedAtMs: 10, coverage, fieldCoverage: {},
  period: { startMs: Date.UTC(2026, 6, 8), endMs: Date.UTC(2026, 9, 6), timeZoneOffsetMinutes: 0 },
  facts: { activeDays: 3, calendar: [{ date: '2026-07-08', level: 2 }], agentMix: [{ agentId: 'codex', share: 1, coverage }], punch: [] } });
const context = { handle: 'leeroy', identity: { name: 'Leeroy' }, service: { displayName: 'Happier Cloud', publicBaseUrl: 'https://happier.dev' },
  urls: { page: 'https://happier.dev/@leeroy', json: 'https://happier.dev/v1/public/profiles/leeroy', badgeBase: 'https://happier.dev/@leeroy/badge',
    card: 'https://happier.dev/@leeroy/card.svg', og: 'https://happier.dev/@leeroy/og.png', report: 'mailto:ops@happier.dev' } };
const layout: PublicProfileLayoutV1 = { v: 1, items: [
  { kind: 'widget', id: 'days', size: 'full', frameStyle: 'plain', presentation: { kind: 'usage', widgetId: 'usage_rhythm', inputs: { style: 'sky' } } },
  { kind: 'widget', id: 'tide', size: 'medium', frameStyle: 'plain', presentation: { kind: 'usage', widgetId: 'usage_rhythm', inputs: { style: 'weekTide' } } },
] };
const record = (overrides: Partial<PublicProfileOwnerRecordV1> = {}) => PublicProfileOwnerRecordV1Schema.parse({
  state: 'published', policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1, metadata: {}, projectSelections: [], query: null, snapshot,
  layout, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, updatedAtMs: 1, publishedAtMs: 1, restriction: null, ...overrides,
});

describe('public profile draft', () => {
  it('counts every field used by multi-field and repeated blocks without walking snapshot facts', () => {
    const presentations = [
      { kind: 'usage', widgetId: 'usage_period_summary', inputs: {} },
      { kind: 'usage', widgetId: 'usage_planet', inputs: {} },
      { kind: 'usage', widgetId: 'usage_recap', inputs: { style: 'personalRecords' } },
      { kind: 'usage', widgetId: 'usage_period_summary', inputs: {} },
    ] as const;
    const placed: PublicProfileLayoutV1 = { v: 1, items: presentations.map((presentation, i) => ({
      kind: 'widget', id: `block-${i}`, size: 'medium', frameStyle: 'plain', presentation,
    })) };
    let factReads = 0;
    const observed = { ...snapshot, get facts() { factReads++; return { ...snapshot.facts, tokens: 123 }; } };
    const draft = createPublicProfileDraft(record({ layout: placed }), { layout: placed });
    const placements = resolvePublicFieldPlacements({ context, snapshot: observed, draft });
    expect(placements.tokens.blocks).toBe(2);
    expect(placements.activeDays.blocks).toBe(4);
    expect(placements.peakParallel.blocks).toBe(4);
    expect(placements.highlights.blocks).toBe(1);
    expect(factReads).toBe(0);
  });
  it('places identity items shown in the page heading there, not only in badges and JSON', () => {
    const draft = createPublicProfileDraft(record({ metadata: { bio: 'Building Happier.' } }), { layout });
    const placements = resolvePublicFieldPlacements({ context: { ...context, identity: { name: 'Leeroy', sinceMs: 1 } }, snapshot, draft });
    expect(placements.name.heading).toBe(true);
    expect(placements.since.heading).toBe(true);
    expect(placements.bio.heading).toBe(true);
    // No photo or links exist to show, so they cannot be in the heading.
    expect(placements.avatar.heading).toBe(false);
    expect(placements.links.heading).toBe(false);
    expect(placements.tokens.heading).toBe(false);
    // The explained planet fallback stands in for a missing photo beside the name.
    const planet = resolvePublicFieldPlacements({ context: { ...context, identity: { name: 'Leeroy',
      avatar: { kind: 'planet', reason: 'account_image_unavailable' } } }, snapshot, draft });
    expect(planet.avatar.heading).toBe(true);
  });
  it('starts a first publication from the default consent, the given preset and a candidate planet look', () => {
    const draft = createPublicProfileDraft(null, { layout });
    expect(draft.policy).toEqual(DEFAULT_PUBLIC_PROFILE_POLICY_V1);
    expect(draft.layout).toBe(layout);
    expect(draft.appearance.kind).toBe('candidate');
    expect(resolvePublicProfileDraftChanges(null, draft)).toEqual({ policy: true, layout: true, appearance: true, metadata: false, period: true });
  });

  it('keeps the applied edition until a member actually changes, then names only that member', () => {
    const applied = record();
    const draft = createPublicProfileDraft(applied, { layout: { v: 1, items: [] } });
    expect(draft.layout).toEqual(layout);
    expect(draft.appearance).toEqual({ kind: 'applied', value: applied.appearance });
    expect(resolvePublicProfileDraftChanges(applied, draft)).toEqual({ policy: false, layout: false, appearance: false, metadata: false, period: false });
    const hidden = setPublicProfileDraftField(draft, 'calendar', false);
    expect(hidden.policy.fields.calendar).toBe(false);
    expect(draft.policy.fields.calendar).toBe(true);
    expect(resolvePublicProfileDraftChanges(applied, hidden)).toEqual({ policy: true, layout: false, appearance: false, metadata: false, period: false });
    expect(resolvePublicProfileDraftChanges(applied, setPublicProfileDraftField(hidden, 'calendar', true)).policy).toBe(false);
  });

  it('keeps the chosen private Look when Unpublish removes the server edition', () => {
    const appearance = { atmosphere: { source: 'planet', planet: { placement: 'rise', style: 'rich', digits: true } }, theme: 'dark' } as const;
    const applied = record({ appearance });
    const draft = createPublicProfileDraft(applied, { layout });
    expect(draftLookPresentation(draft)).toMatchObject(appearance.atmosphere);
    expect(draftVisitorTheme(draft)).toBe('dark');
    expect(draftVisitorTheme(setPublicProfileDraftTheme(draft, 'light'))).toBe('light');
    expect(resolvePublicProfileDraftChanges(null, draft).appearance).toBe(true);
    // A different Session's edition cannot silently replace the Look this private draft shows.
    expect(resolvePublicProfileDraftChanges(record({ appearance: { atmosphere: { source: 'none' }, theme: 'auto' } }), draft).appearance).toBe(true);
  });

  it('says which items show in blocks, are placed but private, or only reach badges and JSON', () => {
    const draft = createPublicProfileDraft(record(), { layout });
    const placements = resolvePublicFieldPlacements({ context, snapshot, draft });
    expect(placements.calendar).toEqual({ shown: true, blocks: 1, heading: false });
    // Hours of the week is placed (Week tide) but not shared: only the owner sees it.
    expect(placements.punch).toEqual({ shown: false, blocks: 1, heading: false });
    // Active days is shared but no placed block needs it: it reaches badges and JSON only.
    expect(placements.activeDays).toEqual({ shown: true, blocks: 0, heading: false });
    expect(placements.machineKinds).toEqual({ shown: false, blocks: 0, heading: false });
  });

  it('carries the page period, its words and repositories, and the visitor theme as reviewed members of the one draft', () => {
    const selection = ScmCredentialFreeRepositorySelectorV1Schema.parse({ provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
      repository: { nameWithOwner: 'happier-dev/happier', webUrl: 'https://github.com/happier-dev/happier', visibility: 'public' }, protocol: 'https' });
    const applied = record({ query: normalizeUsageQuery({ period: { relative: '30days' } }),
      metadata: { bio: 'Building Happier.', projects: [{ label: 'happier-dev/happier', url: 'https://github.com/happier-dev/happier' }] },
      projectSelections: [selection] });
    const draft = createPublicProfileDraft(applied, { layout: { v: 1, items: [] } });
    // Projects are sent as the repositories chosen, never as the links the host derived from them.
    expect(draft.metadata).toEqual({ bio: 'Building Happier.', projectSelections: [selection] });
    expect(draft.period).toBe('30days');
    expect(publicProfileDraftQuery(draft)).toEqual({ period: { relative: '30days' } });
    const edited = { ...setPublicProfileDraftTheme(draft, 'dark'), period: 'year' as const,
      metadata: { ...draft.metadata, bio: 'Steering agents from a phone.' } };
    expect(draftVisitorTheme(edited)).toBe('dark');
    expect(resolvePublicProfileDraftChanges(applied, edited)).toEqual({ policy: false, layout: false, appearance: true, metadata: true, period: true });
    // Choosing the applied theme again is no change.
    expect(resolvePublicProfileDraftChanges(applied, setPublicProfileDraftTheme(draft, 'auto')).appearance).toBe(false);
  });
});
