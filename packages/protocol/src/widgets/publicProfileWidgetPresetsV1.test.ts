import { describe, expect, it } from 'vitest';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1, PublicProfileSnapshotV1Schema } from '../account/publicProfile.js';
import { projectPublicProfile, validatePublicProfileLayout } from '../account/projectPublicProfile.js';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1 } from '../account/publicProfilePublication.js';
import { createPublicProfileWidgetAreaPresetsV1, PUBLIC_PROFILE_LAYOUT_PRESET_IDS_V1, type PublicProfileLayoutPresetIdV1 } from './publicProfileWidgetPresetsV1.js';
import { compileWidgetAreaPublicProfileLayoutV1 } from './widgetPublicSnapshotPreparationV1.js';
import type { BuiltinUsagePublicPresentationV1 } from './builtinWidgetDescriptorV1.js';
import { resolveHostWidgetAreaPresetsV1 } from './widgetSurfaceArtifactV1.js';
import { WidgetAreaPresetV1Schema } from './widgetSurfaceArtifactV1.js';

const coverage = { status: 'complete_for_supplied_facts', method: 'runtime' } as const;
const snapshot = PublicProfileSnapshotV1Schema.parse({ v: 1, computedAtMs: 10, coverage, fieldCoverage: {},
  period: { startMs: Date.UTC(2026, 6, 8), endMs: Date.UTC(2026, 9, 6), timeZoneOffsetMinutes: 0 },
  facts: { activeDays: 3, peakParallel: 2, calendar: [{ date: '2026-07-08', level: 2 }],
    agentMix: [{ agentId: 'codex', share: 1, coverage }] } });
const context = { handle: 'leeroy', identity: { name: 'Leeroy' }, service: { displayName: 'Happier Cloud', publicBaseUrl: 'https://happier.dev' },
  urls: { page: 'https://happier.dev/@leeroy', json: 'https://happier.dev/v1/public/profiles/leeroy', badgeBase: 'https://happier.dev/@leeroy/badge',
    card: 'https://happier.dev/@leeroy/card.svg', og: 'https://happier.dev/@leeroy/og.png', report: 'mailto:ops@happier.dev' } };
const surface = { serverId: 'home', accountId: 'owner', owner: { kind: 'corePage', pageId: 'public-profile', area: 'main' } } as const;
async function copiedPreset(id: PublicProfileLayoutPresetIdV1, title: (presentation: BuiltinUsagePublicPresentationV1) => string | undefined = () => undefined) {
  const preset = createPublicProfileWidgetAreaPresetsV1({ title }).find(preset => preset.id === id);
  if (!preset) throw new Error('Expected host preset');
  return compileWidgetAreaPublicProfileLayoutV1({ v: 1, surface: { ...surface, owner: { ...surface.owner, layoutId: id } }, items: preset.items }, {
    resolveDefinition: () => null, resolveInstalledView: () => null,
  });
}

describe('public profile layout presets', () => {
  it('compiles private core-page defaults through the public-copy owner', async () => {
    const presets = resolveHostWidgetAreaPresetsV1(surface);
    expect(presets?.map(preset => preset.id)).toEqual(PUBLIC_PROFILE_LAYOUT_PRESET_IDS_V1);
    for (const preset of presets ?? []) {
      const parsed = WidgetAreaPresetV1Schema.parse(preset);
      const copied = await compileWidgetAreaPublicProfileLayoutV1({ v: 1, surface, items: parsed.items }, {
        resolveDefinition: () => null, resolveInstalledView: () => null,
      });
      expect(copied.items).toHaveLength(parsed.items.length);
      expect(copied.items.every(item => item.kind === 'widget' && item.presentation.kind === 'usage')).toBe(true);
    }
  });

  it('offers the approved four starting compositions, Minimal opening with Totals', async () => {
    expect(PUBLIC_PROFILE_LAYOUT_PRESET_IDS_V1).toEqual(['minimal', 'dataRich', 'story', 'nightOwl']);
    const minimal = (await copiedPreset('minimal')).items
      .flatMap(item => item.kind === 'widget' && item.presentation.kind === 'usage' ? [item.presentation.widgetId] : []);
    expect(minimal).toEqual(expect.arrayContaining(['usage_period_summary', 'usage_rhythm', 'usage_breakdowns']));
    expect(minimal.filter(id => id === 'usage_planet').length).toBeLessThanOrEqual(1);
  });

  it('builds Night owl from hours-of-the-week levels, which stay hidden until that item is shared', async () => {
    const layout = validatePublicProfileLayout(await copiedPreset('nightOwl'));
    const hours = layout.items.flatMap(item => item.kind === 'widget' && item.presentation.kind === 'usage'
      && item.presentation.widgetId === 'usage_rhythm' && item.presentation.inputs.style === 'weekdayHour' ? [item.id] : []);
    expect(hours).toHaveLength(1);
    const project = (punch: boolean) => projectPublicProfile({ context, metadata: {}, snapshot, layout, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
      policy: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, punch } } })
      ?.layout.items.map(item => item.id) ?? [];
    expect(project(false)).not.toContain(hours[0]);
    expect(project(true)).toContain(hours[0]);
  });

  it.each(PUBLIC_PROFILE_LAYOUT_PRESET_IDS_V1)('%s is a valid copied layout whose every block survives consent to the items it needs', async id => {
    const layout = validatePublicProfileLayout(await copiedPreset(id, presentation => `title:${presentation.widgetId}`));
    expect(layout.items.length).toBeGreaterThan(0);
    const policy = { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, punch: true } };
    const view = projectPublicProfile({ context, policy, metadata: {}, snapshot, layout,
      appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1 });
    const shown = view?.layout.items.flatMap(item => item.kind === 'widget' ? [item.id] : item.children.map(child => child.id)) ?? [];
    const placed = layout.items.flatMap(item => item.kind === 'widget' ? [item.id] : item.children.map(child => child.id));
    expect(shown).toEqual(placed);
  });

  it('gives every preset at most three planet-art blocks and takes titles from the host', async () => {
    for (const id of PUBLIC_PROFILE_LAYOUT_PRESET_IDS_V1) {
      const layout = await copiedPreset(id, presentation => `title:${presentation.widgetId}`);
      const widgets = layout.items.flatMap(item => item.kind === 'widget' ? [item] : item.children);
      const art = widgets.filter(widget => widget.presentation.kind === 'usage'
        && ['usage_planet', 'usage_orbit', 'usage_constellation'].includes(widget.presentation.widgetId));
      expect(art.length).toBeLessThanOrEqual(3);
      for (const widget of widgets) expect(widget.title).toMatch(/^title:usage_/u);
    }
  });
});
