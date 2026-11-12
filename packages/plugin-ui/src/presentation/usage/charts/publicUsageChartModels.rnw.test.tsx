import { describe, expect, it } from 'vitest';
import { PublicProfileUsageBody } from '../../account/PublicProfileUsage.js';
import type { PublicProfileSnapshotV1 } from '@happier-dev/plugin-sdk';
import * as components from '../../../components/index.public.js';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { renderSurface, publicSnapshotTemplate } from '../../../../fixtures/external-authoring/src/usageChartsSurface.js';
import { act } from 'react';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { PublicProfileLayoutV1Schema } from '@happier-dev/protocol/widgets/widgetPublicSnapshotV1';
import * as publicSnapshotPreparation from '@happier-dev/protocol/widgets';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1 } from '@happier-dev/protocol/account/publicProfile';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { projectPublicProfile, projectPublicProfileSnapshot } from '@happier-dev/protocol/account/projectPublicProfile';
import { projectPluginPortableUiDeclarationsV1 } from '@happier-dev/protocol/plugins/contributions/ui/declarationProjection';
import { externalAuthoringPlugin } from '../../../../fixtures/external-authoring/src/index.js';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';

const base: PublicProfileSnapshotV1 = {
  v: 1, computedAtMs: 1, period: { startMs: Date.UTC(2026, 8, 1), endMs: Date.UTC(2026, 8, 8), timeZoneOffsetMinutes: 0 },
  coverage: { status: 'partial', method: 'runtime' }, fieldCoverage: {}, facts: {},
};

