import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import { VitalsTile, VitalsTileOpenContext, VitalsTileRoomContext, type VitalsTileRoom } from './VitalsSheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

afterEach(() => { standardCleanup(); });

describe('a Vitals tile that opens its machine page', () => {
    it('opens from its title, leaving the chart and disclosures as their own controls (final-acceptance 9)', async () => {
        const onOpen = vi.fn();
        const screen = await renderScreen(
            <VitalsTileOpenContext.Provider value={{ onOpen, accessibilityLabel: 'Open CPU' }}>
                <VitalsTile testID="tile" label="CPU" value={null}>
                    <React.Fragment>{'chart'}</React.Fragment>
                </VitalsTile>
            </VitalsTileOpenContext.Provider>,
        );
        await screen.pressByTestIdAsync('tile.open');
        expect(onOpen).toHaveBeenCalledTimes(1);
        // The open control holds the title only: the body's own buttons are never nested in it.
        const open = screen.findByTestId('tile.open')!;
        expect(open.findAll(node => Array.isArray(node.children) && node.children.includes('chart'))).toHaveLength(0);
        expect(screen.root.findAll(node => Array.isArray(node.children) && node.children.includes('chart')).length).toBeGreaterThan(0);
        await screen.unmount();
    });

    it('opens from its figure when its host already names it, drawing no label of its own', async () => {
        const onOpen = vi.fn();
        const room: VitalsTileRoom = { layout: 'stack', instruments: 'primary', chartMaximum: false, inset: false, chart: 'plot', fill: false, title: false };
        const screen = await renderScreen(
            <VitalsTileRoomContext.Provider value={room}>
                <VitalsTileOpenContext.Provider value={{ onOpen, accessibilityLabel: 'Open CPU' }}>
                    <VitalsTile testID="tile" label="CPU" value={<React.Fragment>{'12%'}</React.Fragment>}>
                        <React.Fragment>{'chart'}</React.Fragment>
                    </VitalsTile>
                </VitalsTileOpenContext.Provider>
            </VitalsTileRoomContext.Provider>,
        );
        const said = (text: string) => screen.root.findAll(node => Array.isArray(node.children) && node.children.includes(text));
        expect(said('CPU')).toHaveLength(0);
        await screen.pressByTestIdAsync('tile.open');
        expect(onOpen).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('tile.open')!.findAll(node => Array.isArray(node.children) && node.children.includes('12%')).length).toBeGreaterThan(0);
        // The chart stays outside the open control.
        expect(screen.findByTestId('tile.open')!.findAll(node => Array.isArray(node.children) && node.children.includes('chart'))).toHaveLength(0);
        await screen.unmount();
    });
});
