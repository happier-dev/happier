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

import { WidgetMachineNoticeBoundary } from './WidgetMachineNotice';

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
            expect(noticeCard()?.props).toMatchObject({ kind: 'warning', title: notice()?.sentence });
            const named = { ...machine, metadata: { ...machine.metadata!, displayName: 'resolved-machine-name' } };
            await act(async () => { storage.setState(state => ({ machines: { ...state.machines, [machine.id]: named } })); });
            expect(noticeCard()?.props).toMatchObject({ kind: 'warning', title: named.metadata.displayName });
            await act(async () => { storage.setState(state => ({ machines: { ...state.machines, [machine.id]: { ...named, active: true } } })); });
            expect(noticeCard()).toBeUndefined();
        } finally {
            await screen.unmount();
            storage.setState({ machines: previousMachines });
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
});
