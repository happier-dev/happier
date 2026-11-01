import * as React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { act } from 'react-test-renderer';
import type { WidgetSizeV1 } from '@happier-dev/protocol/widgets';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

afterEach(() => standardCleanup());

// The first import loads the page graph; keep that cold load outside every test's deadline.
const { HomeHubSectionList } = await import('./HomeHubSectionList');
const { PageColumnProvider, usePageColumn } = await import('@/components/ui/lists/listPresentation');

const builtin = (id: string) => ({ kind: 'builtin' as const, id, hidden: false, hideable: true });
const widget = (id: string, size: WidgetSizeV1 = 'medium') => ({
    kind: 'widget' as const, id, hidden: false, hideable: true as const, size,
    instance: { v: 1 as const, id, definition: { kind: 'installed' as const, surface: { pluginId: 'happier.widget.checks', localId: 'latest' } }, bindings: {} },
});

async function renderList(sections: ReadonlyArray<ReturnType<typeof builtin> | ReturnType<typeof widget>>) {
    return renderScreen(
        <HomeHubSectionList
            sections={sections}
            renderSection={(section) => `block:${section.id}`}
        />,
    );
}

function cellSpans(screen: Awaited<ReturnType<typeof renderList>>, gridTestID: string): unknown[] {
    const grid = screen.findByTestId(gridTestID);
    expect(grid).toBeTruthy();
    return grid!.findAll((node) => 'span' in (node.props ?? {})).map((node) => node.props.span);
}

async function cardWidths(screen: Awaited<ReturnType<typeof renderList>>, gridTestID: string) {
    const measured = screen.findAll(node => node.props?.testID === gridTestID && typeof node.props.onLayout === 'function')[0]!;
    await act(async () => measured.props.onLayout({ nativeEvent: { layout: { width: 1440, height: 800 } } }));
    return screen.findByTestId(gridTestID)!.findAll(node => 'span' in node.props && typeof node.props.children === 'string')
        .map(cell => [cell.props.children, StyleSheet.flatten(cell.parent?.parent?.props.style)?.width]);
}

