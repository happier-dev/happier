import 'fake-indexeddb/auto';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { AppPaneProvider, useAppPaneContext } = await import('@/components/appShell/panes/AppPaneProvider');
const { DetailsSurfaceTabLifetimeScope } = await import('@/components/appShell/panes/details/workspace/detailsTabLifetime');
const { ContextualStartComposerBody, useContextualStartComposer } = await import('./ContextualStartComposer');
const { SelectionList } = await import('@/components/ui/selectionList');

let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
beforeEach(async () => {
    await homes.addHome({ name: 'Review filters', serverUrl: 'https://review-filters.test', accountId: 'review-author' });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://review-filters.test', accountId: 'review-author', request: homes.request });
});
afterEach(async () => {
    standardCleanup();
    await connection?.dispose();
    await homes.reset();
});

const SOURCE = {
    enabled: true, where: null, selectedIds: new Set(['claude']),
    search: { value: '', onChange: () => undefined },
    sections: [
        { category: 'engine' as const, section: { kind: 'static' as const, id: 'engines', options: [
            { id: 'claude', label: 'Claude', subtitle: 'Opus 5.5', onSelect: () => undefined },
        ] } },
        { category: 'session' as const, section: { kind: 'static' as const, id: 'sessions', options: [
            { id: 'session', label: 'Existing Session', onSelect: () => undefined },
        ] } },
    ],
};
const ADMISSIBLE = { who: ['engine', 'session'], machine: 'fixed', folder: 'fixed' } as const;

function Composer(props: Readonly<{ step: number }>) {
    const model = useContextualStartComposer(SOURCE, ADMISSIBLE);
    return <ContextualStartComposerBody model={model} presentationKey={`review-step:${props.step}`} />;
}

function Draft(props: Readonly<{ phone: boolean; tab: string; step?: number; closed?: boolean }>) {
    const pane = useAppPaneContext();
    React.useLayoutEffect(() => {
        pane.dispatch(props.closed
            ? { type: 'closeDetailsTab', scopeId: 'session:filter-review', tabKey: props.tab }
            : { type: 'openDetailsTab', scopeId: 'session:filter-review', tab: {
                key: props.tab, kind: 'executionRunLauncher', title: 'Independent check', resource: { kind: 'executionRunLauncher' },
            }, openAs: 'pinned' });
    }, [pane.dispatch, props.closed, props.tab]);
    return props.closed ? null : <DetailsSurfaceTabLifetimeScope scopeId="session:filter-review" tabKey={props.tab}>
        {/* The responsive shell replaces the mounted subtree while retaining the same Details tab. */}
        <Composer key={props.phone ? 'phone' : 'wide'} step={props.step ?? 0} />
    </DetailsSurfaceTabLifetimeScope>;
}

describe('Contextual start Who filter lifetime', () => {
    it('retains the selected filter and reviewer through a real responsive remount, isolated by tab and step', async () => {
        const content = (phone: boolean, tab = 'independent-check', step = 0, closed = false) =>
            <AppPaneProvider><Draft phone={phone} tab={tab} step={step} closed={closed} /></AppPaneProvider>;
        const screen = await renderScreen(content(false));
        await screen.pressByTestIdAsync('contextual-start-change-who');
        await screen.pressByTestIdAsync('contextual-start-who-filter:engine');
        const selectedFilter = () => screen.findByTestId('contextual-start-who-filter:engine')!.props.accessibilityState.checked;
        const chosenReviewer = () => screen.findAllByType(SelectionList)
            .find(node => node.props.testID === 'contextual-start-who')!.props.selection.selectedIds;
        expect(selectedFilter()).toBe(true);
        expect(chosenReviewer().has('claude')).toBe(true);

        await screen.update(content(true));
        await screen.pressByTestIdAsync('contextual-start-change-who');
        expect(selectedFilter()).toBe(true);
        expect(chosenReviewer().has('claude')).toBe(true);

        await screen.update(content(false, 'independent-check', 1));
        await screen.pressByTestIdAsync('contextual-start-change-who');
        expect(selectedFilter()).toBe(false);
        await screen.update(content(true));
        await screen.pressByTestIdAsync('contextual-start-change-who');
        expect(selectedFilter()).toBe(true);

        await screen.update(content(false, 'another-review'));
        await screen.pressByTestIdAsync('contextual-start-change-who');
        expect(selectedFilter()).toBe(false);
        await screen.update(content(true));
        await screen.pressByTestIdAsync('contextual-start-change-who');
        expect(selectedFilter()).toBe(true);

        await screen.update(content(true, 'independent-check', 0, true));
        await screen.update(content(false));
        await screen.pressByTestIdAsync('contextual-start-change-who');
        expect(selectedFilter()).toBe(false);
        await screen.unmount();
    });
});
