import { afterEach, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import type { RegistryCatalogItemSummary } from '@/registries/registryBrandMark';

vi.mock('@react-navigation/native', async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
const { useRegistryRows } = await import('./StoreKindPage');

afterEach(standardCleanup);

const item = (itemId: string): RegistryCatalogItemSummary => ({ sourceId: 'catalog', kind: 'mcpServer', itemId, title: `Server ${itemId}` });
const sourceTitle = () => 'Catalog';

it('keeps a catalog row as the same object while the list around it changes', async () => {
    const [a, b, c] = [item('a'), item('b'), item('c')];
    const curation: [] = [];
    // The caller hands over fresh callbacks and a fresh filtered array on every render, as the kind page does.
    const render = (items: readonly RegistryCatalogItemSummary[]) => ({
        list: { items, curation }, open: () => {}, sourceTitle: (id: string) => sourceTitle() + id, isAdded: () => false, add: () => {},
    });
    const hook = await renderHook((props: ReturnType<typeof render>) =>
        useRegistryRows(props.list, props.open, props.sourceTitle, props.isAdded, props.add), { initialProps: render([a, b, c]) });
    const before = hook.getCurrent().rows;
    expect(before).toHaveLength(3);

    // A search narrows the list; the rows that stay in it are the rows the Collection already drew.
    await hook.rerender(render([a, c]));
    const after = hook.getCurrent().rows;
    expect(after).toHaveLength(2);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[2]);

    // The same items under a new filtered array and new callbacks change nothing.
    await hook.rerender(render([a, c]));
    expect(hook.getCurrent().rows).toBe(after);
});

it('rebuilds only the row whose state the Account changed', async () => {
    const [a, b] = [item('a'), item('b')];
    const curation: [] = [];
    const render = (added: ReadonlySet<string>) => ({
        list: { items: [a, b], curation }, isAdded: (candidate: RegistryCatalogItemSummary) => added.has(candidate.itemId),
    });
    const hook = await renderHook((props: ReturnType<typeof render>) =>
        useRegistryRows(props.list, () => {}, sourceTitle, props.isAdded, () => {}), { initialProps: render(new Set()) });
    const before = hook.getCurrent().rows;
    await hook.rerender(render(new Set(['b'])));
    const after = hook.getCurrent().rows;
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[1]?.added).toBe(true);
});

const discovery = (categoryItems: readonly string[], otherItems: readonly string[] = []) => [{ sourceId: 'curated', discovery: {
    items: [...categoryItems, ...otherItems].map(id => ({ id, title: `Curated ${id}`, description: `Why ${id}`,
        reference: { type: 'registryItem' as const, kind: 'mcpServer' as const, sourceId: 'catalog', itemId: id } })),
    categories: [{ id: 'monitoring', title: 'Monitoring', items: [...categoryItems] }], jobs: [],
} }] as unknown as Parameters<typeof useRegistryRows>[0]['curation'];

it('leads an unfiltered page with its curated sections, even for items the first alphabetical page has not reached', async () => {
    const hook = await renderHook(() => useRegistryRows(
        { items: [item('a')], curation: discovery(['zulu'], ['yankee']), curatedKind: 'mcpServer' }, () => {}, sourceTitle));
    const { rows, groups } = hook.getCurrent();
    expect(groups.map(group => group.title)).toEqual(['Happier picks', 'Monitoring', 'From Catalog']);
    expect(rows.find(row => row.title === 'Curated zulu')).toMatchObject({ group: 'category:["curated","monitoring"]', description: 'Why zulu' });
    expect(rows.find(row => row.title === 'Curated yankee')?.group).toBe('picks');
});

it('keeps one row for a curated item once its catalog page arrives, and adds none while a search narrows the list', async () => {
    const curation = discovery(['a']);
    const paged = await renderHook(() => useRegistryRows({ items: [item('a')], curation, curatedKind: 'mcpServer' }, () => {}, sourceTitle));
    expect(paged.getCurrent().rows.map(row => row.title)).toEqual(['Curated a']);
    expect(paged.getCurrent().groups.map(group => group.title)).toEqual(['Monitoring']);
    const narrowed = await renderHook(() => useRegistryRows({ items: [], curation }, () => {}, sourceTitle));
    expect(narrowed.getCurrent().rows).toEqual([]);
});


it('keeps editorial category and row positions when catalog summaries arrive in a different order', async () => {
    const curation = [{ sourceId: 'curated', discovery: {
        items: ['uptime', 'glitchtip', 'healthchecks'].map(id => ({ id, title: `Curated ${id}`,
            reference: { type: 'registryItem' as const, kind: 'mcpServer' as const, sourceId: 'catalog', itemId: id } })),
        categories: [{ id: 'monitoring', title: 'Monitoring', items: ['uptime', 'healthchecks'] },
            { id: 'errors', title: 'Error tracking', items: ['glitchtip'] }], jobs: [],
    } }];
    const hook = await renderHook((items: readonly RegistryCatalogItemSummary[]) => useRegistryRows(
        { items, curation, curatedKind: 'mcpServer' }, () => {}, sourceTitle), { initialProps: [] });
    const positions = () => ({ groups: hook.getCurrent().groups.map(group => group.title),
        rows: hook.getCurrent().rows.map(row => row.key) });
    const before = positions();
    expect(before.groups).toEqual(['Monitoring', 'Error tracking']);
    await hook.rerender([item('glitchtip')]);
    expect(positions()).toEqual(before);
    // Editorial words determine row height; native hydration must not replace them mid-read.
    expect(hook.getCurrent().rows.map(row => row.title)).toEqual(['Curated uptime', 'Curated glitchtip', 'Curated healthchecks']);
    await hook.rerender([item('glitchtip'), item('healthchecks'), item('uptime'), item('wordpress')]);
    expect(positions()).toEqual({ groups: [...before.groups, 'From Catalog'],
        rows: [...before.rows, 'mcpServer|catalog|wordpress'] });
});

it('keeps the curated exact version for opening and adding after a newer listing arrives', async () => {
    const curation = discovery(['a']).map(page => ({ ...page, discovery: { ...page.discovery,
        items: page.discovery.items.map(entry => ({ ...entry, reference: { ...entry.reference, version: '1' } })),
    } }));
    const open = vi.fn();
    const add = vi.fn();
    const hook = await renderHook((items: readonly RegistryCatalogItemSummary[]) => useRegistryRows(
        { items, curation, curatedKind: 'mcpServer' }, open, sourceTitle, undefined, add), { initialProps: [] });
    await hook.rerender([{ ...item('a'), version: '2' }]);
    expect(hook.getCurrent().rows).toHaveLength(1);
    hook.getCurrent().rows[0]!.open();
    hook.getCurrent().rows[0]!.add?.();
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'a', version: '1' }));
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'a', version: '1' }));
    const pinned = hook.getCurrent().rows[0];
    await hook.rerender([item('a')]);
    expect(hook.getCurrent().rows[0]).toBe(pinned);
    hook.getCurrent().rows[0]!.open();
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ version: '1' }));
    const exact = { ...item('a'), version: '1' };
    await hook.rerender([exact]);
    hook.getCurrent().rows[0]!.open();
    expect(open).toHaveBeenLastCalledWith(exact);
});
