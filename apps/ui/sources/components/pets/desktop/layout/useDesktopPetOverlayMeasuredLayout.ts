import * as React from 'react';

import {
    DESKTOP_PET_OVERLAY_TRAY_MAX_HEIGHT,
    DESKTOP_PET_OVERLAY_TRAY_WIDTH,
    type DesktopPetOverlayGeometry,
} from '@/components/pets/desktop/desktopPetOverlayGeometry';

export type DesktopPetOverlayMeasuredElementId = 'root' | 'mascot' | 'tray' | 'controls';

export type DesktopPetOverlayMeasuredRect = Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
}>;

export type DesktopPetOverlayMeasuredLayout = Readonly<{
    window: Readonly<{
        width: number;
        height: number;
    }>;
    mascot: DesktopPetOverlayMeasuredRect;
    tray: DesktopPetOverlayMeasuredRect | null;
    controls: DesktopPetOverlayMeasuredRect;
}>;

export type DesktopPetOverlayElementMetricsPayload = Readonly<{
    isTrayVisible: boolean;
    mascot: DesktopPetOverlayMeasuredRect;
    tray: DesktopPetOverlayMeasuredRect | null;
    controls: DesktopPetOverlayMeasuredRect;
}>;

export type DesktopPetOverlayNativeLayoutState = DesktopPetOverlayMeasuredLayout & Readonly<{
    placement?: string;
}>;

export type DesktopPetOverlayMeasurementElementResolver = (
    elementId: DesktopPetOverlayMeasuredElementId,
) => Element | null;

type UseDesktopPetOverlayMeasuredLayoutInput = Readonly<{
    enabled: boolean;
    trayVisible: boolean;
    hasTrayItems: boolean;
    geometry: DesktopPetOverlayGeometry;
    windowSize: Readonly<{ width: number; height: number }>;
    elementResolver?: DesktopPetOverlayMeasurementElementResolver;
    onMeasuredLayoutChange?: (layout: DesktopPetOverlayMeasuredLayout) => void;
    onElementMetricsChange?: (metrics: DesktopPetOverlayElementMetricsPayload) => void;
}>;

const elementTestIds = {
    root: 'desktop-pet-overlay-root',
    mascot: 'desktop-pet-overlay-hitbox',
    tray: 'desktop-pet-overlay-tray',
    controls: 'desktop-pet-overlay-context-anchor',
} satisfies Record<DesktopPetOverlayMeasuredElementId, string>;

function defaultElementResolver(elementId: DesktopPetOverlayMeasuredElementId): Element | null {
    const documentRef = globalThis.document;
    if (!documentRef) return null;
    const testId = elementTestIds[elementId];
    return documentRef.querySelector(`[data-testid="${testId}"], [data-test-id="${testId}"]`);
}

function rectFromDomElement(element: Element, rootRect: DOMRect): DesktopPetOverlayMeasuredRect {
    const rect = element.getBoundingClientRect();
    return {
        x: rect.left - rootRect.left,
        y: rect.top - rootRect.top,
        width: rect.width,
        height: rect.height,
    };
}

function buildFallbackMeasuredLayout(input: UseDesktopPetOverlayMeasuredLayoutInput): DesktopPetOverlayMeasuredLayout {
    const window = input.windowSize;
    const mascot = input.hasTrayItems
        ? {
            x: window.width - input.geometry.windowWidth - 36,
            y: window.height - input.geometry.windowHeight - 18,
            width: input.geometry.windowWidth,
            height: input.geometry.windowHeight,
        }
        : {
            x: window.width - input.geometry.windowWidth,
            y: window.height - input.geometry.windowHeight,
            width: input.geometry.windowWidth,
            height: input.geometry.windowHeight,
        };
    const tray = input.trayVisible
        ? {
            x: window.width - DESKTOP_PET_OVERLAY_TRAY_WIDTH - 58,
            y: window.height - input.geometry.windowHeight - 18 - DESKTOP_PET_OVERLAY_TRAY_MAX_HEIGHT,
            width: DESKTOP_PET_OVERLAY_TRAY_WIDTH,
            height: DESKTOP_PET_OVERLAY_TRAY_MAX_HEIGHT,
        }
        : null;
    const controls = input.hasTrayItems
        ? {
            x: window.width - 46 - 30,
            y: window.height - (input.geometry.windowHeight - 12) - 30,
            width: 30,
            height: 30,
        }
        : {
            x: window.width - 14 - 30,
            y: 22,
            width: 30,
            height: 30,
        };

    return { window, mascot, tray, controls };
}

