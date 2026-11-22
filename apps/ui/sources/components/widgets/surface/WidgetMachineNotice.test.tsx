import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { Text } from '@/components/ui/text/Text';
import { storage } from '@/sync/domains/state/storageStore';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { SurfaceStateCard, SurfaceStateContentContext, type SurfaceStateContentReport } from '@/components/ui/surfaces/SurfaceStateCard';
import { WidgetFrameBodyNoticeContext, type WidgetFrameBodyNoticeSource } from '@/components/widgets/frame/widgetFrameBodyCaption';

import { useClaimedPluginUiSurfaceNotice } from '@happier-dev/plugin-ui/advanced';

import { WidgetMachineAddRecoveryContext, WidgetMachineNoticeBoundary } from './WidgetMachineNotice';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerMock = vi.hoisted(() => ({ pushed: [] as unknown[] }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    pathname: '/', router: { push: (href: unknown) => { routerMock.pushed.push(href); } },
}).module);

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

afterEach(() => { standardCleanup(); });

function Lending(props: Readonly<{ notice: WidgetFrameBodyNoticeSource | null }>) {
    const lend = React.useContext(WidgetFrameBodyNoticeContext);
    React.useEffect(() => { lend?.(props.notice); }, [lend, props.notice]);
    return <Text testID="body">rows</Text>;
}

