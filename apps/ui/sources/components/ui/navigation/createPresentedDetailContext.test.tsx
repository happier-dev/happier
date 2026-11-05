import * as React from 'react';
import { afterEach, expect, it } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createPresentedDetailContext } from './createPresentedDetailContext';
import { NavigationContext } from '@react-navigation/native';
import { createNavigationPropMock } from '@/dev/testkit/mocks/reactNavigation';

afterEach(standardCleanup);

it('presents an embedded detail over its parent and returns to the parent when it closes', async () => {
    const detail = createPresentedDetailContext<string>();
    const seen: Array<string | null> = [];
    function Reader() { seen.push(detail.useValue()); return null; }
    function Child() { detail.usePublish('environment', true); return null; }
    function Parent(props: { child: boolean }) {
        detail.usePublish('project', true);
        return <detail.Boundary>{props.child && <Child />}</detail.Boundary>;
    }
    const view = (child: boolean) => <detail.Provider><Parent child={child} /><Reader /></detail.Provider>;
    const screen = await renderScreen(view(true));
    expect(seen.at(-1)).toBe('environment');
    await screen.update(view(false));
    expect(seen.at(-1)).toBe('project');
});

it('keeps blurred retained native scenes from replacing the focused detail', async () => {
    const detail = createPresentedDetailContext<{ identity: string; activeId: string }>();
    const current = { identity: 'current', activeId: 'overview' };
    const retained = { identity: 'retained', activeId: 'overview' };
    const currentNavigation = createNavigationPropMock({ isFocused: () => true });
    const retainedNavigation = createNavigationPropMock({ isFocused: () => false });
    const seen: Array<typeof current | null> = [];
    function Publisher(props: { value: typeof current }) { detail.usePublish(props.value, true); return null; }
    function Reader() { seen.push(detail.useValue()); return null; }
    const view = (value: typeof retained) => <detail.Provider>
        <NavigationContext.Provider value={currentNavigation}><Publisher value={current} /></NavigationContext.Provider>
        <NavigationContext.Provider value={retainedNavigation}><Publisher value={value} /></NavigationContext.Provider>
        <Reader />
    </detail.Provider>;
    const screen = await renderScreen(view(retained));
    expect(seen.at(-1)).toBe(current);
    await screen.update(view({ ...retained, activeId: 'builds' }));
    expect(seen.at(-1)).toBe(current);
});

it('publishes only while presented and withdraws its own lifetime', async () => {
    const detail = createPresentedDetailContext<string>();
    const seen: Array<string | null> = [];
    function Publisher(props: { presented: boolean }) { detail.usePublish('project', props.presented); return null; }
    const Reader = React.memo(function Reader() { seen.push(detail.useValue()); return null; });
    const view = (presented: boolean) => <detail.Provider><Publisher presented={presented} /><Reader /></detail.Provider>;
    const screen = await renderScreen(view(true));
    expect(seen.at(-1)).toBe('project');
    const before = seen.length;
    await screen.update(view(true));
    expect(seen).toHaveLength(before);
    await screen.update(view(false));
    expect(seen.at(-1)).toBeNull();
});

it('replaces changed descriptors without a null publication gap', async () => {
    const detail = createPresentedDetailContext<{ activeId: string }>();
    const first = { activeId: 'overview' }, next = { activeId: 'builds' };
    const seen: Array<typeof first | null> = [];
    function Publisher(props: { value: typeof first }) { detail.usePublish(props.value, true); return null; }
    const Reader = React.memo(function Reader() { seen.push(detail.useValue()); return null; });
    const view = (value: typeof first) => <detail.Provider><Publisher value={value} /><Reader /></detail.Provider>;
    const screen = await renderScreen(view(first));
    seen.length = 0;
    await screen.update(view(next));
    expect(seen).toEqual([next]);
});

it('does not let an outgoing detail withdraw the incoming model', async () => {
    const detail = createPresentedDetailContext<string>();
    const seen: Array<string | null> = [];
    function Publisher(props: { value: string; presented: boolean }) { detail.usePublish(props.value, props.presented); return null; }
    const Reader = React.memo(function Reader() { seen.push(detail.useValue()); return null; });
    const view = (presented: boolean) => <detail.Provider>
        <Publisher value="outgoing" presented={presented} /><Publisher value="incoming" presented /><Reader />
    </detail.Provider>;
    const screen = await renderScreen(view(true));
    expect(seen.at(-1)).toBe('incoming');
    const before = seen.length;
    await screen.update(view(false));
    expect(seen).toHaveLength(before);
    expect(seen.at(-1)).toBe('incoming');
});