describe('HomeHubSectionList (the column contract)', () => {
    it.each([1440, 500, 390])('retains small-card state and subscriptions through trio, pair and size edits at width %s', async width => {
        let reads = 0;
        let releases = 0;
        function Survivor() {
            const [value, setValue] = React.useState(0);
            React.useEffect(() => {
                reads++;
                return () => { releases++; };
            }, []);
            return <Pressable testID="survivor" onPress={() => setValue(current => current + 1)}><Text>{`retained:${value}`}</Text></Pressable>;
        }
        const render = (first: ReturnType<typeof widget>, leadCardId: string | null = null) => <HomeHubSectionList
            sections={[widget('medium-a'), widget('medium-b'), first, widget('survivor', 'small'), widget('small-c', 'small')]}
            leadCardId={leadCardId}
            renderSection={section => section.id === 'survivor' ? <Survivor /> : section.id}
        />;
        const first = widget('small-a', 'small');
        const screen = await renderScreen(render(first));
        const measure = async () => {
            for (const grid of screen.findAll(node => typeof node.props?.onLayout === 'function'
                && String(node.props.testID).startsWith('home-hub.cards:'))) {
                await act(async () => grid.props.onLayout({ nativeEvent: { layout: { width, height: 800 } } }));
            }
        };
        await measure();
        await act(async () => screen.findByTestId('survivor')!.props.onPress());
        for (const next of [{ ...first, hidden: true }, first, widget('small-a', 'medium'), first]) {
            await act(async () => { screen.update(render(next)); });
            await measure();
            expect(screen.getTextContent()).toContain('retained:1');
            expect(reads).toBe(1);
            expect(releases).toBe(0);
        }
        await act(async () => { screen.update(render(first, first.id)); });
        await act(async () => { screen.update(render(first)); });
        expect(screen.getTextContent()).toContain('retained:1');
        expect(reads).toBe(1);
        expect(releases).toBe(0);
    });
    it.each(['hide/show', 'remove', 'reorder', 'span', 'setup'] as const)(
        'preserves a sibling card mount and local state when its first neighbour changes (%s)', async change => {
        let mounts = 0;
        let reads = 0;
        let releases = 0;
        function StatefulCard(props: Readonly<{ id: string; ownsRow: boolean }>) {
            const [value, setValue] = React.useState(0);
            React.useEffect(() => {
                if (props.id !== 'b' && props.id !== 'other') return;
                mounts++;
                reads++;
                return () => { releases++; };
            }, []);
            return <Pressable testID={`card-${props.id}`} onPress={() => setValue(current => current + 1)}>
                <Text>{`${props.id}:${value}:${props.ownsRow}`}</Text>
            </Pressable>;
        }
        const a = widget('a');
        const b = widget('b');
        const c = widget('c');
        const render = (cards: ReadonlyArray<ReturnType<typeof widget>>, setupHidden = false) => <HomeHubSectionList
            sections={[builtin('start'), ...cards, { ...builtin('setup'), hidden: setupHidden }, widget('other')]}
            renderSection={(section, _index, placement) => <StatefulCard id={section.id} ownsRow={placement.ownsRow} />}
        />;
        const initial = change === 'span' ? [a, b] : [a, b, c];
        const screen = await renderScreen(render(initial));
        const grid = screen.findAll(node => typeof node.props?.onLayout === 'function'
            && String(node.props.testID).startsWith('home-hub.cards:'))[0]!;
        await act(async () => grid.props.onLayout({ nativeEvent: { layout: { width: 1440, height: 800 } } }));
        await act(async () => screen.findByTestId('card-b')!.props.onPress());
        await act(async () => screen.findByTestId('card-other')!.props.onPress());
        expect(screen.getTextContent()).toContain('b:1:false');
        const next = change === 'hide/show' ? [{ ...a, hidden: true }, b, c]
            : change === 'remove' ? [b, c] : change === 'reorder' ? [b, a, c]
                : change === 'setup' ? initial : [widget('a', 'wide'), b];
        await act(async () => { screen.update(render(next, change === 'setup')); });
        expect(mounts).toBe(2);
        expect(reads).toBe(2);
        expect(releases).toBe(0);
        expect(screen.getTextContent()).toContain(`b:1:${change === 'span'}`);
        expect(screen.getTextContent()).toContain('other:1:');
        // Hiding Setup retains both logical card runs and their full-row/paired packing.
        if (change === 'setup') {
            expect(screen.getTextContent()).not.toContain('setup:');
            expect(cellSpans(screen, 'home-hub.cards:after:setup')).toContain('row');
            expect(cellSpans(screen, 'home-hub.cards:after:start')).toContain(undefined);
        }
        await act(async () => { screen.update(render(initial)); });
        expect(mounts).toBe(2);
        expect(reads).toBe(2);
        expect(releases).toBe(0);
        expect(screen.getTextContent()).toContain('b:1:false');
        expect(screen.getTextContent()).toContain('other:1:');
    });
    it('lays two consecutive cards out as one two-up row, and every other block on its own', async () => {
        const screen = await renderList([builtin('start'), widget('widget:a/latest'), builtin('automations'), builtin('usage')]);
        expect(screen.getTextContent()).toBe('block:start block:widget:a/latest block:automations block:usage');
        expect(await cardWidths(screen, 'home-hub.cards:after:start')).toEqual([
            ['block:widget:a/latest', '50%'], ['block:automations', '50%'],
        ]);
        expect(cellSpans(screen, 'home-hub.cards:after:start').every((span) => span === undefined)).toBe(true);
    });

    it('sets three consecutive small cards three across (Latest runs among them) and keeps the mediums two-up', async () => {
        // The first-run showcase (owner 10-31): Capacity | New in PRs & Issues, then Machines | Local services | Latest runs.
        const screen = await renderList([builtin('start'), widget('capacity'), widget('triage'), widget('machines', 'small'),
            widget('services', 'small'), builtin('automations')]);
        expect(screen.getTextContent()).toBe('block:start block:capacity block:triage block:machines block:services block:automations');
        expect(await cardWidths(screen, 'home-hub.cards:after:start')).toEqual([
            ['block:capacity', '50%'], ['block:triage', '50%'],
            ...['machines', 'services', 'automations'].map(id => [`block:${id}`, `${100 / 3}%`]),
        ]);
        // Two smalls are not a row of three: they stay two-up.
        const pair = await renderList([widget('machines', 'small'), builtin('automations')]);
        expect(await cardWidths(pair, 'home-hub.cards:root')).toEqual([
            ['block:machines', '50%'], ['block:automations', '50%'],
        ]);
    });

    it('lets the lead card (Machines with no machine yet, 58d AF1) lead the cards on its own row, Get set up after them; the rest keep their order', async () => {
        const sections = [builtin('start'), builtin('setup'), widget('capacity'), widget('triage'), widget('machines', 'small'),
            widget('services', 'small'), builtin('automations')];
        const saved = JSON.stringify(sections);
        const screen = await renderScreen(
            <HomeHubSectionList
                sections={sections}
                leadCardId="machines"
                renderSection={(section, _index, placement) => `block:${section.id}${placement.leads ? ':leads' : ''}${placement.inRowOfThree ? ':regular' : ''}`}
            />,
        );
        // The small it left behind (Local services) keeps the regular height a row of smalls takes.
        // Composer, then where agents run, then the cards; what Get set up still asks waits below them.
        expect(screen.getTextContent()).toBe('block:start block:machines:leads block:capacity block:triage block:services:regular block:automations:regular block:setup');
        // Machines owns its row; the two smalls left behind are no row of three, so everything after pairs up two-up.
        expect(await cardWidths(screen, 'home-hub.cards:after:start')).toEqual([
            ['block:machines:leads', '100%'],
            ...['capacity', 'triage', 'services:regular', 'automations:regular'].map(id => [`block:${id}`, '50%']),
        ]);
        expect(JSON.stringify(sections)).toBe(saved);
        // Without a lead (a machine exists) the saved order and rows return unchanged.
        const plain = await renderList(sections);
        expect(plain.getTextContent()).toBe('block:start block:setup block:capacity block:triage block:machines block:services block:automations');
    });

    it('names the shown Machines widget as the first-run lead, and nothing when it is hidden', async () => {
        const { resolveHomeHubFirstRunLeadId } = await import('./HomeHubSectionList');
        const machines = { ...widget('default:builtin:machine_fleet', 'small'),
            instance: { v: 1 as const, id: 'default:builtin:machine_fleet', definition: { kind: 'builtin' as const, id: 'machine_fleet' }, bindings: {} } };
        expect(resolveHomeHubFirstRunLeadId([builtin('start'), widget('capacity'), machines])).toBe('default:builtin:machine_fleet');
        expect(resolveHomeHubFirstRunLeadId([builtin('start'), widget('capacity'), { ...machines, hidden: true }])).toBeNull();
    });

    it('lets a card that is alone in its row take the whole row instead of leaving a hole', async () => {
        const screen = await renderList([builtin('start'), builtin('automations'), builtin('usage')]);
        expect(cellSpans(screen, 'home-hub.cards:after:start')).toContain('row');
    });

    it('never leaves a hole beside a half-width card: a half with no half beside it takes the row', async () => {
        // Latest runs (half) then a full-width group: the half would sit beside an empty slot.
        const before = await renderList([builtin('automations'), widget('group', 'full'), widget('a'), widget('b'), widget('c')]);
        const rows = before.findByTestId('home-hub.cards:root')!
            .findAll((node) => node.props?.span === 'row' && typeof node.props.children === 'string')
            .map((node) => node.props.children);
        // a and b pair up; Latest runs before the full-width group and c after b each take their row.
        expect([...new Set(rows)]).toEqual(['block:automations', 'block:group', 'block:c']);
    });
    it('preserves a configured full-width copy between independently sized half-width copies', async () => {
        const sections = [widget('first'), widget('wide', 'full'), widget('last')];
        const saved = JSON.stringify(sections);
        const screen = await renderList(sections);
        expect(screen.getTextContent()).toBe('block:first block:wide block:last');
        const grid = screen.findByTestId('home-hub.cards:root');
        const full = grid?.findAll((node) => node.props?.span === 'row' && typeof node.props.children === 'string');
        // Each half stands alone in its row, so each takes the row; the saved sizes are unchanged.
        expect([...new Set(full?.map((node) => node.props.children))]).toEqual(['block:first', 'block:wide', 'block:last']);
        expect(JSON.stringify(sections)).toBe(saved);
    });
    it('keeps equal-area medium and wide footprints distinct while phone reflow preserves saved intent', async () => {
        const sections = [widget('medium', 'medium'), widget('wide', 'wide')];
        const before = JSON.stringify(sections);
        const screen = await renderList(sections);
        const grid = screen.findByTestId('home-hub.cards:root')!;
        const full = grid.findAll(node => node.props?.span === 'row' && typeof node.props.children === 'string');
        // The medium has no half beside it (the wide takes its own row), so it takes the row too.
        expect([...new Set(full.map(node => node.props.children))]).toEqual(['block:medium', 'block:wide']);
        const measured = screen.findAll(node => node.props?.testID === 'home-hub.cards:root' && typeof node.props.onLayout === 'function')[0]!;
        await act(async () => measured.props.onLayout({ nativeEvent: { layout: { width: 390, height: 600 } } }));
        expect(screen.getTextContent()).toBe('block:medium block:wide');
        expect(JSON.stringify(sections)).toBe(before);
    });
    it('puts the composer, Needs your attention and Get set up on the reading column and everything else on the dashboard column', async () => {
        function ColumnProbe(props: Readonly<{ id: string }>) {
            return <>{`${props.id}@${usePageColumn()}`}</>;
        }
        const screen = await renderScreen(
            <PageColumnProvider value="dashboard">
                <HomeHubSectionList
                    sections={[builtin('attention'), builtin('start'), builtin('setup'), widget('w1'), widget('w2')]}
                    renderSection={(section) => <ColumnProbe id={section.id} />}
                />
            </PageColumnProvider>,
        );
        expect(screen.getTextContent()).toBe('attention@reading start@reading setup@reading w1@dashboard w2@dashboard');
    });

    it('lets Get set up take the cards\' dashboard column when it follows them (no machine yet, D1 C4)', async () => {
        function ColumnProbe(props: Readonly<{ id: string }>) {
            return <>{`${props.id}@${usePageColumn()}`}</>;
        }
        const sections = [builtin('attention'), builtin('start'), builtin('setup'), widget('w1'), widget('w2')];
        const render = (leadCardId: string | null) => (
            <PageColumnProvider value="dashboard">
                <HomeHubSectionList sections={sections} leadCardId={leadCardId} renderSection={(section) => <ColumnProbe id={section.id} />} />
            </PageColumnProvider>
        );
        // Below the band it reads at the band's width rather than stepping back to the composer's.
        const firstRun = await renderScreen(render('w2'));
        expect(firstRun.getTextContent()).toBe('attention@reading start@reading w2@dashboard w1@dashboard setup@dashboard');
        // Once a machine exists it returns to its saved place on the reading column.
        const withMachine = await renderScreen(render(null));
        expect(withMachine.getTextContent()).toBe('attention@reading start@reading setup@reading w1@dashboard w2@dashboard');
    });
});
