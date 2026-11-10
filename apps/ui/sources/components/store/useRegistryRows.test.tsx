import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import type { RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import type { RegistryCatalogItemSummary } from '@/registries/registryBrandMark';

vi.mock('@react-navigation/native', async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
const { useRegistryRows, previewSourceSections, STORE_SECTION_PREVIEW_ROWS } = await import('./StoreKindPage');

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

it('places native App catalog groups before imported database tools regardless of source arrival order', async () => {
    const imported: RegistryCatalogItemSummary = { sourceId: 'imported-apps', kind: 'app', itemId: 'admin', title: 'Database administration' };
    const database: RegistryCatalogItemSummary = { sourceId: 'native-templates', kind: 'app', itemId: 'engine', title: 'Database engine' };
    const sources = [
        { id: imported.sourceId, format: 'dokploy-templates' as const, kinds: ['app' as const] },
        { id: database.sourceId, format: 'happier-catalog' as const, kinds: ['app' as const] },
    ] satisfies readonly Pick<RegistrySourceDescriptorV1, 'id' | 'format' | 'kinds'>[];
    const curation = [{ sourceId: 'editorial', discovery: {
        items: [{ id: 'admin-pick', title: imported.title, reference: { type: 'registryItem' as const,
            kind: 'app' as const, sourceId: imported.sourceId, itemId: imported.itemId } }],
        categories: [{ id: 'databases', title: 'Database tools', items: ['admin-pick'] }], jobs: [],
    } }];
    const hook = await renderHook((items: readonly RegistryCatalogItemSummary[]) => {
        const list = { items, curation, sources };
        return useRegistryRows(list, () => {}, id => id);
    }, { initialProps: [database, imported] });
    const groups = () => hook.getCurrent().groups.map(group => group.key);
    expect(groups()).toEqual(['source:native-templates', 'category:["editorial","databases"]']);
    const before = new Map(hook.getCurrent().rows.map(row => [row.key, row]));
    await hook.rerender([imported, database]);
    expect(groups()).toEqual(['source:native-templates', 'category:["editorial","databases"]']);
    for (const row of hook.getCurrent().rows) expect(row).toBe(before.get(row.key));
});

describe('previewSourceSections', () => {
  const row = (group: string, index: number) => ({ key: `${group}:${index}`, title: `${group} ${index}`, description: null, mark: null, group, open: () => {} });
  const many = (group: string, count: number) => Array.from({ length: count }, (_, index) => row(group, index));
  const groups = (...keys: string[]) => keys.map(key => ({ key, title: key }));
  const pages = (entries: Record<string, string | null>) => Object.entries(entries).map(([sourceId, nextCursor]) => ({ sourceId, nextCursor }));
  const over = STORE_SECTION_PREVIEW_ROWS + 3;

  it('caps each catalog section to its preview and offers All N through the catalog condition', () => {
    const onSeeSource = vi.fn();
    const preview = previewSourceSections({
      rows: [...many('category:x', over), ...many('source:a', over), ...many('source:b', 2)],
      groups: groups('category:x', 'source:a', 'source:b'),
      pages: pages({ a: null, b: null }),
      onSeeSource,
    });
    expect(preview.rows.filter(entry => entry.group === 'source:a')).toHaveLength(STORE_SECTION_PREVIEW_ROWS);
    // Curated sections and sections that already fit are left alone.
    expect(preview.rows.filter(entry => entry.group === 'category:x')).toHaveLength(over);
    expect(preview.rows.filter(entry => entry.group === 'source:b')).toHaveLength(2);
    expect(preview.groupAction?.('source:b')).toBeNull();
    const action = preview.groupAction?.('source:a');
    expect(action).toMatchObject({ kind: 'link' });
    action?.onPress();
    expect(onSeeSource).toHaveBeenCalledWith('a');
    expect(preview.capped).toBe(true);
  });

  it('says a section\'s count only when its catalog has no further page', () => {
    const preview = previewSourceSections({ rows: [...many('source:a', over), ...many('source:b', over)], groups: groups('source:a', 'source:b'),
      pages: pages({ a: 'next', b: null }), onSeeSource: () => {} });
    expect(preview.groupAction?.('source:a')?.label).not.toBe(preview.groupAction?.('source:b')?.label);
    expect(String(preview.groupAction?.('source:b')?.label)).toContain(String(over));
  });

  it('leaves a page whose only section is that catalog, and any condition, in full', () => {
    const rows = many('source:a', over);
    const single = previewSourceSections({ rows, groups: groups('source:a'), pages: pages({ a: null }), onSeeSource: () => {} });
    expect(single.rows).toBe(rows);
    expect(single.capped).toBe(false);
    expect(single.groupAction).toBeUndefined();
    const narrowed = previewSourceSections({ rows: [...rows, ...many('source:b', over)], groups: groups('source:a', 'source:b'), pages: pages({}), onSeeSource: null });
    expect(narrowed.capped).toBe(false);
    expect(narrowed.groupAction).toBeUndefined();
  });
});
