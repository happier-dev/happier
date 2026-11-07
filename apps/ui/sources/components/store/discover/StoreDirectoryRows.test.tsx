import { afterEach, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import type { StoreDiscoverItem } from './storeDiscoverModel';

vi.mock('@react-navigation/native', async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
const { useDirectoryRows } = await import('./StoreDirectorySection');

afterEach(standardCleanup);

const item = (id: string): StoreDiscoverItem => ({ id, key: id, sourceId: 'catalog', kind: 'mcpServer', title: `Server ${id}`, description: null,
    reference: { type: 'registryItem', kind: 'mcpServer', sourceId: 'catalog', itemId: id } });

// The page hands the directory fresh section arrays and fresh membership callbacks on every render.
const render = (ids: readonly string[], added: ReadonlySet<string>) => ({
    sections: [{ key: 'picks', title: 'Picks', items: ids.map(item) }],
    isAdded: (candidate: StoreDiscoverItem) => added.has(candidate.id),
});

it('rebuilds only the row whose added state an inventory arrival changed', async () => {
    const hook = await renderHook((props: ReturnType<typeof render>) => useDirectoryRows(props.sections, props.isAdded),
        { initialProps: render(['a', 'b', 'c'], new Set()) });
    const before = hook.getCurrent();
    await hook.rerender(render(['a', 'b', 'c'], new Set()));
    expect(hook.getCurrent()).toBe(before);

    await hook.rerender(render(['a', 'b', 'c'], new Set(['b'])));
    const after = hook.getCurrent();
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[1]?.added).toBe(true);
    expect(after[2]).toBe(before[2]);
});
