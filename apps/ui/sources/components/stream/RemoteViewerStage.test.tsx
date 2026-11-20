import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { computerScopeKey } from '@/sync/domains/computer/computerControlClient';
import { RemoteViewerStage, remoteViewerContinuingEdges, remoteViewerModes, type RemoteViewerStageControls } from './RemoteViewerStage';

const device = { phone: false };
vi.mock('@/utils/platform/responsive', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/utils/platform/responsive')>();
    return { ...original, useDeviceType: () => (device.phone ? 'phone' : 'tablet') };
});
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

describe('remote viewer stage', () => {
    it('remembers the mode across remounts and isolates Home, Account, Machine, Session and machine-person viewers', async () => {
        let controls!: RemoteViewerStageControls;
        const scope = {serverId: 'mode-home-a', machineId: 'machine-a', sessionId: 'session-a'};
        const key = (account: string, source: Parameters<typeof computerScopeKey>[0]) => JSON.stringify([account, computerScopeKey(source)]);
        const first = key('account-a', scope);
        const render = (viewerKey: string) => <RemoteViewerStage viewerKey={viewerKey} enabled={false} viewport={{width: 800, height: 400}}
            testID="stage" renderInput={value => { controls = value; return null; }}>{null}</RemoteViewerStage>;
        let screen = await renderScreen(render(first));
        await act(async () => controls.setMode('trackpad'));
        expect(controls.mode).toBe('trackpad');
        await screen.unmount();
        screen = await renderScreen(render(first));
        expect(controls.mode).toBe('trackpad');
        for (const other of [key('account-b', scope), key('account-a', {...scope, serverId: 'mode-home-b'}),
            key('account-a', {...scope, machineId: 'machine-b'}), key('account-a', {...scope, sessionId: 'session-b'}),
            key('account-a', {serverId: scope.serverId, machineId: scope.machineId, source: {kind: 'machine-person', personId: 'person-a'}})]) {
            await screen.update(render(other));
            expect(controls.mode).toBe('direct');
        }
        await screen.update(render(first));
        expect(controls.mode).toBe('trackpad');
        await act(async () => controls.setMode('direct'));
        await screen.unmount();
    });

    describe('a passive viewer on a phone', () => {
        // A desktop-shaped page drawn whole from the top of a phone pane: 375 × 234 of 375 × 700.
        const viewport = { width: 375, height: 700 };
        const content = { x: 0, y: 0, width: 375, height: 234 };
        const fillScale = 700 / 234;
        const viewTransform = (screen: Awaited<ReturnType<typeof renderScreen>>) => {
            const style = [screen.findByTestId('stage-view')?.props.style].flat(Infinity) as Array<{ transform?: Array<Record<string, number>> } | undefined>;
            const transform = Object.assign({}, ...(style.find(entry => entry?.transform)?.transform ?? []));
            return { scale: transform.scale, left: transform.translateX - (transform.scale - 1) * viewport.width / 2,
                top: transform.translateY - (transform.scale - 1) * viewport.height / 2 };
        };

        it('fills the pane at rest, pans locally, and leaves the remote page and the viewer shell alone', async () => {
            device.phone = true;
            let controls!: RemoteViewerStageControls;
            let shellRenders = 0;
            let pictureRenders = 0;
            const Picture = () => { pictureRenders += 1; return null; };
            const Shell = (props: Readonly<{ passive: boolean }>) => {
                shellRenders += 1;
                return <RemoteViewerStage enabled viewport={viewport} content={content} passive={props.passive} testID="stage"
                    renderInput={value => { controls = value; return null; }}><Picture /></RemoteViewerStage>;
            };
            const setMode = vi.spyOn(remoteViewerModes, 'set');
            const screen = await renderScreen(<Shell passive />);
            try {
                expect(controls.restTransform).toEqual({ scale: fillScale, x: 0, y: 0 });
                expect(controls.dragPansView).toBe(true);
                expect(viewTransform(screen)).toMatchObject({ scale: fillScale });
                expect(viewTransform(screen).left).toBeCloseTo(0);
                expect(viewTransform(screen).top).toBeCloseTo(0);
                expect(screen.findByTestId('stage-continues')).not.toBeNull();

                // One pan gesture publishes a transform per frame: only the stage follows it.
                const shellBefore = shellRenders;
                const pictureBefore = pictureRenders;
                await act(async () => {
                    for (let step = 1; step <= 10; step += 1) controls.onViewTransformChange({ scale: fillScale, x: -step * 10, y: 0 });
                });
                expect(viewTransform(screen).left).toBeCloseTo(-100);
                expect(shellRenders).toBe(shellBefore);
                expect(pictureRenders).toBe(pictureBefore);
                expect(setMode).not.toHaveBeenCalled();

                // Reset returns to the fill.
                await act(async () => controls.resetZoom());
                expect(viewTransform(screen).left).toBeCloseTo(0);

                // Taking control keeps today's whole page: the controller's own screen sizes the page.
                await screen.update(<Shell passive={false} />);
                expect(controls.restTransform).toEqual({ scale: 1, x: 0, y: 0 });
                expect(controls.dragPansView).toBe(false);
                expect(viewTransform(screen).scale).toBe(1);
                expect(screen.findByTestId('stage-continues')).toBeNull();
            } finally {
                setMode.mockRestore();
                device.phone = false;
                await screen.unmount();
            }
        });

        it('keeps the whole page on wider screens', async () => {
            let controls!: RemoteViewerStageControls;
            const screen = await renderScreen(<RemoteViewerStage enabled viewport={viewport} content={content} passive testID="stage"
                renderInput={value => { controls = value; return null; }}>{null}</RemoteViewerStage>);
            try {
                expect(controls.restTransform).toEqual({ scale: 1, x: 0, y: 0 });
                expect(viewTransform(screen).scale).toBe(1);
            } finally {
                await screen.unmount();
            }
        });

        it('names each side of the page that continues past the pane', () => {
            expect(remoteViewerContinuingEdges(viewport, content, { scale: fillScale, x: 0, y: 0 }))
                .toEqual({ top: false, bottom: false, left: false, right: true });
            expect(remoteViewerContinuingEdges(viewport, content, { scale: fillScale, x: -100, y: 0 }))
                .toEqual({ top: false, bottom: false, left: true, right: true });
            expect(remoteViewerContinuingEdges(viewport, content, { scale: 1, x: 0, y: 0 }))
                .toEqual({ top: false, bottom: false, left: false, right: false });
        });
    });
});
