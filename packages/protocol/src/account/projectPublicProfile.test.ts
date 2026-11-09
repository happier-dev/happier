import { describe, expect, it } from 'vitest';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1, PublicProfileSnapshotV1Schema, PublicProfileSnapshotV1StoredSchema,
  PublicProfilePolicyV1StoredSchema, type PublicProfileSnapshotV1 } from './publicProfile.js';
import { createPublicProfileProjector, projectPublicProfile, projectPublicProfileIdentity, projectPublicProfilePreview, projectPublicProfileSnapshot } from './projectPublicProfile.js';
import { PublicProfileLayoutV1Schema, PublicProfileLayoutV1StoredSchema, WidgetPublicSnapshotDocumentV1Schema } from '../widgets/widgetPublicSnapshotV1.js';
import { PublicProfileContextV1Schema, PublicProfileViewV1Schema } from './publicProfilePublication.js';
import { zodSchemaToJsonSchemaObject } from '../actions/actionInputJsonSchema.js';
import { PluginJsonSchemaV2Schema } from '../plugins/contributions/jsonSchema.js';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '../plugins/actions/jsonSchemaValidation.js';

const coverage = { status: 'partial', method: 'mixed' } as const;
const facts = { tokens: 87654321, activeDays: 17, peakParallel: 6,
  agentMix: [{ agentId: 'codex', share: 1, tokens: 87654321, coverage }],
  sourceSplit: [{ execution: 'outside', share: 1, tokens: 87654321 }],
  weeklyAgentMix: [{ startMs: 1, endMs: 7, mix: [{ agentId: 'codex', share: 1, coverage }] }],
  weeklyPeakParallel: [{ startMs: 1, endMs: 7, peak: 6, coverage }],
  highlights: [{ kind: 'active_days', count: 17 }, { kind: 'peak_parallel', count: 6 }],
} as const;
const snapshot: PublicProfileSnapshotV1 = PublicProfileSnapshotV1Schema.parse({ v: 1, computedAtMs: 10,
  period: { startMs: 1, endMs: 9, timeZoneOffsetMinutes: 0 }, coverage,
  facts, fieldCoverage: { tokens: coverage, activeDays: coverage, agentMix: coverage },
  lenses: [{ execution: 'outside', facts }],
});
describe('public-profile disclosure projection', () => {
  it('carries the chosen relative period to strict public and local views without inferring it from the date range', () => {
    const context = { handle: 'person', identity: {}, service: { displayName: 'Service', publicBaseUrl: 'https://example.com' },
      urls: { page: 'https://example.com/@person', json: 'https://example.com/v1/public/profiles/person',
        badgeBase: 'https://example.com/@person/badge', card: 'https://example.com/@person/card.svg',
        og: 'https://example.com/@person/og.png', report: 'mailto:operator@example.com' } };
    const input = { context, metadata: {}, snapshot, layout: { v: 1 as const, items: [] },
      policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1, appearance: { theme: 'auto' as const, atmosphere: { source: 'none' as const } } };
    for (const relativePeriod of ['30days', '90days', 'year'] as const) {
      const selected = { ...input, relativePeriod };
      expect(projectPublicProfile(selected)).toMatchObject({ relativePeriod, snapshot: { period: snapshot.period } });
      expect(projectPublicProfilePreview(selected)).toMatchObject({ relativePeriod, snapshot: { period: snapshot.period } });
    }
    expect(projectPublicProfile(input)).not.toHaveProperty('relativePeriod');
    expect(PublicProfileViewV1Schema.safeParse(projectPublicProfile(input)).success).toBe(true);
  });
  it('omits unattributed Agent rows from every public collection and source lens, retaining named shares and totals', () => {
    const rows = ['codex', 'unknown', 'legacy', 'custom-acp'].map(agentId => ({ agentId, share: .25, tokens: 10, coverage }));
    const supplied = { tokens: 40, agentMix: rows,
      agentActiveDays: rows.map(({ agentId }) => ({ agentId, days: 1, coverage })),
      weeklyAgentMix: [{ startMs: 1, endMs: 7, mix: rows.map(({ tokens: _tokens, ...row }) => row) }],
      sessionDurations: rows.map(({ agentId }) => ({ agentId, durationMs: 100 })) };
    const input = PublicProfileSnapshotV1Schema.parse({ ...snapshot, facts: supplied,
      lenses: [{ execution: 'outside', facts: supplied }] });
    const policy = { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields,
      agentMix: true, agentActiveDays: true, weeklyAgentMix: true, sessionDurations: true, sourceSplit: true } };
    const projected = projectPublicProfileSnapshot(input, policy);
    for (const facts of [projected.facts, ...projected.lenses!.map(lens => lens.facts)]) {
      expect(facts.tokens).toBe(40);
      expect(facts.agentMix).toEqual(rows.filter(row => row.agentId === 'codex' || row.agentId === 'custom-acp'));
      expect(facts.agentActiveDays?.map(row => row.agentId)).toEqual(['codex', 'custom-acp']);
      expect(facts.weeklyAgentMix?.[0]?.mix.map(row => row.agentId)).toEqual(['codex', 'custom-acp']);
      expect(facts.sessionDurations?.map(row => row.agentId)).toEqual(['codex', 'custom-acp']);
    }
    expect(input.facts.agentMix).toHaveLength(4);
  });
  it('carries the producer-set avatar fallback through strict identity reads and removes it with avatar consent', () => {
    const identity = { name: 'Ada', avatar: { kind: 'planet', reason: 'account_image_unavailable' } };
    const context = PublicProfileContextV1Schema.parse({ handle: 'ada', identity, service: null, urls: null });
    expect(projectPublicProfileIdentity(context.identity, DEFAULT_PUBLIC_PROFILE_POLICY_V1)).toEqual(identity);
    expect(projectPublicProfileIdentity(context.identity, { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1,
      fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, avatar: false } })).toEqual({ name: 'Ada' });
    const layout = PublicProfileLayoutV1Schema.parse({ v: 1, items: [{ kind: 'widget', id: 'identity', size: 'medium', frameStyle: 'plain',
      presentation: { kind: 'declarative', document: { version: 1, root: { kind: 'metric', label: 'Avatar',
        data: { kind: 'value', value: { kind: 'public_profile' } }, value: { path: ['identity', 'avatar', 'kind'], type: 'string' } } } } }] });
    const preview = (avatar: boolean) => projectPublicProfilePreview({ context, metadata: {}, snapshot, layout,
      appearance: { theme: 'auto', atmosphere: { source: 'none' } },
      policy: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, name: false, avatar } } });
    expect(preview(true)?.layout.items).toHaveLength(1);
    expect(preview(false)?.layout.items).toEqual([]);
    // Existing contexts without the optional presentation result remain valid.
    expect(PublicProfileContextV1Schema.parse({ ...context, identity: { name: 'Ada' } }).identity).toEqual({ name: 'Ada' });
  });
  it('admits one snapshot for many placements and policy edits while retaining strict ingress and revocation', () => {
    let visits = 0;
    const input = { ...snapshot, facts: { activeDays: 3, tokens: 123, sessionDurations: Array.from({ length: 1000 }, () => ({
      agentId: 'codex', get durationMs() { visits++; return 100; },
    })) } };
    const projector = createPublicProfileProjector(input);
    expect(visits).toBe(1000);
    const context = { handle: 'ada', identity: {}, service: null, urls: null };
    const projection = projector.project({ context, metadata: {}, policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1 })!;
    const layout = PublicProfileLayoutV1Schema.parse({ v: 1, items: [{ kind: 'widget', id: 'summary', size: 'medium', frameStyle: 'plain',
      presentation: { kind: 'usage', widgetId: 'usage_period_summary', inputs: {} } }] });
    for (let i = 0; i < 20; i++) expect(projection.projectLayout(layout).items).toHaveLength(1);
    const narrowed = projector.project({ context, metadata: {}, policy: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1,
      fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, tokens: false, activeDays: false } } })!;
    expect(narrowed.view.snapshot.facts).not.toHaveProperty('tokens');
    expect(narrowed.view.snapshot.facts).not.toHaveProperty('activeDays');
    expect(projection.view.snapshot.facts.tokens).toBe(123);
    expect(visits).toBe(1000);
    const invalid = { ...input, facts: { ...input.facts, privateCost: 42 } };
    expect(() => createPublicProfileProjector(invalid)).toThrow();
    const invalidLayout = { ...layout, privateQuery: true };
    expect(() => projection.projectLayout(invalidLayout)).toThrow();
  });
  it('enforces the selected builtin size declaration at direct public-layout admission', () => {
    const widget = (widgetId: string, size: string) => ({ kind: 'widget', id: widgetId, size, frameStyle: 'plain',
      presentation: { kind: 'usage', widgetId, inputs: {} } });
    for (const [widgetId, size] of [['usage_projects', 'wide'], ['usage_atmosphere', 'full'], ['usage_machines', 'small']]) {
      expect(PublicProfileLayoutV1Schema.safeParse({ v: 1, items: [widget(widgetId!, size!)] }).success).toBe(true);
    }
    for (const [widgetId, size] of [['usage_projects', 'small'], ['usage_atmosphere', 'wide'], ['usage_machines', 'tall']]) {
      expect(PublicProfileLayoutV1Schema.safeParse({ v: 1, items: [widget(widgetId!, size!)] }).success).toBe(false);
    }
  });
  it('prunes the selected planet concepts through the same leaf-policy owner, including weekly peak dependency', () => {
    const presentations = [
      ...['ninetyPlanets', 'streakThread', 'weeksSkyline', 'daysOnSurface', 'ringedStreaks', 'aroundPeriod']
        .map(style => ({ kind: 'usage', widgetId: 'usage_rhythm', inputs: { style } })),
      { kind: 'usage', widgetId: 'usage_orbit', inputs: { style: 'moons' } },
      { kind: 'usage', widgetId: 'usage_run_length', inputs: { style: 'galaxy' } },
      ...['usage_machines', 'usage_projects', 'usage_atmosphere'].map(widgetId => ({ kind: 'usage', widgetId, inputs: {} })),
    ];
    const layout = PublicProfileLayoutV1Schema.parse({ v: 1, items: presentations.map((presentation, index) => ({
      kind: 'widget', id: String(index), size: presentation.widgetId === 'usage_projects' ? 'wide' : 'medium', frameStyle: 'plain', presentation,
    })) });
    const policy = { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields,
      agentMix: false, agentActiveDays: true, sessionDurations: true, machineKinds: true, projects: true, weeklyPeakParallel: true } };
    const input = { context: { handle: 'person', identity: {}, service: null, urls: null }, snapshot, metadata: {}, layout,
      appearance: { theme: 'auto', atmosphere: { source: 'none' } } } as const;
    const ids = (fields: typeof policy.fields) => projectPublicProfilePreview({ ...input, policy: { ...policy, fields } })?.layout.items.map(item => item.id);
    expect(ids(policy.fields)).toHaveLength(11);
    expect(ids({ ...policy.fields, calendar: false })).toEqual(['6', '7', '8', '9', '10']);
    expect(ids({ ...policy.fields, agentActiveDays: false })).not.toContain('6');
    expect(ids({ ...policy.fields, sessionDurations: false })).not.toContain('7');
    expect(ids({ ...policy.fields, machineKinds: false })).not.toContain('8');
    expect(ids({ ...policy.fields, projects: false })).not.toContain('9');
    expect(ids({ ...policy.fields, peakParallel: false })).not.toContain('10');
    expect(ids({ ...policy.fields, weeklyPeakParallel: false })).not.toContain('10');
  });
  it('requires Highlights and an admitted underlying leaf for Personal records, including durations', () => {
    const input = { context: { handle: 'person', identity: {}, service: null, urls: null },
      metadata: {}, snapshot, appearance: { theme: 'auto', atmosphere: { source: 'none' } } } as const;
    const layout = PublicProfileLayoutV1Schema.parse({ v: 1, items: [{ kind: 'widget', id: 'records', size: 'wide', frameStyle: 'plain',
      presentation: { kind: 'usage', widgetId: 'usage_recap', inputs: { style: 'personalRecords' } } }] });
    const base = { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: Object.fromEntries(Object.keys(DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields)
      .map(field => [field, false])) as typeof DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields };
    for (const field of ['activeDays', 'currentStreak', 'bestStreak', 'peakParallel', 'sessionDurations'] as const) {
      const policy = { ...base, fields: { ...base.fields, [field]: true } };
      expect(projectPublicProfilePreview({ ...input, layout, policy })?.layout.items).toEqual([]);
      expect(projectPublicProfilePreview({ ...input, layout, policy: { ...policy, fields: { ...policy.fields, highlights: true } } })?.layout.items)
        .toHaveLength(1);
    }
    expect(projectPublicProfilePreview({ ...input, layout, policy: { ...base, fields: { ...base.fields, highlights: true } } })?.layout.items).toEqual([]);
  });
  it('retains reviewed block titles only with their admitted current-policy content', () => {
    const widget = { kind: 'widget', id: 'summary', title: 'Work in this period', size: 'medium', frameStyle: 'card',
      presentation: { kind: 'declarative', document: { version: 1, root: { kind: 'metric', label: 'Tokens',
        data: { kind: 'value', value: { kind: 'public_profile' } }, value: { path: ['snapshot', 'facts', 'tokens'], type: 'number' } } } } };
    const layout = PublicProfileLayoutV1Schema.parse({ v: 1, items: [widget] });
    const input = { context: { handle: 'person', identity: {},
      service: { displayName: 'Service', publicBaseUrl: 'https://example.com' },
      urls: { page: 'https://example.com/@person', json: 'https://example.com/v1/public/profiles/person',
        badgeBase: 'https://example.com/@person/badge', card: 'https://example.com/@person/card.svg',
        og: 'https://example.com/@person/og.png', report: 'mailto:operator@example.com' } },
      metadata: {}, snapshot, layout, appearance: { theme: 'auto', atmosphere: { source: 'none' } } } as const;
    expect(projectPublicProfile({ ...input, policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1 })?.layout.items)
      .toMatchObject([{ id: 'summary', title: 'Work in this period' }]);
    expect(projectPublicProfile({ ...input, policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1 })).toMatchObject({ indexable: false });
    expect(projectPublicProfile({ ...input, policy: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, indexable: true } }))
      .toMatchObject({ indexable: true });
    expect(projectPublicProfile({ ...input, policy: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1,
      fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, tokens: false } } })?.layout.items).toEqual([]);
    for (const service of [input.context.service, null]) {
      const localInput = { ...input, context: { ...input.context, service, urls: null },
        policy: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, tokens: false } } };
      const local = projectPublicProfilePreview(localInput);
      expect(local).toMatchObject({ handle: 'person', service, urls: null, layout: { items: [] } });
      expect(JSON.stringify(local)).not.toContain('87654321');
      expect(PublicProfileViewV1Schema.safeParse(local).success).toBe(false);
      expect(projectPublicProfile(localInput)).toBeNull();
    }
  });
  it('admits built-in Usage placements without private query inputs and removes calendar-dependent copies when hidden', () => {
    const widget = { kind: 'widget', id: 'sky', title: 'Sky of days', size: 'full', frameStyle: 'plain',
      presentation: { kind: 'usage', widgetId: 'usage_rhythm', inputs: { style: 'sky' } } };
    const layout = PublicProfileLayoutV1Schema.parse({ v: 1, items: [widget] });
    const input = { context: { handle: 'person', identity: {},
      service: { displayName: 'Service', publicBaseUrl: 'https://example.com' },
      urls: { page: 'https://example.com/@person', json: 'https://example.com/v1/public/profiles/person',
        badgeBase: 'https://example.com/@person/badge', card: 'https://example.com/@person/card.svg',
        og: 'https://example.com/@person/og.png', report: 'mailto:operator@example.com' } },
      metadata: {}, snapshot: { ...snapshot, facts: { calendar: [{ date: '1970-01-01', level: 4 as const }] } },
      layout, appearance: { theme: 'auto', atmosphere: { source: 'none' } } } as const;
    expect(projectPublicProfile({ ...input, policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1 })?.layout.items)
      .toMatchObject([{ id: 'sky', presentation: { kind: 'usage', widgetId: 'usage_rhythm' } }]);
    expect(projectPublicProfile({ ...input, policy: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1,
      fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, calendar: false } } })?.layout.items).toEqual([]);
    for (const presentation of [
      { ...widget.presentation, inputs: { style: 'sky', query: { period: 'all' } } },
      { ...widget.presentation, inputs: { style: 'sky', metric: 'cost' } },
      { ...widget.presentation, widgetId: 'usage_cost_facts', inputs: {} },
    ]) expect(PublicProfileLayoutV1Schema.safeParse({ v: 1, items: [{ ...widget, presentation }] }).success).toBe(false);
  });
  it('orders anonymous duration observations independently of their private input chronology', () => {
    const durations = [{ agentId: 'codex', durationMs: 400 }, { agentId: 'claude', durationMs: 300 }, { agentId: 'claude', durationMs: 100 }];
    const policy = { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, sessionDurations: true } };
    const project = (sessionDurations: typeof durations) => projectPublicProfileSnapshot({ ...snapshot, facts: { sessionDurations } }, policy).facts.sessionDurations;
    expect(project(durations)).toEqual(project([...durations].reverse()));
    expect(project(durations)).toEqual([{ agentId: 'claude', durationMs: 100 }, { agentId: 'claude', durationMs: 300 }, { agentId: 'codex', durationMs: 400 }]);
    expect(durations[0]!.agentId).toBe('codex');
  });
  it('keeps an execution-share breakdown when Agent mix is hidden without restoring either hidden field', () => {
    const context = { handle: 'person', identity: {}, service: { displayName: 'Service', publicBaseUrl: 'https://example.com' },
      urls: { page: 'https://example.com/@person', json: 'https://example.com/v1/public/profiles/person',
        badgeBase: 'https://example.com/@person/badge', card: 'https://example.com/@person/card.svg',
        og: 'https://example.com/@person/og.png', report: 'mailto:operator@example.com' } };
    const layout = PublicProfileLayoutV1Schema.parse({ v: 1, items: [{ kind: 'widget', id: 'execution', size: 'medium', frameStyle: 'plain',
      presentation: { kind: 'usage', widgetId: 'usage_breakdowns', inputs: { style: 'breakdowns' } } }] });
    const policy = { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, agentMix: false, tokens: false } };
    const view = projectPublicProfile({ context, metadata: {}, snapshot, layout, policy,
      appearance: { theme: 'auto', atmosphere: { source: 'none' } } });
    expect(view?.layout.items).toHaveLength(1);
    expect(view?.snapshot.facts.sourceSplit).toEqual([{ execution: 'outside', share: 1 }]);
    expect(view?.snapshot.facts).not.toHaveProperty('agentMix');
    expect(JSON.stringify(view)).not.toContain('87654321');
  });
  it('keeps independently consented Agent days in Crew without restoring hidden shares', () => {
    const context = { handle: 'person', identity: {}, service: { displayName: 'Service', publicBaseUrl: 'https://example.com' },
      urls: { page: 'https://example.com/@person', json: 'https://example.com/v1/public/profiles/person',
        badgeBase: 'https://example.com/@person/badge', card: 'https://example.com/@person/card.svg',
        og: 'https://example.com/@person/og.png', report: 'mailto:operator@example.com' } };
    const layout = PublicProfileLayoutV1Schema.parse({ v: 1, items: [{ kind: 'widget', id: 'crew', size: 'medium', frameStyle: 'plain',
      presentation: { kind: 'usage', widgetId: 'usage_breakdowns', inputs: { style: 'crew' } } }] });
    const policy = { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields,
      agentMix: false, agentActiveDays: true, tokens: false } };
    const view = projectPublicProfile({ context, metadata: {}, snapshot: { ...snapshot, facts: { ...facts,
      agentActiveDays: [{ agentId: 'codex', days: 2, coverage }] } }, layout, policy,
      appearance: { theme: 'auto', atmosphere: { source: 'none' } } });
    expect(view?.layout.items).toHaveLength(1);
    expect(view?.snapshot.facts.agentActiveDays).toEqual([{ agentId: 'codex', days: 2, coverage }]);
    expect(view?.snapshot.facts).not.toHaveProperty('agentMix');
    expect(JSON.stringify(view)).not.toContain('87654321');
  });
  it('publishes the same inert source restriction to generated schema consumers', () => {
    const schema = PluginJsonSchemaV2Schema.parse(zodSchemaToJsonSchemaObject(WidgetPublicSnapshotDocumentV1Schema, { target: 'draft-7' }));
    const validate = compilePluginJsonSchema(schema);
    const metric = { kind: 'metric', label: 'Tokens', data: { kind: 'value', value: { kind: 'public_profile' } },
      value: { path: ['snapshot', 'facts', 'tokens'], type: 'number' } };
    expect(isValidPluginJsonSchemaValue(validate, { version: 1, root: metric })).toBe(true);
    for (const root of [{ ...metric, data: { kind: 'value', value: 123 } }, { kind: 'markdown', text: '<script />' }]) {
      expect(isValidPluginJsonSchemaValue(validate, { version: 1, root })).toBe(false);
    }
  });
  it('drops an unknown stored presentation without hiding the remaining edition or accepting malformed known data', () => {
    const future = { kind: 'widget', id: 'future', size: 'medium', frameStyle: 'plain', presentation: { kind: 'future_chart' } };
    const layout = { v: 1, items: [future, { kind: 'group', id: 'group', width: 'full', frameStyle: 'plain', dividers: 'none', children: [future] }] };
    expect(PublicProfileLayoutV1StoredSchema.parse(layout)).toEqual({ v: 1, items: [] });
    expect(PublicProfileLayoutV1Schema.safeParse(layout).success).toBe(false);
    expect(PublicProfileLayoutV1StoredSchema.safeParse({ v: 1, items: [{ ...future, presentation: { kind: 'declarative' } }] }).success).toBe(false);
  });
  it('prunes absolute token amounts recursively but keeps consented shares and unrelated highlights', () => {
    const policy = { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields,
      tokens: false, activeDays: false, highlights: true, weeklyAgentMix: true, weeklyPeakParallel: true, peakParallel: false } };
    const view = projectPublicProfileSnapshot(snapshot, policy);
    expect(view.facts.agentMix).toEqual([{ agentId: 'codex', share: 1, coverage }]);
    expect(view.lenses?.[0]?.facts.sourceSplit).toEqual([{ execution: 'outside', share: 1 }]);
    expect(JSON.stringify(view)).not.toContain('87654321');
    expect(view.fieldCoverage).not.toHaveProperty('tokens');
    expect(view.facts).not.toHaveProperty('activeDays');
    expect(view.facts).not.toHaveProperty('weeklyPeakParallel');
    expect(view.facts.highlights).toEqual([]);
    expect(PublicProfileSnapshotV1Schema.safeParse(view).success).toBe(true);
    expect(snapshot.facts.tokens).toBe(87654321);
  });
  it('removes hidden dependent columns inside source-lens tables without removing allowed execution labels', () => {
    const context = { handle: 'person', identity: {}, service: { displayName: 'Service', publicBaseUrl: 'https://example.com' },
      urls: { page: 'https://example.com/@person', json: 'https://example.com/v1/public/profiles/person',
        badgeBase: 'https://example.com/@person/badge', card: 'https://example.com/@person/card.svg',
        og: 'https://example.com/@person/og.png', report: 'mailto:operator@example.com' } };
    const layout = PublicProfileLayoutV1Schema.parse({ v: 1, items: [{ kind: 'widget', id: 'lens', size: 'medium', frameStyle: 'plain',
      presentation: { kind: 'declarative', document: { version: 1, root: { kind: 'table',
        data: { kind: 'value', value: { kind: 'public_profile' } }, rows: ['snapshot', 'lenses'], columns: [
          { label: 'Execution', field: { path: ['execution'], type: 'string' } },
          { label: 'Absolute token count', field: { path: ['facts', 'tokens'], type: 'number' } },
        ] } } } }] });
    const policy = { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, tokens: false } };
    const input = { context, metadata: {}, snapshot, layout, appearance: { theme: 'auto', atmosphere: { source: 'none' } } } as const;
    const view = projectPublicProfile({ ...input, policy });
    expect(view?.layout.items).toHaveLength(1);
    expect(JSON.stringify(view?.layout)).toContain('Execution');
    expect(JSON.stringify(view?.layout)).not.toContain('Absolute token count');
    expect(JSON.stringify(view)).not.toContain('87654321');
    expect(projectPublicProfile({ ...input, policy: { ...policy, fields: { ...policy.fields, sourceSplit: false } } })?.layout.items).toEqual([]);
  });
  it('rejects nested authority, private facts, invalid calendar dates and duplicate categories', () => {
    for (const input of [
      { ...snapshot, policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1 },
      { ...snapshot, facts: { ...facts, cost: 100 } },
      { ...snapshot, facts: { ...facts, agentMix: [{ ...facts.agentMix[0], accountId: 'private' }] } },
      { ...snapshot, facts: { calendar: [{ date: '2026-02-30', level: 1 }] } },
      { ...snapshot, facts: { weeklyAgentMix: [{ startMs: 1, endMs: 7, mix: [{ agentId: 'codex', share: 1, coverage, tokens: 123 }] }] } },
      { ...snapshot, lenses: [snapshot.lenses![0], snapshot.lenses![0]] },
    ]) expect(PublicProfileSnapshotV1Schema.safeParse(input).success).toBe(false);
  });
  it('drops future stored field ids without granting consent and fails known malformed security facts closed', () => {
    expect(PublicProfilePolicyV1StoredSchema.parse({ ...DEFAULT_PUBLIC_PROFILE_POLICY_V1,
      fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, futureSecret: true } })).toEqual(DEFAULT_PUBLIC_PROFILE_POLICY_V1);
    expect(PublicProfileSnapshotV1StoredSchema.parse({ ...snapshot, fieldCoverage: { ...snapshot.fieldCoverage, futureSecret: coverage },
      facts: { ...snapshot.facts, futureSecret: 777 } })).toEqual(snapshot);
    expect(PublicProfilePolicyV1StoredSchema.safeParse({ ...DEFAULT_PUBLIC_PROFILE_POLICY_V1,
      fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, tokens: 'yes' } }).success).toBe(false);
    expect(PublicProfileSnapshotV1StoredSchema.safeParse({ ...snapshot, facts: { tokens: -1 } }).success).toBe(false);
  });
  it('refuses malformed configured service and report URLs without escaping schema validation', () => {
    const urls = { page: 'https://example.com/@person', json: 'https://example.com/v1/public/profiles/person',
      badgeBase: 'https://example.com/@person/badge', card: 'https://example.com/@person/card.svg',
      og: 'https://example.com/@person/og.png', report: 'mailto:operator@example.com' };
    for (const input of [
      { handle: 'person', identity: {}, service: { displayName: 'Service', publicBaseUrl: '-' }, urls },
      { handle: 'person', identity: {}, service: { displayName: 'Service', publicBaseUrl: 'https://example.com' }, urls: { ...urls, report: '-' } },
    ]) expect(PublicProfileContextV1Schema.safeParse(input).success).toBe(false);
  });
  it('compiles copies only after masking and strips hidden table columns, identity and empty groups', () => {
    const metric = { kind: 'metric', label: 'Tokens', data: { kind: 'value', value: { kind: 'public_profile' } },
      value: { path: ['snapshot', 'facts', 'tokens'], type: 'number' } };
    const widget = (id: string, root: unknown) => ({ kind: 'widget', id, size: 'medium', frameStyle: 'plain',
      presentation: { kind: 'declarative', document: { version: 1, root } } });
    const layout = PublicProfileLayoutV1Schema.parse({ v: 1, items: [widget('one', metric),
      { kind: 'group', id: 'group', width: 'full', frameStyle: 'plain', dividers: 'none', children: [widget('two', metric)] },
      widget('mix', { kind: 'table', data: metric.data, rows: ['snapshot', 'facts', 'agentMix'], columns: [
        { label: 'Agent', field: { path: ['agentId'], type: 'string' } },
        { label: 'Share', field: { path: ['share'], type: 'number' }, proportion: true },
        { label: 'Tokens', field: { path: ['tokens'], type: 'number' } },
      ] }),
    ] });
    const policy = { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, tokens: false, name: false } };
    const result = projectPublicProfile({ context: { handle: 'person', identity: { name: 'PRIVATE-NAME' },
      service: { displayName: 'Service', publicBaseUrl: 'https://example.com/prefix' },
      urls: { page: 'https://example.com/prefix/@person', json: 'https://example.com/prefix/v1/public/profiles/person',
        badgeBase: 'https://example.com/prefix/@person/badge', card: 'https://example.com/prefix/@person/card.svg',
        og: 'https://example.com/prefix/@person/og.png', report: 'mailto:operator@example.com' } },
      metadata: {}, policy, snapshot, layout, appearance: { theme: 'auto', atmosphere: { source: 'none' } } });
    expect(result?.layout.items.map(item => item.id)).toEqual(['mix']);
    expect(JSON.stringify(result)).not.toContain('87654321');
    expect(JSON.stringify(result)).not.toContain('PRIVATE-NAME');
    expect(result?.layout.items[0]?.kind).toBe('widget');
    const item = result!.layout.items[0]!;
    if (item.kind !== 'widget' || item.presentation.document.root.kind !== 'table') throw new Error('Expected compiled table');
    expect(item.presentation.document.root.columns.map(column => column.label)).toEqual(['Agent', 'Share']);
    expect(item.presentation.document.root.data).toEqual({ kind: 'value', value: [{ c0: 'codex', c1: 1 }] });
    expect(PublicProfileLayoutV1Schema.safeParse({ v: 1, items: [widget('bad', { ...metric,
      value: { path: ['snapshot', 'facts', 'privateCost'], type: 'number' } })] }).success).toBe(false);
    expect(PublicProfileLayoutV1Schema.safeParse({ v: 1, items: [widget('bad-chart', {
      kind: 'chart', label: 'Mix', data: metric.data, style: 'area', rows: ['snapshot', 'facts', 'agentMix'],
      x: { path: ['agentId'], type: 'string' }, series: { path: ['share'], type: 'number' }, value: { path: ['share'], type: 'number' },
    })] }).success).toBe(false);
    for (const root of [{ ...metric, data: { kind: 'value', value: 123 } },
      { kind: 'stack', children: [{ kind: 'markdown', text: '<script>private()</script>' }] },
    ]) expect(PublicProfileLayoutV1Schema.safeParse({ v: 1, items: [widget('bad', root)] }).success).toBe(false);
  });
});