describe('WidgetMachineNoticeBoundary', () => {
    it('says what a body lent about its Machine above the body, once, and stops when the body withdraws it', async () => {
        const render = (notice: WidgetFrameBodyNoticeSource | null) => (
            <WidgetMachineNoticeBoundary testID="widget">
                <Lending notice={notice} />
            </WidgetMachineNoticeBoundary>
        );
        const screen = await renderScreen(render(null));
        await flushHookEffects({ cycles: 2 });
        expect(screen.findByTestId('widget-machine-notice')).toBeNull();
        await screen.update(render(() => ({ sentence: 'This operation is unavailable on Studio Mac.' })));
        await flushHookEffects({ cycles: 2 });
        expect(screen.findByTestId('widget-machine-notice')).not.toBeNull();
        expect(screen.getTextContent().split('This operation is unavailable on Studio Mac.')).toHaveLength(2);
        await screen.update(render(null));
        await flushHookEffects({ cycles: 2 });
        expect(screen.findByTestId('widget-machine-notice')).toBeNull();
    });

    it('updates the lent notice on Machine changes and removes it when the Machine becomes available', async () => {
        const previousMachines = storage.getState().machines;
        const machine = createMachineFixture({ id: 'notice-machine', active: false });
        storage.setState(state => ({ machines: { ...state.machines, [machine.id]: machine } }));
        const notice: WidgetFrameBodyNoticeSource = () => {
            const current = storage.getState().machines[machine.id];
            return current?.active ? undefined : { sentence: current?.metadata?.displayName ?? 'machine-name-pending' };
        };
        const screen = await renderScreen(
            <WidgetMachineNoticeBoundary testID="widget"><Lending notice={notice} /></WidgetMachineNoticeBoundary>,
        );
        try {
            await flushHookEffects({ cycles: 2 });
            const noticeCard = () => screen.tree.root.findAllByType(SurfaceStateCard)
                .find(node => node.props.testID === 'widget-machine-notice');
            expect(noticeCard()?.props).toMatchObject({ kind: 'unavailable', title: notice()?.sentence });
            const named = { ...machine, metadata: { ...machine.metadata!, displayName: 'resolved-machine-name' } };
            await act(async () => { storage.setState(state => ({ machines: { ...state.machines, [machine.id]: named } })); });
            expect(noticeCard()?.props).toMatchObject({ kind: 'unavailable', title: named.metadata.displayName });
            await act(async () => { storage.setState(state => ({ machines: { ...state.machines, [machine.id]: { ...named, active: true } } })); });
            expect(noticeCard()).toBeUndefined();
        } finally {
            await screen.unmount();
            storage.setState({ machines: previousMachines });
        }
    });

    it('skips notice reads on unrelated Account settings publications', async () => {
        const preferredLanguage = storage.getState().settings.preferredLanguage;
        const notice = vi.fn(() => ({ sentence: 'Machine unavailable' }));
        const screen = await renderScreen(
            <WidgetMachineNoticeBoundary testID="widget"><Lending notice={notice} /></WidgetMachineNoticeBoundary>,
        );
        try {
            await flushHookEffects({ cycles: 2 });
            expect(screen.findByTestId('widget-machine-notice')).not.toBeNull();
            notice.mockClear();
            await act(async () => {
                storage.getState().applySettingsLocal({ preferredLanguage: preferredLanguage === 'en' ? 'fr' : 'en' });
            });
            expect(storage.getState().settings.preferredLanguage).not.toBe(preferredLanguage);
            expect(notice).not.toHaveBeenCalled();
        } finally {
            await screen.unmount();
            storage.getState().applySettingsLocal({ preferredLanguage });
        }
    });

    it('keeps the body usable and says it once: in the failure state that claims it, or else as one line with one action', async () => {
        let mounts = 0;
        function MixedBody(props: Readonly<{ failed: boolean }>) {
            const lend = React.useContext(WidgetFrameBodyNoticeContext);
            const [mount] = React.useState(() => ++mounts);
            React.useEffect(() => {
                if (mount === 1) lend?.(() => ({ sentence: 'This operation is unavailable on Studio Mac.' }));
                return () => lend?.(null);
            }, [lend, mount]);
            return (
                <>
                    <Text testID="account-rows">Account rows</Text>
                    {props.failed ? <FailureState /> : null}
                </>
            );
        }
        // What a plugin's own failure state does (plugin-ui `ErrorState`): says the host sentence in its place.
        function FailureState() {
            const sentence = useClaimedPluginUiSurfaceNotice(true);
            return <Text testID="plugin-error">{sentence ?? 'The latest entries could not be read'}</Text>;
        }
        const render = (failed: boolean) => <WidgetMachineNoticeBoundary testID="widget"><MixedBody failed={failed} /></WidgetMachineNoticeBoundary>;
        const screen = await renderScreen(render(true));
        await flushHookEffects({ cycles: 2 });
        expect(screen.findByTestId('widget-body')?.props.style).not.toMatchObject({ display: 'none' });
        expect(screen.getTextContent()).toContain('Account rows');
        expect(screen.getTextContent().split('This operation is unavailable on Studio Mac.')).toHaveLength(2);
        expect(screen.getTextContent()).not.toContain('could not be read');
        expect(screen.findByTestId('widget-machine-notice')).toBeNull();

        // The optional part failed without a failure state of its own: the host says it, once, above the body.
        await screen.update(render(false));
        await flushHookEffects({ cycles: 2 });
        expect(screen.findByTestId('widget-machine-notice')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Account rows');
        expect(screen.getTextContent().split('This operation is unavailable on Studio Mac.')).toHaveLength(2);
        expect(screen.findAllByTestId('widget-machine-notice-secondary-action')).toHaveLength(0);
        await act(async () => { screen.findByTestId('widget-machine-notice-action')!.props.onPress(); });
        await flushHookEffects({ cycles: 2 });
        expect(mounts).toBe(2);
        expect(screen.findByTestId('widget-machine-notice')).toBeNull();
    });

    it('tells its frame the body is one line when a failure state claims the notice, so the card is that line (owner 1111)', async () => {
        const reports = new Map<symbol, SurfaceStateContentReport>();
        const report = (key: symbol, value: SurfaceStateContentReport | null) => { if (value) reports.set(key, value); else reports.delete(key); };
        function Claimant() {
            const sentence = useClaimedPluginUiSurfaceNotice(true);
            return <Text testID="plugin-error">{sentence ?? 'The latest entries could not be read'}</Text>;
        }
        const notice: WidgetFrameBodyNoticeSource = () => ({ sentence: 'Add or connect a machine to use this here.', addMachine: true });
        const render = (claims: boolean) => (
            <SurfaceStateContentContext.Provider value={report}>
                <WidgetMachineNoticeBoundary testID="widget"><Lending notice={notice} />{claims ? <Claimant /> : null}</WidgetMachineNoticeBoundary>
            </SurfaceStateContentContext.Provider>
        );
        const screen = await renderScreen(render(true));
        await flushHookEffects({ cycles: 3 });
        expect(screen.findByTestId('plugin-error')?.props.children).toBe('Add or connect a machine to use this here.');
        expect([...reports.values()]).toEqual([{ empty: false, line: true, loading: false }]);
        // Unclaimed, the host says it above a body that keeps its rows: nothing claims the body is one line.
        await screen.update(render(false));
        await flushHookEffects({ cycles: 3 });
        expect(screen.findByTestId('widget-machine-notice')).not.toBeNull();
        expect([...reports.values()]).toEqual([]);
    });

    it('leads to adding a machine, in place of Retry, when no Machine exists to retry on', async () => {
        const notice: WidgetFrameBodyNoticeSource = () => ({ sentence: 'Add or connect a machine to use this here.', addMachine: true });
        const screen = await renderScreen(
            <WidgetMachineNoticeBoundary testID="widget"><Lending notice={notice} /></WidgetMachineNoticeBoundary>,
        );
        await flushHookEffects({ cycles: 2 });
        const action = screen.findByTestId('widget-machine-notice-action')!;
        expect(JSON.stringify(screen.getTextContent())).toContain('settings.addMachine');
        expect(JSON.stringify(screen.getTextContent())).not.toContain('common.retry');
        await act(async () => { action.props.onPress(); });
        expect(routerMock.pushed).toEqual(['/settings/machines/add']);
    });

    it('says a refused plugin once when the whole body could not open: the host card takes the sentence and its Manage plugin (ACCEPT-B fix 8)', async () => {
        const { PluginReactNativeUnavailable } = await import('@/components/plugins/reactNative/PluginReactNativeUnavailable');
        const sentence = 'PRs & Issues is installed but isn’t ready to run on any of your machines.';
        const notice: WidgetFrameBodyNoticeSource = () => ({ sentence, managePluginId: 'happier.prs' });
        function RefusedBody() {
            const lend = React.useContext(WidgetFrameBodyNoticeContext);
            React.useEffect(() => { lend?.(notice); }, [lend]);
            return <PluginReactNativeUnavailable subjectName="PRs & Issues" onRetry={() => {}} />;
        }
        const screen = await renderScreen(<WidgetMachineNoticeBoundary testID="widget"><RefusedBody /></WidgetMachineNoticeBoundary>);
        await flushHookEffects({ cycles: 3 });
        // One cause, said once, in the body's place; no second generic "can't open" beside it.
        expect(screen.findByTestId('widget-machine-notice')).toBeNull();
        const cards = screen.tree.root.findAllByType(SurfaceStateCard).filter(card => card.props.testID === 'plugin-rn-ui-unavailable');
        expect(cards).toHaveLength(1);
        expect(cards[0]!.props.title).toBe(sentence);
        expect(cards[0]!.props.action?.label).toBe('settingsPlugins.managePlugin');
        expect(JSON.stringify(screen.getTextContent()).split(sentence)).toHaveLength(2);
    });

    it('says one failure when the Home itself is unreachable: the Home cause outranks the plugin line, which steps aside (ACCEPT-D)', async () => {
        const { PluginSurfaceFallback } = await import('@/components/sessions/panes/PluginSurfaceFallback');
        const sentence = 'PRs & Issues is installed but isn’t ready to run on any of your machines.';
        const notice: WidgetFrameBodyNoticeSource = () => ({ sentence, managePluginId: 'happier.prs' });
        function UnreachableBody() {
            const lend = React.useContext(WidgetFrameBodyNoticeContext);
            React.useEffect(() => { lend?.(notice); }, [lend]);
            return <PluginSurfaceFallback testID="plugin-surface-unavailable" reasonCode="account_encryption_mode_unavailable" subjectName="PRs & Issues" onRetry={() => {}} />;
        }
        const screen = await renderScreen(<WidgetMachineNoticeBoundary testID="widget"><UnreachableBody /></WidgetMachineNoticeBoundary>);
        await flushHookEffects({ cycles: 3 });
        expect(screen.findByTestId('widget-machine-notice')).toBeNull();
        expect(JSON.stringify(screen.getTextContent())).not.toContain(sentence);
        const card = screen.tree.root.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'plugin-surface-unavailable');
        expect(card?.props.title).toBe('pluginRuntime.homeUnreachableTitle');
    });

    it('says the host line once in the body when the plugin surface fallback fails for the plugin\'s own reason', async () => {
        const { PluginSurfaceFallback } = await import('@/components/sessions/panes/PluginSurfaceFallback');
        const sentence = 'PRs & Issues is installed but isn’t ready to run on any of your machines.';
        const notice: WidgetFrameBodyNoticeSource = () => ({ sentence, managePluginId: 'happier.prs' });
        function RefusedBody() {
            const lend = React.useContext(WidgetFrameBodyNoticeContext);
            React.useEffect(() => { lend?.(notice); }, [lend]);
            return <PluginSurfaceFallback testID="plugin-surface-unavailable" reasonCode="plugin_resource_unavailable" subjectName="PRs & Issues" onRetry={() => {}} />;
        }
        const screen = await renderScreen(<WidgetMachineNoticeBoundary testID="widget"><RefusedBody /></WidgetMachineNoticeBoundary>);
        await flushHookEffects({ cycles: 3 });
        expect(screen.findByTestId('widget-machine-notice')).toBeNull();
        expect(JSON.stringify(screen.getTextContent()).split(sentence)).toHaveLength(2);
    });
});


it('leaves adding a Machine to the surrounding Machines card', async () => {
    const screen = await renderScreen(<WidgetMachineAddRecoveryContext.Provider value>
        <WidgetMachineNoticeBoundary testID="widget">
            <Lending notice={() => ({ sentence: 'Add a Machine to run this.', addMachine: true })} />
        </WidgetMachineNoticeBoundary>
    </WidgetMachineAddRecoveryContext.Provider>);
    await flushHookEffects({ cycles: 2 });
    expect(screen.getTextContent()).toContain('Add a Machine to run this.');
    expect(screen.findByTestId('widget-machine-notice-action')).toBeNull();
    await screen.unmount();
});