function measureLayout(input: UseDesktopPetOverlayMeasuredLayoutInput): DesktopPetOverlayMeasuredLayout {
    const resolveElement = input.elementResolver ?? defaultElementResolver;
    const rootElement = resolveElement('root');
    const mascotElement = resolveElement('mascot');
    const trayElement = input.trayVisible ? resolveElement('tray') : null;
    const controlsElement = resolveElement('controls');

    if (!rootElement || !mascotElement || !controlsElement) {
        return buildFallbackMeasuredLayout(input);
    }

    const rootRect = rootElement.getBoundingClientRect();
    return {
        window: {
            width: rootRect.width,
            height: rootRect.height,
        },
        mascot: rectFromDomElement(mascotElement, rootRect),
        tray: trayElement ? rectFromDomElement(trayElement, rootRect) : null,
        controls: rectFromDomElement(controlsElement, rootRect),
    };
}

function serializeMeasuredLayout(layout: DesktopPetOverlayMeasuredLayout): string {
    return JSON.stringify(layout);
}

function toElementMetricsPayload(
    layout: DesktopPetOverlayMeasuredLayout,
    trayVisible: boolean,
): DesktopPetOverlayElementMetricsPayload {
    return {
        isTrayVisible: trayVisible,
        mascot: layout.mascot,
        tray: trayVisible ? layout.tray : null,
        controls: layout.controls,
    };
}

function observeElement(
    observer: ResizeObserver,
    resolver: DesktopPetOverlayMeasurementElementResolver,
    elementId: DesktopPetOverlayMeasuredElementId,
): void {
    const element = resolver(elementId);
    if (element) {
        observer.observe(element);
    }
}

export function useDesktopPetOverlayMeasuredLayout(input: UseDesktopPetOverlayMeasuredLayoutInput): void {
    const latestInputRef = React.useRef(input);
    const lastLayoutKeyRef = React.useRef<string | null>(null);
    const frameRef = React.useRef<number | null>(null);

    React.useEffect(() => {
        latestInputRef.current = input;
    }, [input]);

    React.useEffect(() => {
        if (!input.enabled) return undefined;

        const requestFrame = globalThis.requestAnimationFrame ?? ((callback: FrameRequestCallback): number => {
            return globalThis.setTimeout(() => callback(Date.now()), 0);
        });
        const cancelFrame = globalThis.cancelAnimationFrame ?? globalThis.clearTimeout;
        const scheduleMeasure = () => {
            if (frameRef.current !== null) return;
            frameRef.current = requestFrame(() => {
                frameRef.current = null;
                const latestInput = latestInputRef.current;
                const layout = measureLayout(latestInput);
                const layoutKey = serializeMeasuredLayout(layout);
                if (layoutKey === lastLayoutKeyRef.current) return;
                lastLayoutKeyRef.current = layoutKey;
                latestInput.onMeasuredLayoutChange?.(layout);
                latestInput.onElementMetricsChange?.(toElementMetricsPayload(layout, latestInput.trayVisible));
            });
        };

        const resolveElement = input.elementResolver ?? defaultElementResolver;
        const observer = typeof globalThis.ResizeObserver === 'function'
            ? new ResizeObserver(scheduleMeasure)
            : null;
        if (observer) {
            observeElement(observer, resolveElement, 'root');
            observeElement(observer, resolveElement, 'mascot');
            observeElement(observer, resolveElement, 'controls');
            if (input.trayVisible) {
                observeElement(observer, resolveElement, 'tray');
            }
        }
        scheduleMeasure();

        return () => {
            observer?.disconnect();
            if (frameRef.current !== null) {
                cancelFrame(frameRef.current);
                frameRef.current = null;
            }
        };
    }, [
        input.enabled,
        input.trayVisible,
        input.hasTrayItems,
        input.geometry,
        input.windowSize,
        input.elementResolver,
    ]);
}
