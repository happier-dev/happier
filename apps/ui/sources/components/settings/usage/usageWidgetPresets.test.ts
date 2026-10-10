import { describe, expect, it } from 'vitest';
import { createWidgetSurfaceArtifactPortV1,
    flattenWidgetLayoutWidgetsV1, resolveConfiguredWidgetInputs, readBuiltinWidgetDescriptorV1,
    WidgetAreaPresetV1Schema, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { createUsageWidgetPresets, USAGE_WIDGET_PRESET_IDS } from './usageWidgetPresets';
import { buildWidgetCandidateSetup } from '@/components/widgets/surface/widgetSurfaceSetup';
import { selectBuiltinWidgetCandidates } from '@/components/widgets/widgetCatalog';

const names = Object.fromEntries(USAGE_WIDGET_PRESET_IDS.map(id => [id, id])) as Record<typeof USAGE_WIDGET_PRESET_IDS[number], string>;
const surface: WidgetSurfaceRefV1 = { serverId: 'home', accountId: 'account', owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'overview' } };

describe('Usage host fragment presets', () => {
    it('initializes legacy Overview presentation without overwriting other host presets', () => {
        const presets = createUsageWidgetPresets(names, { initialMetric: 'cost' }).map(preset => WidgetAreaPresetV1Schema.parse(preset));
        for (const row of flattenWidgetLayoutWidgetsV1(presets.find(preset => preset.id === 'overview')!.items)) {
            if (row.instance.definition.kind === 'builtin' && row.instance.definition.id === 'usage_sources') {
                expect(Object.keys(row.instance.bindings).sort()).toEqual(['agents', 'machines', 'sources']);
            } else expect(row.instance.bindings.metric).toEqual({ kind: 'value', value: 'cost' });
        }
        for (const preset of presets.filter(preset => preset.id !== 'overview')) {
            expect(preset.items).toEqual(WidgetAreaPresetV1Schema.parse(createUsageWidgetPresets(names).find(defaultPreset => defaultPreset.id === preset.id)!).items);
        }
        const costs = WidgetAreaPresetV1Schema.parse(createUsageWidgetPresets(names, { initialMetric: 'tokens' }).find(preset => preset.id === 'costs')!);
        for (const row of flattenWidgetLayoutWidgetsV1(costs.items)) {
            expect(row.instance.bindings.metric).toEqual({ kind: 'value', value: 'cost' });
        }
    });
    it('offers every host view and reads missing defaults without a write through the actual area owner', async () => {
        const presets = createUsageWidgetPresets(names).map(preset => WidgetAreaPresetV1Schema.parse(preset));
        expect(presets.map(preset => preset.id)).toEqual([...USAGE_WIDGET_PRESET_IDS]);
        for (const preset of presets) {
            const parsed = WidgetAreaPresetV1Schema.parse(preset);
            expect(parsed.items.length).toBeGreaterThan(0);
            for (const item of parsed.items) expect(item).toMatchObject({ kind: 'group', frameStyle: 'card', dividers: 'hairline' });
        }
        const owner = createWidgetSurfaceArtifactPortV1({ read: async () => null,
            // A render-only missing read cannot ask a transport to persist defaults.
            create: async () => { throw new Error('unexpected_write'); }, update: async () => { throw new Error('unexpected_write'); },
        }, { surface, presets, isCurrent: () => true });
        const read = await owner.readState();
        expect(read.kind).toBe('missing');
        expect(read.layout.items).toEqual(presets[0]!.items);
        // One Card · Lines group: the tall daily bars pack left of the period summary and capacity.
        const first = read.layout.items[0]!;
        expect(first).toMatchObject({ kind: 'group', width: 'full' });
        expect(first.kind === 'group' ? first.children.slice(0, 3) : []).toMatchObject([
            { size: 'tall', instance: { definition: { id: 'usage_daily' } } },
            { size: 'medium', instance: { definition: { id: 'usage_period_summary' } } },
            { size: 'medium', instance: { definition: { id: 'usage_capacity' } } }]);
    });

    it('uses declared Usage inputs for every definition; Home owns values and Project follows only projects', () => {
        const presets = createUsageWidgetPresets(names).map(preset => WidgetAreaPresetV1Schema.parse(preset));
        expect(presets.length).toBe(8);
        const ids = new Set(presets.flatMap(preset => flattenWidgetLayoutWidgetsV1(preset.items).map(row => row.instance.definition.kind === 'builtin' ? row.instance.definition.id : '')));
        expect([...ids].sort()).toEqual(['usage_daily', 'usage_period_summary', 'usage_cost_facts', 'usage_flow', 'usage_efficiency',
            'usage_breakdowns', 'usage_capacity', 'usage_projections', 'usage_resets', 'usage_plan_fit', 'usage_project_ledger', 'usage_session_value',
            'usage_outcomes', 'usage_coach', 'usage_rhythm', 'usage_parallel', 'usage_human_loop', 'usage_night_shift', 'usage_recap', 'usage_sources'].sort());
        for (const preset of presets) for (const row of flattenWidgetLayoutWidgetsV1(preset.items)) {
            const descriptor = readBuiltinWidgetDescriptorV1(row.instance.definition)!;
            expect(descriptor).not.toBeNull();
            if (row.instance.definition.kind !== 'builtin' || row.instance.definition.id !== 'usage_sources') {
                expect(row.instance.bindings.metric?.kind).toBe('value');
                expect(row.instance.bindings.breakdown?.kind).toBe('value');
            }
            // The target's missing scopes are intentionally unavailable until its context is admitted.
            expect(resolveConfiguredWidgetInputs({ descriptor, instance: row.instance, providedContext: {}, viewerValues: {} }).status).toBe('selection_required');
        }
        const candidate = selectBuiltinWidgetCandidates().find(row => row.definition?.kind === 'builtin' && row.definition.id === 'usage_daily')!;
        const copiedInput = { period: { startMs: 10 }, agents: ['agent'], machines: [], projects: ['source-project'], sources: [], session: null,
            costBasis: 'reported', metric: 'cost', breakdown: ['agent'] };
        const setup = (context: Parameters<typeof buildWidgetCandidateSetup>[0]['context']) => buildWidgetCandidateSetup({
            candidate, context, audience: 'personal', mode: { kind: 'add', submitLabel: 'Add', copiedInput }, submit: async () => ({ ok: true }),
        });
        const home = setup({});
        expect(home.resolve(home.initial)).toMatchObject({ status: 'ready', input: copiedInput });
        expect(Object.values(home.initial.bindings).every(binding => binding.kind === 'value')).toBe(true);
        const project = setup({ slots: { projects: { label: 'This project', value: { value: ['destination-project'], label: 'Project' } } } });
        expect(project.initial.bindings.projects).toEqual({ kind: 'context', slot: 'projects' });
        expect(project.resolve(project.initial)).toMatchObject({ status: 'ready', input: { ...copiedInput, projects: ['destination-project'] } });
        const sourceCandidate = selectBuiltinWidgetCandidates().find(row => row.definition?.kind === 'builtin' && row.definition.id === 'usage_sources')!;
        const sourceHome = buildWidgetCandidateSetup({ candidate: sourceCandidate, context: {}, audience: 'personal',
            mode: { kind: 'add', submitLabel: 'Add' }, submit: async () => ({ ok: true }) });
        expect(sourceHome.fields.map(row => row.field.path)).toEqual(['agents', 'machines', 'sources']);
        expect(sourceHome.resolve(sourceHome.initial)).toEqual({ status: 'ready', input: { agents: [], machines: [], sources: [] } });
    });
});
