import * as React from 'react';
import { StyleSheet } from 'react-native';
import { describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';

import { renderScreen } from '@/dev/testkit';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

import { MachinePageTabBodies } from './MachinePageTabBodies';
import type { MachinePageTabEntry } from './machinePageTabs';
import type { MachinePageTabBodyProps, MachinePageTabId, MachinePageTabParams } from './machinePageTabQuery';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Counts = { mounts: number; unmounts: number };
const counts = new Map<string, Counts>();
const presented = new Map<string, boolean>();
const lastParams = new Map<string, MachinePageTabParams>();

function useTracked(name: string) {
    const isPresented = useLayoutPresentationActive();
    presented.set(name, isPresented);
    React.useEffect(() => {
        const entry = counts.get(name) ?? { mounts: 0, unmounts: 0 };
        entry.mounts += 1;
        counts.set(name, entry);
        return () => { entry.unmounts += 1; };
    }, [name]);
}

function tabBody(id: MachinePageTabId) {
    return function TrackedBody(props: MachinePageTabBodyProps) {
        useTracked(id);
        lastParams.set(id, props.params);
        // Overview places its own Ask block inside its body; the other tabs' roots share the page's one.
        return id === 'overview' ? <TrackedAsk name="overview-ask" /> : null;
    };
}

function TrackedAsk(props: Readonly<{ name: string }>) {
    useTracked(props.name);
    return null;
}

const tabs: readonly MachinePageTabEntry[] = (['overview', 'processes', 'storage'] as const).map(id => ({
    id, titleKey: 'machineDetailPage.tabs.overview', Body: tabBody(id), suspendWhenHidden: id !== 'overview',
    parseParams: () => ({ id }) as MachinePageTabParams,
}));

function page(params: MachinePageTabParams) {
    const entry = tabs.find(tab => tab.id === params.id)!;
    const root = !('page' in params) || !params.page;
    return (
        <MachinePageTabBodies
            tabs={tabs}
            active={{ entry, params }}
            body={{ serverId: 'home-a', machineId: 'm1', machineName: 'Studio', setParams: () => {} }}
            barAccessoriesInBar={false}
            footer={<TrackedAsk name="page-ask" />}
            footerShown={params.id !== 'overview' && root}
        />
    );
}

function hostDisplay(tree: Awaited<ReturnType<typeof renderScreen>>, testID: string): unknown {
    const host = tree.findHostByTestId(testID);
    return host ? StyleSheet.flatten(host.props.style)?.display : 'absent';
}

describe('MachinePageTabBodies', () => {
    it.each([
        { id: 'processes', suspendWhenHidden: false },
        { id: 'overview', suspendWhenHidden: true },
    ] as const)('follows the $id declaration when hidden instead of choosing policy by tab id', async ({ id, suspendWhenHidden }) => {
        const store = createStore(() => ({ value: 0 }));
        let renders = 0;
        function LiveBody() {
            const value = useStore(store, state => state.value);
            renders += 1;
            return React.createElement('DeclaredTabValue', { value });
        }
        const entry: MachinePageTabEntry = {
            id, titleKey: 'machineDetailPage.tabs.overview', Body: LiveBody, suspendWhenHidden,
            parseParams: () => ({ id }) as MachinePageTabParams,
        };
        const other = tabs.find(tab => tab.id === 'storage')!;
        const render = (active: MachinePageTabEntry) => <MachinePageTabBodies
            tabs={[entry, other]} active={{ entry: active, params: active.parseParams({}) }}
            body={{ serverId: 'home-a', machineId: 'm1', machineName: 'Studio', setParams: () => {} }}
            barAccessoriesInBar={false} footer={null} footerShown={false}
        />;
        const tree = await renderScreen(render(entry));
        await tree.update(render(other));
        renders = 0;
        await act(async () => { store.setState({ value: 1 }); });
        expect(renders).toBe(suspendWhenHidden ? 0 : 1);
        await tree.update(render(entry));
        expect(tree.findByType('DeclaredTabValue').props.value).toBe(1);
        await tree.unmount();
    });

    it('keeps a visited tab and its Ask composer mounted across a tab round-trip, hidden and quiet while another tab shows', async () => {
        counts.clear();
        const tree = await renderScreen(page({ id: 'overview' }));
        await tree.update(page({ id: 'processes', sort: 'cpu' }));
        await tree.update(page({ id: 'overview' }));
        await tree.update(page({ id: 'processes', sort: 'cpu' }));

        expect(counts.get('overview')).toEqual({ mounts: 1, unmounts: 0 });
        expect(counts.get('overview-ask')).toEqual({ mounts: 1, unmounts: 0 });
        expect(counts.get('processes')).toEqual({ mounts: 1, unmounts: 0 });
        expect(counts.get('page-ask')).toEqual({ mounts: 1, unmounts: 0 });
        // The hidden Overview takes no space and stops its presentation work (vitals demand, composer).
        expect(presented.get('overview')).toBe(false);
        expect(presented.get('processes')).toBe(true);
        expect(hostDisplay(tree, 'machine-page-tab-body.overview')).toBe('none');
        expect(hostDisplay(tree, 'machine-page-tab-body.processes')).not.toBe('none');
        // A retained tab keeps the params it was left with.
        expect(lastParams.get('processes')).toEqual({ id: 'processes', sort: 'cpu' });

        await tree.update(page({ id: 'overview' }));
        expect(presented.get('overview')).toBe(true);
        expect(presented.get('page-ask')).toBe(false);
        await tree.unmount();
    });

    it('sizes the tab body and the page Ask block to their content, so the Ask closes the tab in the page scroll instead of splitting its height', async () => {
        const tree = await renderScreen(page({ id: 'processes' }));
        for (const testID of ['machine-page-tab-body.processes', 'machine-page-tab-footer']) {
            const style = StyleSheet.flatten(tree.findHostByTestId(testID)?.props.style) ?? {};
            expect(style.flex ?? 0).toBe(0);
            expect(style.flexGrow ?? 0).toBe(0);
        }
        await tree.unmount();
    });

    it('hides the page Ask block on a page a tab pushes without rebuilding it, and switching tabs keeps it', async () => {
        counts.clear();
        const tree = await renderScreen(page({ id: 'processes' }));
        await tree.update(page({ id: 'storage', page: 'worktrees' }));
        expect(presented.get('page-ask')).toBe(false);
        await tree.update(page({ id: 'storage' }));
        expect(presented.get('page-ask')).toBe(true);
        expect(counts.get('page-ask')).toEqual({ mounts: 1, unmounts: 0 });
        expect(counts.get('overview')).toBeUndefined();
        await tree.unmount();
    });
});