describe('public Usage chart producer', () => {
  it('renders public River weeks with unreported and empty shares alongside reported agents', async () => {
    const fixture = await createPluginUiTestkit({ identity: { instanceId: 'river', mountNonce: 'river' },
      surface: defineUiSurface(() => <PublicProfileUsageBody
        presentation={{ kind: 'usage', widgetId: 'usage_flow', inputs: {} }}
        models={{ ...components.projectPublicUsageChartModels(base), river: { width: 'share', weeks: [
          { start: 'First', end: 'Last', partial: false, total: null, shares: null },
          { start: 'Empty', end: 'End', partial: false, total: 0, shares: [] },
          { start: 'Reported', end: 'End', partial: false, total: 1, shares: [{ agentId: 'codex', share: 1 }] },
        ] } }} records={null} width={720} testID="public-river"
        host={{ paint: { accent: '#007aff', paper: '#fff', dark: false },
          agent: id => ({ id, name: 'Codex', color: '#2a78d6' }),
          labels: { chartLabel: () => 'Flow', unavailable: 'Unavailable', river: {
            week: String, partialWeek: String, inline: (name, share) => name + ' ' + share, caption: 'River', unknownAgent: 'Unknown',
            values: { show: 'Values', hide: 'Hide', weekColumn: 'Week', totalColumn: 'Total', formatTotal: String, percent: String },
          } } }} />),
      surfaceContext: createSurfaceContextFixture({ locale: 'en-GB' }), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction: async () => null } });
    try {
      expect(document.querySelector('[data-testid="public-river"]')).not.toBeNull();
      expect(document.body.textContent).toContain('Codex');
      expect(document.body.textContent).not.toContain('Unavailable');
    } finally { await fixture.dispose(); }
  });

  it('keeps shared unavailable summary figures distinct from witnessed zero and hidden figures', () => {
    const projected = projectPublicProfileSnapshot({ ...base, facts: { tokens: 0, activeDays: 3, peakParallel: 99 },
      fieldCoverage: { tokens: base.coverage, activeDays: base.coverage, agentTime: base.coverage,
        mergedPrs: { status: 'unavailable', method: 'unknown' }, currentStreak: base.coverage,
        bestStreak: base.coverage, peakParallel: base.coverage } }, {
      ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields,
        tokens: true, activeDays: true, agentTime: true, mergedPrs: true, currentStreak: true, bestStreak: true, peakParallel: false },
    });
    expect(components.projectPublicUsageChartModels(projected).summary).toEqual({ tokens: 0, activeDays: 3,
      agentTimeMs: null, mergedPrs: null, currentStreakDays: null, bestStreakDays: null });
    expect(projected.fieldCoverage).not.toHaveProperty('peakParallel');
  });
  it('produces period-sized planet calendars, clipped ordinal weeks and independently disclosed moons', () => {
    const models = components.projectPublicUsageChartModels({ ...base, facts: {
      calendar: [{ date: '2026-09-01', level: 4 }, { date: '2026-09-02', level: 0 }], currentStreakDays: 0,
      agentMix: [{ agentId: 'codex', share: 1, coverage: base.coverage }],
    } });
    expect(models.calendarArt?.days).toHaveLength(7);
    expect(models.calendarArt?.days[2]).toEqual({ date: '2026-09-03', level: null });
    expect(models.calendarArt?.currentStreakDays).toBe(0);
    expect(models.calendarArt).not.toHaveProperty('bestStreakDays');
    expect(models.moons).toEqual({ agents: [{ agentId: 'codex', share: 1 }], periodDays: 7 });
    expect(models.moons?.agents[0]).not.toHaveProperty('activeDays');
    expect(models.atmosphere).toBeNull();
    expect(models.machines).toEqual({ kinds: null, coverage: { status: 'unavailable', method: 'unknown' } });
    const withoutCalendar = components.projectPublicUsageChartModels({ ...base, facts: { activeDays: 7, bestStreakDays: 7 } });
    expect(withoutCalendar.calendarArt).toBeNull();
  });
  it('preserves actual weekly peaks, unavailable kinds and SCM-admitted links without derived private facts', () => {
    const weeklyPeakParallel = [{ startMs: base.period.startMs, endMs: base.period.endMs, peak: 3, coverage: base.coverage }];
    const models = components.projectPublicUsageChartModels({ ...base, fieldCoverage: { machineKinds: base.coverage }, facts: {
      peakParallel: 3, weeklyPeakParallel, agentActiveDays: [{ agentId: 'claude', days: 2, coverage: base.coverage }],
      machineKinds: [{ kind: 'unknown', count: 2, agentTimeShare: 1, coverage: base.coverage }],
      sessionDurations: [{ agentId: 'codex', durationMs: 12 }],
    } }, { projects: [{ label: 'Public project', url: 'https://example.com/project' }] });
    expect(models.atmosphere).toEqual({ weeks: weeklyPeakParallel, peakParallel: 3 });
    expect(models.moons).toEqual({ agents: [{ agentId: 'claude', share: null, activeDays: 2 }], periodDays: 7 });
    expect(models.projects).toEqual({ links: [{ label: 'Public project', url: 'https://example.com/project' }] });
    expect(models.machines.kinds).toEqual([{ kind: 'unknown', count: 2, agentTimeShare: 1, coverage: base.coverage }]);
    expect(models.galaxy).toEqual(models.runLength);
  });
  it('feeds original forms independently admitted scalars and aggregate coverage without inventing private detail', () => {
    const models = components.projectPublicUsageChartModels({ ...base, facts: {
      activeDays: 0, mergedPrs: 0, agentTimeMs: 60000,
      footprint: { status: 'insufficient_basis', reason: 'no_applicable_versioned_method' },
      sourceSplit: [{ execution: 'unknown', share: 1 }],
    } });
    expect(models.summary).toEqual({ activeDays: 0, mergedPrs: 0, agentTimeMs: 60000 });
    expect(models.coverage).toEqual(base.coverage);
    expect(models.footprint).toEqual({});
    expect(models.sourceShares).toEqual([{ execution: 'unknown', share: 1 }]);
    expect(models.agentMix).toBeNull();
    expect(models.summary).not.toHaveProperty('tokens');
    expect(models.sky).toBeNull();
  });
  it('admits the external inert template and renders only its policy-projected shared fact', async () => {
    const entries = projectPluginPortableUiDeclarationsV1(PluginManifestV2Schema.parse(externalAuthoringPlugin.manifest));
    const selected = Object.values(entries).find(entry => entry.contributionKind === 'surfacePlacement'
      && entry.binding?.kind === 'inline' && entry.binding.role === 'widget'
      && entry.binding.surface.localId === 'external-public-chart');
    expect(selected?.publicPresentation).toEqual(publicSnapshotTemplate);
    if (!selected || selected.binding?.kind !== 'inline') throw new Error('Expected installed public widget selection');
    const surface = selected.binding.surface;
    const layout = await publicSnapshotPreparation.compileWidgetAreaPublicProfileLayoutV1({ v: 1,
      surface: { serverId: 'garden', accountId: 'owner', owner: { kind: 'corePage', pageId: 'public-profile', area: 'main' } },
      items: [{ kind: 'widget', instance: { v: 1, id: 'external-copy',
        definition: { kind: 'installed', surface }, bindings: {} }, size: 'medium', frameStyle: 'card' }] }, {
      resolveDefinition: async () => null,
      resolveInstalledView: async candidate => candidate.localId === surface.localId
        ? { ...selected, title: 'An external block' } : null,
    });
    expect(PublicProfileLayoutV1Schema.parse(layout)).toMatchObject({ items: [{ presentation: publicSnapshotTemplate }] });
    const view = projectPublicProfile({ context: { handle: 'garden', identity: {}, service: { displayName: 'Garden service', publicBaseUrl: 'https://garden.example' },
      urls: { page: 'https://garden.example/@garden', json: 'https://garden.example/v1/public/profiles/garden', badgeBase: 'https://garden.example/@garden/badge',
        card: 'https://garden.example/@garden/card.svg', og: 'https://garden.example/@garden/og.png', report: 'mailto:operator@garden.example' } },
      snapshot: { ...base, facts: { activeDays: 2, tokens: 87654321 } }, metadata: {}, layout, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
      policy: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, tokens: false } } });
    if (!view) throw new Error('Expected admitted public edition');
    const fixture = await createPluginUiTestkit({ identity: { instanceId: 'public-template', mountNonce: 'public-template' },
      surface: defineUiSurface(() => <components.HappierPublicProfile view={view} labels={{ identityLine: 'Garden service', periodTitle: 'This week',
        periodDetail: 'Shared facts', emptyLayout: 'No blocks', footerNote: 'Synced, not certified', report: 'Report', madeWith: 'Made with Happier',
        inert: { success: 'Success', warning: 'Warning', error: 'Error', incomplete: 'More' } }} />),
      surfaceContext: createSurfaceContextFixture({ locale: 'en-GB' }), adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: { executeAction: async () => null } });
    try {
      expect(document.querySelector('[data-testid="public-profile-block-external-copy"]')?.textContent).toBe('An external block2');
      expect(document.body.textContent).not.toContain('87654321');
      expect(JSON.stringify(view)).not.toContain('87654321');
    } finally { await fixture.dispose(); }
  });
  it('mounts an external unrelated dataset through public components and discloses its actual values', async () => {
    const fixture = await createPluginUiTestkit({ identity: { instanceId: 'harvest', mountNonce: 'harvest' },
      surface: renderSurface, surfaceContext: createSurfaceContextFixture({ locale: 'en-GB' }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: { executeAction: async () => null } });
    try {
      expect(document.querySelector('[data-testid="external-harvest"]')?.textContent).toContain('Tomatoes');
      const daily = document.querySelector('[data-testid="external-harvest-daily.chart"]');
      expect(daily?.getAttribute('aria-label')).toContain('Monday: Vegetables 42');
      expect(daily?.getAttribute('aria-label')).toContain('Tuesday: Vegetables —');
      const button = document.querySelector<HTMLElement>('[data-testid="external-harvest-hours-values-toggle"]')!;
      act(() => button.click());
      const values = document.querySelector('[data-testid="external-harvest-hours-values"]')?.textContent;
      expect(values).toContain('42 vegetables');
      expect(values).toContain('—');
      expect(values).not.toContain('tokens');
    } finally { await fixture.dispose(); }
  });
  it('uses only shared ordinal facts, and does not reconstruct hidden streak or width denominators', () => {
    const models = components.projectPublicUsageChartModels({ ...base, facts: {
      currentStreakDays: 3, calendar: [{ date: '2026-09-01', level: 4 }, { date: '2026-09-02', level: null }, { date: '2026-09-03', level: 0 }],
      weeklyAgentMix: [{ startMs: base.period.startMs, endMs: base.period.endMs,
        mix: [{ agentId: 'codex', share: 0.75, coverage: { status: 'partial', method: 'runtime' } }] }],
    } });
    expect(models.sky).toEqual({ encoding: 'ordinal', colourBy: 'intensity', days: [
      { date: '2026-09-01', state: 'active', level: 4 }, { date: '2026-09-02', state: 'unknown' }, { date: '2026-09-03', state: 'inactive' },
    ], current: { days: 3 } });
    expect(models.portrait).toEqual({ streak: { current: 3, best: null } });
    expect(models.river).toMatchObject({ width: 'share', weeks: [{ start: '2026-09-01', end: '2026-09-07', partial: true,
      total: null, shares: [{ agentId: 'codex', share: 0.75 }] }] });
    expect(models.peak).toBeNull();
    expect(models.runLength).toBeNull();
  });

  it('retains measured zero, missing cells, context-only membership and anonymous duration multiplicity', () => {
    const models = components.projectPublicUsageChartModels({ ...base, facts: {
      peakParallel: 0, mergedPrs: 0,
      agentMix: [{ agentId: 'codex', share: 0.6, coverage: { status: 'partial', method: 'runtime' } },
        { agentId: 'claude', share: 0.4, coverage: { status: 'unknown', method: 'context_only' } }],
      punch: [{ weekday: 0, hour: 4, level: 3 }, { weekday: 1, hour: 4, level: null }],
      sessionDurations: [{ agentId: 'codex', durationMs: 10 }, { agentId: 'codex', durationMs: 10 }, { agentId: 'codex', durationMs: 70 }],
    } });
    expect(models.agentShares).toEqual([{ agentId: 'codex', share: 0.6 }, { agentId: 'claude', share: null }]);
    expect(models.constellation).toEqual({ nodes: models.agentShares, edges: null, unknownStarts: null });
    expect(models.weekHours?.grid[6]?.[4]).toBe(3);
    expect(models.weekHours?.grid[0]?.[4]).toBeNull();
    expect(models.weekHours?.grid[0]?.[5]).toBeNull();
    expect(models.shipped).toEqual({ mode: 'count', total: 0 });
    expect(models.peak).toBe(0);
    expect(models.runLength).toEqual({ openCount: null, croppedCount: null, rows: [
      { agentId: 'codex', samples: 3, durationsMs: [10, 10, 70], medianMs: 10, p90Ms: 70 },
    ] });
  });

  it('does not infer per-hour activity or a streak from separately shared aggregate totals', () => {
    const models = components.projectPublicUsageChartModels({ ...base, facts: { tokens: 999999, activeDays: 4,
      bestStreakDays: 12, dayNightActivity: { window: { startHour: 22, endHour: 6 }, dayShare: 0.75, nightShare: 0.25,
        coverage: { status: 'partial', method: 'runtime' } } } });
    expect(models.sky).toBeNull();
    expect(models.weekHours).toBeNull();
    expect(models.daylight).toEqual({ encoding: 'ordinal', hours: Array(24).fill(null), night: { fromHour: 22, toHour: 6, share: 0.25 } });
    expect(models.portrait.streak).toBeUndefined();
    expect(models.agentShares).toBeNull();
    expect(models.river).toBeNull();
  });

  it('keeps independently shared Agent active days when Agent mix itself is off', () => {
    const models = components.projectPublicUsageChartModels({ ...base, facts: { agentActiveDays: [
      { agentId: 'codex', days: 2, coverage: { status: 'partial', method: 'runtime' } },
    ] } });
    expect(models.agentShares).toEqual([{ agentId: 'codex', share: null, activeDays: 2 }]);
  });
  it('keeps Moons phases neutral under default consent even when the producer knows Agent days', () => {
    const projected = projectPublicProfileSnapshot({ ...base, facts: { activeDays: 5,
      agentMix: [{ agentId: 'codex', share: 1, coverage: base.coverage }],
      agentActiveDays: [{ agentId: 'codex', days: 2, coverage: base.coverage }],
    } }, DEFAULT_PUBLIC_PROFILE_POLICY_V1);
    const moons = components.projectPublicUsageChartModels(projected).moons;
    expect(moons).toEqual({ agents: [{ agentId: 'codex', share: 1 }], periodDays: 7 });
    expect(JSON.stringify(moons)).not.toContain('activeDays');
  });

  it('formats public Personal records from the independently shared scalars, without private record positions', () => {
    const records = components.projectPublicUsageRecords({ ...base, facts: { activeDays: 2, currentStreakDays: 1,
      sessionDurations: [{ agentId: 'codex', durationMs: 20 }, { agentId: 'claude', durationMs: 60 }] } },
    (kind, value) => ({ title: kind, detail: 'Within the shared period', value: String(value) }));
    expect(records).toEqual([
      { id: 'activeDays', title: 'activeDays', detail: 'Within the shared period', value: '2' },
      { id: 'currentStreakDays', title: 'currentStreakDays', detail: 'Within the shared period', value: '1' },
      { id: 'longestTurnMs', title: 'longestTurnMs', detail: 'Within the shared period', value: '60' },
    ]);
  });
});
