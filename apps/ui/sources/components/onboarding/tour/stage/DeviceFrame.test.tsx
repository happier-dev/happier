import * as React from 'react';
import { StyleSheet, Text } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';

import {
    DeviceFrame,
    STAGE_DEVICE_CANVASES,
    readWebDeviceFrameSize,
    resolveDeviceFrameViewportGeometry,
    resolveWebDeviceFrameEntranceStyle,
    resolveDeviceFrameLayout,
} from './DeviceFrame';
import { stageVisualTokens } from './stageVisualTokens';

function flattenStyle(style: unknown): Record<string, unknown> {
    return StyleSheet.flatten(style) as Record<string, unknown>;
}

describe('DeviceFrame', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('resolves a desktop logical canvas fit inside both pane dimensions with generous margins', () => {
        expect(STAGE_DEVICE_CANVASES.desktop).toEqual({ width: 1280, height: 800 });
        // Real app chrome (D20): the window has NO title bar, so the content is
        // full-bleed and the frame height equals the scaled viewport height.
        expect(resolveDeviceFrameLayout('desktop', 1000, 700)).toEqual({
            logicalWidth: 1280,
            logicalHeight: 800,
            scale: 0.609375,
            containerWidth: 780,
            containerHeight: 487.5,
            frameWidth: 780,
            frameHeight: 487.5,
        });
    });

    it('projects the logical desktop canvas into the stage coordinate space used by camera targets', () => {
        expect(resolveDeviceFrameViewportGeometry('desktop', 1000, 700)).toEqual({
            x: 110,
            y: 92.25,
            width: 780,
            height: 487.5,
            scale: 0.609375,
        });
    });

    it('recovers the current web host size after a transient tiny onLayout measurement', () => {
        expect(readWebDeviceFrameSize({
            getBoundingClientRect: () => ({ width: 1000, height: 700 }),
        })).toEqual({ width: 1000, height: 700 });
        expect(readWebDeviceFrameSize({
            getBoundingClientRect: () => ({ width: 0, height: 700 }),
        })).toBeNull();
    });

    it('makes a measured web frame visible while retaining the entrance transition', () => {
        expect(resolveWebDeviceFrameEntranceStyle(false)).toMatchObject({
            opacity: 0,
            transform: [{ scale: 0.98 }],
        });
        expect(resolveWebDeviceFrameEntranceStyle(true)).toMatchObject({
            opacity: 1,
            transform: [{ scale: 1 }],
            transitionDuration: `${stageVisualTokens.motion.skipTransitionMs}ms`,
        });
    });

    it('resolves a phone logical canvas fit inside both pane dimensions', () => {
        expect(STAGE_DEVICE_CANVASES.phone).toEqual({ width: 390, height: 844 });
        const layout = resolveDeviceFrameLayout('phone', 430, 760);
        expect(layout.logicalWidth).toBe(390);
        expect(layout.logicalHeight).toBe(844);
        expect(layout.scale).toBeCloseTo(0.702, 3);
        expect(layout.containerWidth).toBeCloseTo(274, 0);
        expect(layout.containerHeight).toBeCloseTo(593, 0);
        expect(layout.frameHeight).toBeLessThanOrEqual(760 * stageVisualTokens.phoneFrame.maxPaneHeightRatio);
    });

    it('hosts children in a top-left fixed logical canvas scaled from onLayout width and height', async () => {
        const screen = await renderScreen(
            <DeviceFrame device="desktop" testID="demo-frame">
                <Text testID="frame-child">inside</Text>
            </DeviceFrame>,
        );

        const frame = screen.findByTestId('demo-frame');
        await act(async () => {
            invokeTestInstanceHandler(
                frame,
                'onLayout',
                { nativeEvent: { layout: { width: 1000, height: 700 } } },
                'demo-frame',
            );
        });

        const shell = screen.findByTestId('demo-frame-shell');
        const viewport = screen.findByTestId('demo-frame-viewport');
        const canvas = screen.findByTestId('demo-frame-canvas');

        expect(flattenStyle(shell?.props.style)).toMatchObject({
            width: 780,
            height: 487.5,
        });
        expect(flattenStyle(viewport?.props.style)).toMatchObject({
            width: 780,
            height: 487.5,
        });
        expect(flattenStyle(canvas?.props.style)).toMatchObject({
            width: 1280,
            height: 800,
            transformOrigin: 'top left',
            transform: [{ scale: 0.609375 }],
        });
        expect(screen.findByTestId('frame-child')).not.toBeNull();
    });

    it('notifies the stage owner after the web viewport geometry commits so visual targets remeasure', async () => {
        const onViewportGeometryChange = vi.fn();
        const screen = await renderScreen(
            <DeviceFrame
                device="desktop"
                testID="demo-frame"
                onViewportGeometryChange={onViewportGeometryChange}
            >
                <Text>inside</Text>
            </DeviceFrame>,
        );

        expect(onViewportGeometryChange).not.toHaveBeenCalled();

        await act(async () => {
            invokeTestInstanceHandler(
                screen.findByTestId('demo-frame'),
                'onLayout',
                { nativeEvent: { layout: { width: 1000, height: 700 } } },
                'demo-frame',
            );
        });

        expect(onViewportGeometryChange).toHaveBeenLastCalledWith({
            x: 110,
            y: 92.25,
            width: 780,
            height: 487.5,
            scale: 0.609375,
        });
    });

    it('renders desktop as the real app: no title bar, full-bleed content, overlay traffic lights', async () => {
        const screen = await renderScreen(
            <DeviceFrame device="desktop" testID="demo-frame">
                <Text>inside</Text>
            </DeviceFrame>,
        );

        // D20 / spec §3: no fake title bar, no centered "Happier" text — the
        // real app uses titleBarStyle Overlay + hiddenTitle. Only decorative
        // traffic lights survive, positioned as an absolute top-left overlay in
        // the inset the OS overlay chrome would occupy.
        expect(screen.findByTestId('demo-frame-window-title')).toBeNull();
        expect(screen.findByTestId('demo-frame-traffic-overlay')).not.toBeNull();
        expect(screen.findByTestId('demo-frame-traffic-red')).not.toBeNull();
        expect(screen.findByTestId('demo-frame-traffic-yellow')).not.toBeNull();
        expect(screen.findByTestId('demo-frame-traffic-green')).not.toBeNull();
        expect(flattenStyle(screen.findByTestId('demo-frame-traffic-overlay')?.props.style)).toMatchObject({
            position: 'absolute',
            left: stageVisualTokens.desktopWindow.trafficLightInset,
            top: stageVisualTokens.desktopWindow.trafficLightOverlayTop,
            gap: stageVisualTokens.desktopWindow.trafficLightGap,
        });
        expect(flattenStyle(screen.findByTestId('demo-frame-traffic-red')?.props.style)).toMatchObject({
            width: stageVisualTokens.desktopWindow.trafficLightSize,
            height: stageVisualTokens.desktopWindow.trafficLightSize,
            backgroundColor: stageVisualTokens.desktopWindow.trafficRed,
        });
        // Full-bleed viewport: all four corners rounded to the window radius.
        expect(flattenStyle(screen.findByTestId('demo-frame-viewport')?.props.style)).toMatchObject({
            borderRadius: stageVisualTokens.desktopWindow.radius,
        });
        expect(flattenStyle(screen.findByTestId('demo-frame-shell')?.props.style)).toMatchObject({
            borderRadius: stageVisualTokens.desktopWindow.radius,
            boxShadow: stageVisualTokens.desktopWindow.lightShadow,
        });
    });

    it('renders phone as the website-style bezel with notch and side buttons', async () => {
        const screen = await renderScreen(
            <DeviceFrame device="phone" testID="demo-frame">
                <Text>inside</Text>
            </DeviceFrame>,
        );

        expect(screen.findByTestId('demo-frame-phone-rail')).not.toBeNull();
        expect(screen.findByTestId('demo-frame-phone-bezel')).not.toBeNull();
        expect(screen.findByTestId('demo-frame-phone-notch')).not.toBeNull();
        expect(screen.findByTestId('demo-frame-phone-button-left')).not.toBeNull();
        expect(screen.findByTestId('demo-frame-phone-button-right')).not.toBeNull();
        expect(screen.findByTestId('demo-frame-window-chrome')).toBeNull();
        expect(flattenStyle(screen.findByTestId('demo-frame-phone-rail')?.props.style)).toMatchObject({
            borderRadius: stageVisualTokens.phoneFrame.outerRadius,
            backgroundColor: stageVisualTokens.phoneFrame.bezelColor,
            borderColor: stageVisualTokens.phoneFrame.edgeColor,
        });
        expect(flattenStyle(screen.findByTestId('demo-frame-phone-bezel')?.props.style)).toMatchObject({
            borderRadius: stageVisualTokens.phoneFrame.screenRadius,
        });
    });

    it('keeps the initial shell invisible until pane dimensions are measured', async () => {
        const screen = await renderScreen(
            <DeviceFrame device="desktop" testID="demo-frame">
                <Text testID="frame-child">inside</Text>
            </DeviceFrame>,
        );

        expect(flattenStyle(screen.findByTestId('demo-frame-shell')?.props.style)).toMatchObject({
            opacity: 0,
            width: 0,
            height: 0,
        });
        expect(screen.findByTestId('frame-child')).not.toBeNull();
    });

    it('uses the preferred desktop window proportion when height is unconstrained', () => {
        expect(resolveDeviceFrameLayout('desktop', 640)).toEqual({
            logicalWidth: 1280,
            logicalHeight: 800,
            scale: 0.39,
            containerWidth: 499.20000000000005,
            containerHeight: 312,
            frameWidth: 499.20000000000005,
            frameHeight: 312,
        });
    });
});
