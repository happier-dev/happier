import * as React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import { usePetPointerDragSession } from './usePetPointerDragSession';

const platformState = vi.hoisted(() => ({
    os: 'web',
}));

vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-native')>();
    return {
        ...actual,
        Platform: {
            ...actual.Platform,
            get OS() {
                return platformState.os;
            },
        },
    };
});

class TestPointerEvent extends Event {
    button: number;
    pointerId: number;
    clientX: number;
    clientY: number;
    screenX: number;
    screenY: number;
    timeStamp: number;

    constructor(type: string, init: {
        button?: number;
        pointerId?: number;
        clientX: number;
        clientY: number;
        screenX: number;
        screenY: number;
        timeStamp?: number;
    }) {
        super(type);
        this.button = init.button ?? 0;
        this.pointerId = init.pointerId ?? 1;
        this.clientX = init.clientX;
        this.clientY = init.clientY;
        this.screenX = init.screenX;
        this.screenY = init.screenY;
        this.timeStamp = init.timeStamp ?? 0;
    }
}

function closestMascot(selector: string): object | null {
    return selector.includes('data-pet-mascot') ? {} : null;
}

describe('usePetPointerDragSession', () => {
    afterEach(() => {
        standardCleanup();
        platformState.os = 'web';
        vi.unstubAllGlobals();
    });

    it('captures and releases the pointer on a real web target', async () => {
        const fakeWindow = new EventTarget();
        vi.stubGlobal('window', fakeWindow);
        const setPointerCapture = vi.fn();
        const releasePointerCapture = vi.fn();
        const onDragMove = vi.fn();

        function Harness() {
            const drag = usePetPointerDragSession({
                coordinateSpace: 'screen',
                onDragMove,
            });
            return (
                <View
                    ref={drag.dragTargetRef}
                    testID="pet-drag-target"
                    {...drag.pointerHandlers}
                />
            );
        }

        const screen = await renderScreen(<Harness />);
        const target = screen.findByTestId('pet-drag-target');

        await act(async () => {
            target?.props.onPointerDown?.({
                button: 0,
                pointerId: 7,
                clientX: 10,
                clientY: 20,
                screenX: 100,
                screenY: 200,
                timeStamp: 0,
                target: { closest: closestMascot },
                currentTarget: { setPointerCapture, releasePointerCapture },
                preventDefault: vi.fn(),
            });
        });

        expect(setPointerCapture).toHaveBeenCalledWith(7);

        await act(async () => {
            fakeWindow.dispatchEvent(new TestPointerEvent('pointermove', {
                pointerId: 7,
                clientX: 11,
                clientY: 22,
                screenX: 112,
                screenY: 206,
                timeStamp: 20,
            }));
            fakeWindow.dispatchEvent(new TestPointerEvent('pointerup', {
                pointerId: 7,
                clientX: 11,
                clientY: 22,
                screenX: 112,
                screenY: 206,
                timeStamp: 25,
            }));
        });

        expect(onDragMove).toHaveBeenCalledWith(expect.objectContaining({
            coordinateSpace: 'screen',
            deltaX: 12,
            deltaY: 6,
        }));
        expect(releasePointerCapture).toHaveBeenCalledWith(7);
    });

    it('starts a drag from a mouse fallback when pointer events are not delivered', async () => {
        const fakeWindow = new EventTarget();
        vi.stubGlobal('window', fakeWindow);
        const onDragStart = vi.fn();
        const onDragMove = vi.fn();

        function Harness() {
            const drag = usePetPointerDragSession({
                coordinateSpace: 'screen',
                onDragMove,
                onDragStart,
            });
            return (
                <View
                    ref={drag.dragTargetRef}
                    testID="pet-drag-target"
                    {...drag.pointerHandlers}
                />
            );
        }

        const screen = await renderScreen(<Harness />);
        const target = screen.findByTestId('pet-drag-target');

        await act(async () => {
            target?.props.onMouseDown?.({
                button: 0,
                clientX: 10,
                clientY: 20,
                screenX: 100,
                screenY: 200,
                timeStamp: 0,
                target: { closest: closestMascot },
                currentTarget: {},
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });

        await act(async () => {
            fakeWindow.dispatchEvent(new TestPointerEvent('mousemove', {
                pointerId: 1,
                clientX: 30,
                clientY: 20,
                screenX: 130,
                screenY: 200,
                timeStamp: 20,
            }));
        });

        expect(onDragStart).toHaveBeenCalledWith(expect.objectContaining({
            screenX: 100,
            screenY: 200,
            coordinateSpace: 'screen',
        }));
        expect(onDragMove).toHaveBeenCalledWith(expect.objectContaining({
            deltaX: 30,
            deltaY: 0,
        }));
    });

    it('keeps below-threshold movement as an activation instead of a drag move', async () => {
        const fakeWindow = new EventTarget();
        vi.stubGlobal('window', fakeWindow);
        const onDragMove = vi.fn();
        const onDragEnd = vi.fn();
        const onActivate = vi.fn();

        function Harness() {
            const drag = usePetPointerDragSession({
                coordinateSpace: 'screen',
                onDragMove,
                onDragEnd,
                onActivate,
            });
            return (
                <View
                    ref={drag.dragTargetRef}
                    testID="pet-drag-target"
                    {...drag.pointerHandlers}
                />
            );
        }

        const screen = await renderScreen(<Harness />);
        const target = screen.findByTestId('pet-drag-target');

        await act(async () => {
            target?.props.onPointerDown?.({
                button: 0,
                pointerId: 8,
                clientX: 10,
                clientY: 20,
                screenX: 100,
                screenY: 200,
                timeStamp: 0,
                target: { closest: closestMascot },
                currentTarget: {},
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });

        await act(async () => {
            fakeWindow.dispatchEvent(new TestPointerEvent('pointermove', {
                pointerId: 8,
                clientX: 12,
                clientY: 20,
                screenX: 102,
                screenY: 200,
                timeStamp: 10,
            }));
            fakeWindow.dispatchEvent(new TestPointerEvent('pointerup', {
                pointerId: 8,
                clientX: 12,
                clientY: 20,
                screenX: 102,
                screenY: 200,
                timeStamp: 20,
            }));
        });

        expect(onDragMove).not.toHaveBeenCalled();
        expect(onDragEnd).toHaveBeenCalledWith(expect.objectContaining({
            pointerId: 8,
            cancelled: false,
            coordinateSpace: 'screen',
        }));
        expect(onActivate).toHaveBeenCalledTimes(1);
    });

    it('ignores pointer starts that did not originate on the mascot', async () => {
        const fakeWindow = new EventTarget();
        vi.stubGlobal('window', fakeWindow);
        const setPointerCapture = vi.fn();
        const onDragStart = vi.fn();
        const onDragMove = vi.fn();

        function Harness() {
            const drag = usePetPointerDragSession({
                coordinateSpace: 'screen',
                onDragMove,
                onDragStart,
            });
            return (
                <View
                    ref={drag.dragTargetRef}
                    testID="pet-drag-target"
                    {...drag.pointerHandlers}
                />
            );
        }

        const screen = await renderScreen(<Harness />);
        const target = screen.findByTestId('pet-drag-target');

        await act(async () => {
            target?.props.onPointerDown?.({
                button: 0,
                pointerId: 6,
                clientX: 10,
                clientY: 20,
                screenX: 100,
                screenY: 200,
                timeStamp: 0,
                target: {},
                currentTarget: { setPointerCapture },
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });

        await act(async () => {
            fakeWindow.dispatchEvent(new TestPointerEvent('pointermove', {
                pointerId: 6,
                clientX: 30,
                clientY: 20,
                screenX: 300,
                screenY: 200,
                timeStamp: 10,
            }));
        });

        expect(setPointerCapture).not.toHaveBeenCalled();
        expect(onDragStart).not.toHaveBeenCalled();
        expect(onDragMove).not.toHaveBeenCalled();
    });

    it('ignores move and end events from a different active pointer', async () => {
        const fakeWindow = new EventTarget();
        vi.stubGlobal('window', fakeWindow);
        const onDragMove = vi.fn();
        const onDragEnd = vi.fn();

        function Harness() {
            const drag = usePetPointerDragSession({
                coordinateSpace: 'screen',
                onDragMove,
                onDragEnd,
            });
            return (
                <View
                    ref={drag.dragTargetRef}
                    testID="pet-drag-target"
                    {...drag.pointerHandlers}
                />
            );
        }

        const screen = await renderScreen(<Harness />);
        const target = screen.findByTestId('pet-drag-target');

        await act(async () => {
            target?.props.onPointerDown?.({
                button: 0,
                pointerId: 9,
                clientX: 10,
                clientY: 20,
                screenX: 100,
                screenY: 200,
                timeStamp: 0,
                target: { closest: closestMascot },
                currentTarget: {},
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });

        await act(async () => {
            fakeWindow.dispatchEvent(new TestPointerEvent('pointermove', {
                pointerId: 10,
                clientX: 30,
                clientY: 20,
                screenX: 300,
                screenY: 200,
                timeStamp: 10,
            }));
            fakeWindow.dispatchEvent(new TestPointerEvent('pointerup', {
                pointerId: 10,
                clientX: 30,
                clientY: 20,
                screenX: 300,
                screenY: 200,
                timeStamp: 20,
            }));
        });

        expect(onDragMove).not.toHaveBeenCalled();
        expect(onDragEnd).not.toHaveBeenCalled();
    });
});
