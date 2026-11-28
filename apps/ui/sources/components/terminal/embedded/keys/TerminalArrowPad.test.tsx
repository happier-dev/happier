/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { resetPersistentUiStateForTest } from '@/dev/testkit/cleanup/persistentUiState';
import { getStorage } from '@/sync/domains/state/storageStore';
import { getPersistenceStorage, publishPersistenceStorageCleared } from '@/sync/domains/state/persistenceStorage';
import { ARROW_PAD_METRICS, resolveArrowPadCenter } from './terminalArrowPadGeometry';

const viewport = vi.hoisted(() => ({ width: 390, height: 844, scale: 1, fontScale: 1 }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    useWindowDimensions: () => viewport,
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

const { TerminalArrowPad } = await import('./TerminalArrowPad');
const area = { width: 390, height: 600 };
const portraitKey = 'ui-state:terminal-arrow-pad-tucked-v1:portrait';
const landscapeKey = 'ui-state:terminal-arrow-pad-tucked-v1:landscape';
const portraitPlacementKey = 'ui-state:terminal-arrow-pad-placement-v1:portrait';

beforeEach(async () => {
    viewport.width = 390;
    viewport.height = 844;
    await resetPersistentUiStateForTest();
    getStorage().getState().applyLocalSettings({ terminalArrowPadPlacement: { portrait: null, landscape: null } }, { source: 'ui' });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function renderPad() {
    return renderScreen(<TerminalArrowPad area={area} onArrow={() => {}} testIdPrefix="pad" />);
}

describe('terminal arrow pad device state', () => {
    it('imports the legacy orientation only on use, restores without rewriting settings, and remembers the new owner on reload', async () => {
        const legacy = { portrait: { side: 'left' as const, y: 0.4, tucked: true }, landscape: { side: 'right' as const, y: 0.6, tucked: true } };
        getStorage().getState().applyLocalSettings({ terminalArrowPadPlacement: legacy }, { source: 'ui' });
        const device = getPersistenceStorage();
        expect(device.getString(portraitKey)).toBeUndefined();
        expect(device.getString(landscapeKey)).toBeUndefined();
        const screen = await renderPad();
        expect(screen.findByTestId('pad-arrow-pad-dot')).not.toBeNull();
        expect(device.getString(portraitKey)).toBe('true');
        expect(device.getString(landscapeKey)).toBeUndefined();
        const writes = vi.spyOn(device, 'set');
        const reads = vi.spyOn(device, 'getString');
        await screen.pressByTestIdAsync('pad-arrow-pad-dot');
        expect(screen.findByTestId('pad-arrow-pad')).not.toBeNull();
        expect(reads.mock.calls.filter(([key]) => key === 'local-settings')).toHaveLength(0);
        expect(writes.mock.calls.map(([key]) => key)).toEqual([portraitKey]);
        expect(device.getString(portraitKey)).toBe('false');
        expect(getStorage().getState().localSettings.terminalArrowPadPlacement).toEqual(legacy);
        await screen.unmount();
        publishPersistenceStorageCleared(); // Reload the keyed projection without clearing durable bytes.
        writes.mockClear();
        const reloaded = await renderPad();
        expect(reloaded.findByTestId('pad-arrow-pad')).not.toBeNull();
        expect(writes).not.toHaveBeenCalled();
        await reloaded.unmount();
        viewport.width = 844;
        viewport.height = 390;
        const rotated = await renderPad();
        expect(rotated.findByTestId('pad-arrow-pad-dot')).not.toBeNull();
        expect(device.getString(landscapeKey)).toBe('true');
        expect(device.getString(portraitKey)).toBe('false');
        await rotated.unmount();
    });

    it('writes zero times during moves and commits tucked once with the chosen layout at release', async () => {
        const screen = await renderPad();
        vi.useFakeTimers();
        const device = getPersistenceStorage();
        const writes = vi.spyOn(device, 'set');
        const pad = screen.findByTestId('pad-arrow-pad')!;
        const start = resolveArrowPadCenter(null, area);
        const pageX = area.width - 2 - start.x;
        const event = (x: number) => ({ nativeEvent: { locationX: 40, locationY: 40, pageX: x, pageY: 0 } });
        await act(async () => {
            pad.props.onResponderGrant(event(0));
            await vi.advanceTimersByTimeAsync(ARROW_PAD_METRICS.holdToMoveMs);
        });
        for (let step = 1; step <= 25; step += 1) {
            await act(async () => pad.props.onResponderMove(event(pageX * step / 25)));
        }
        expect(writes).not.toHaveBeenCalled();
        await act(async () => pad.props.onResponderRelease(event(pageX)));
        expect(screen.findByTestId('pad-arrow-pad-dot')).not.toBeNull();
        expect(writes.mock.calls.filter(([key]) => key === portraitKey)).toHaveLength(1);
        expect(writes.mock.calls.filter(([key]) => key === 'local-settings')).toHaveLength(0);
        expect(JSON.parse(device.getString(portraitPlacementKey)!)).toMatchObject({ side: 'right' });
        expect(device.getString(portraitKey)).toBe('true');
        await screen.unmount();
    });
});
