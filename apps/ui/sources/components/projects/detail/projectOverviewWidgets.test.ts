import { describe, expect, it } from 'vitest';
import type { WidgetPlacementV1 } from '@happier-dev/protocol/widgets';
import { mergeProjectOverviewWidgetHeads, projectOverviewWidgetAreas, readProjectOverviewWidgetAreas } from './projectOverviewWidgets';

type Placement = WidgetPlacementV1;
const builtin = (name: string): Placement => ({ instance: { v: 1, id: name, definition: { kind: 'builtin', id: `project_${name}` }, bindings: { checkout: { kind: 'context', slot: 'checkout' } } }, frameStyle: 'plain' });
const metric: Placement = { instance: { v: 1, id: 'metric', definition: { kind: 'installed', surface: { pluginId: 'metrics', localId: 'count' } }, bindings: {} } };
const ids = (placements: readonly Placement[]) => placements.map(placement => placement.instance.id);

describe('Project Overview responsive projection', () => {
    it('uses render-only defaults for missing areas and the lab phone hierarchy', () => {
        const areas = projectOverviewWidgetAreas({ main: null, aside: null });
        expect(areas.main.map(row => row.instance.definition)).toEqual([{ kind: 'builtin', id: 'project_code' }, { kind: 'builtin', id: 'project_readme' }]);
        expect(areas.aside.map(row => row.instance.definition)).toEqual(
            ['about', 'changes', 'checkouts', 'scripts', 'sessions'].map(name => ({ kind: 'builtin', id: `project_${name}` })),
        );
        expect(mergeProjectOverviewWidgetHeads({ main: null, aside: null }).map(row => row.instance.definition)).toEqual(
            ['about', 'changes', 'scripts', 'code', 'readme', 'checkouts', 'sessions'].map(name => ({ kind: 'builtin', id: `project_${name}` })),
        );
    });

    it('preserves saved area order while competing only current heads', () => {
        const main = [metric, builtin('code'), builtin('readme')];
        const aside = [builtin('about'), builtin('checkouts'), builtin('scripts'), builtin('sessions')];
        const areas = projectOverviewWidgetAreas({ main, aside });
        expect(areas.main).toBe(main);
        expect(areas.aside).toBe(aside);
        expect(ids(mergeProjectOverviewWidgetHeads(areas))).toEqual(['about', 'metric', 'code', 'readme', 'checkouts', 'scripts', 'sessions']);
        const moved = projectOverviewWidgetAreas({ main: [metric, builtin('code'), builtin('scripts'), builtin('readme')],
            aside: [builtin('about'), builtin('checkouts'), builtin('sessions')] });
        expect(ids(mergeProjectOverviewWidgetHeads(moved))).toEqual(['about', 'metric', 'code', 'scripts', 'readme', 'checkouts', 'sessions']);
        expect(ids(main)).toEqual(['metric', 'code', 'readme']);
    });

    it('keeps present-empty areas empty and retains each instance exactly once', () => {
        const empty: readonly Placement[] = [];
        expect(projectOverviewWidgetAreas({ main: empty, aside: empty })).toEqual({ main: empty, aside: empty });
        expect(mergeProjectOverviewWidgetHeads({ main: empty, aside: empty })).toEqual([]);
        const areas = { main: [builtin('sessions'), builtin('about')], aside: [metric] };
        expect(ids(mergeProjectOverviewWidgetHeads(areas))).toEqual(['metric', 'sessions', 'about']);
    });

    it('projects both areas from the same document without confusing present-empty with missing', () => {
        const surface = { serverId: 'home', accountId: 'viewer', owner: { kind: 'project' as const, projectId: 'anchor' } };
        expect(readProjectOverviewWidgetAreas(null)).toEqual({ main: null, aside: null });
        const layout = { v: 1 as const, surface, instances: [
            { ...builtin('code'), area: 'main' as const }, { ...builtin('about'), area: 'aside' as const },
            { ...builtin('readme'), area: 'main' as const },
        ] };
        const areas = readProjectOverviewWidgetAreas(layout);
        expect(ids(areas.main!)).toEqual(['code', 'readme']);
        expect(ids(areas.aside!)).toEqual(['about']);
        expect(areas.main![0]).toBe(layout.instances[0]);
        expect(readProjectOverviewWidgetAreas({ ...layout, instances: [] })).toEqual({ main: [], aside: [] });
    });
});
