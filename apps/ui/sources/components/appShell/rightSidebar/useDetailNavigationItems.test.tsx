import * as React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import * as owner from './detailNavigationItems';
import { useDetailNavigationItems } from './useDetailNavigationItems';
import type { ResolveRightSidebarTabsInput } from './rightSidebarTabRegistry';

afterEach(() => { standardCleanup(); vi.restoreAllMocks(); });

it('resolves once per changed scope input and preserves items on equivalent renders', async () => {
    const resolve = vi.spyOn(owner, 'resolveDetailNavigationItems');
    const values: ReturnType<typeof useDetailNavigationItems>[] = [];
    function Session(props: Readonly<{ terminal: boolean }>) {
        const input: ResolveRightSidebarTabsInput = { scope: 'session', terminalTabAvailable: props.terminal };
        values.push(useDetailNavigationItems(input));
        return null;
    }
    const screen = await renderScreen(<Session terminal={false} />);
    expect(resolve).toHaveBeenCalledTimes(1);
    const initial = values.at(-1);
    await act(async () => screen.update(<Session terminal={false} />));
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(values.at(-1)).toBe(initial);
    await act(async () => screen.update(<Session terminal />));
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(values.at(-1)?.some(item => item.id === 'terminal')).toBe(true);
});

it('detail-navigation.T1 changes one availability consumer while retaining sibling item and destination identities', async () => {
    const resolve = vi.spyOn(owner, 'resolveDetailNavigationItems');
    const renders = new Map<string, number>();
    let latest: ReturnType<typeof useDetailNavigationItems> = [];
    const Item = React.memo(function Item({ item }: Readonly<{ item: owner.DetailNavigationItem }>) {
        renders.set(item.id, (renders.get(item.id) ?? 0) + 1);
        return React.createElement('span', { 'data-item': item.id }, item.disabledReason ?? 'available');
    });
    function Session({ reason }: Readonly<{ reason?: string }>) {
        latest = useDetailNavigationItems({ scope: 'session', computerAvailable: true, computerDisabledReason: reason });
        return React.createElement(React.Fragment, null, latest.map(item => React.createElement(Item, { key: item.id, item })));
    }
    const screen = await renderScreen(<Session />);
    const initial = latest;
    renders.clear();
    await screen.update(<Session reason="Computer disconnected" />);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(latest.find(item => item.id === 'computer')?.disabledReason).toBe('Computer disconnected');
    expect(renders).toEqual(new Map([['computer', 1]]));
    for (const item of latest) {
        const previous = initial.find(candidate => candidate.id === item.id)!;
        if (item.id !== 'computer') expect(item).toBe(previous);
        expect(item.navigation).toBe(previous.navigation);
    }
    const changed = latest;
    renders.clear();
    await screen.update(<Session reason="Computer disconnected" />);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(latest).toBe(changed);
    expect(renders.size).toBe(0);
});

it('reuses the enclosing Session navigation list instead of resolving a second mounted map', async () => {
    const resolve = vi.spyOn(owner, 'resolveDetailNavigationItems');
    const input = { scope: 'session', presentation: 'mobile' } as const;
    const items = owner.resolveDetailNavigationItems(input);
    let observed: typeof items | undefined;
    function Body() { observed = useDetailNavigationItems(input, { items, input }); return null; }
    await renderScreen(<Body />);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(observed).toBe(items);
});

it('resolves its own desktop list beside an enclosing phone list, so Editor first still makes Session tools pages', async () => {
    const phoneInput = { scope: 'session', presentation: 'mobile' } as const;
    const phoneItems = owner.resolveDetailNavigationItems(phoneInput);
    const desktopInput = { scope: 'session', presentation: 'desktop', arrangement: 'editor' } as const;
    let observed: readonly owner.DetailNavigationItem[] | undefined;
    function Body() { observed = useDetailNavigationItems(desktopInput, { items: phoneItems, input: phoneInput }); return null; }
    await renderScreen(<Body />);
    expect(observed).not.toBe(phoneItems);
    expect(observed?.find(item => item.id === 'info')?.navigation.kind).toBe('both');
});
