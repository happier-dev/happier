import * as React from 'react';

import {
    DESKTOP_PET_OVERLAY_CONTEXT_BOTTOM_GAP_PX,
    DESKTOP_PET_OVERLAY_CONTEXT_MASCOT_TOP_OVERLAP_PX,
    DESKTOP_PET_OVERLAY_EXPANDED_MASCOT_BOTTOM_INSET_PX,
    DESKTOP_PET_OVERLAY_EXPANDED_MASCOT_RIGHT_INSET_PX,
    DESKTOP_PET_OVERLAY_TRAY_GAP_PX,
    DESKTOP_PET_OVERLAY_TRAY_MAX_HEIGHT,
    DESKTOP_PET_OVERLAY_TRAY_WIDTH,
    type DesktopPetOverlayGeometry,
} from '@/components/pets/desktop/desktopPetOverlayGeometry';

const DESKTOP_PET_OVERLAY_CONTEXT_SIZE_PX = 30;

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
            x: window.width - input.geometry.spriteWidth - DESKTOP_PET_OVERLAY_EXPANDED_MASCOT_RIGHT_INSET_PX,
            y: window.height - input.geometry.spriteHeight - DESKTOP_PET_OVERLAY_EXPANDED_MASCOT_BOTTOM_INSET_PX,
            width: input.geometry.spriteWidth,
            height: input.geometry.spriteHeight,
        }
        : {
            x: window.width - input.geometry.spriteWidth,
            y: window.height - input.geometry.spriteHeight,
            width: input.geometry.spriteWidth,
            height: input.geometry.spriteHeight,
        };
    const tray = input.trayVisible
        ? {
            x: window.width - DESKTOP_PET_OVERLAY_TRAY_WIDTH - DESKTOP_PET_OVERLAY_EXPANDED_MASCOT_RIGHT_INSET_PX,
            y: window.height
                - input.geometry.spriteHeight
                - DESKTOP_PET_OVERLAY_EXPANDED_MASCOT_BOTTOM_INSET_PX
                - DESKTOP_PET_OVERLAY_TRAY_GAP_PX
                - DESKTOP_PET_OVERLAY_TRAY_MAX_HEIGHT,
            width: DESKTOP_PET_OVERLAY_TRAY_WIDTH,
            height: DESKTOP_PET_OVERLAY_TRAY_MAX_HEIGHT,
        }
        : null;
    const controls = input.hasTrayItems
        ? {
            x: window.width - DESKTOP_PET_OVERLAY_EXPANDED_MASCOT_RIGHT_INSET_PX - DESKTOP_PET_OVERLAY_CONTEXT_SIZE_PX,
            y: window.height
                - input.geometry.spriteHeight
                - DESKTOP_PET_OVERLAY_EXPANDED_MASCOT_BOTTOM_INSET_PX
                - DESKTOP_PET_OVERLAY_CONTEXT_BOTTOM_GAP_PX
                - DESKTOP_PET_OVERLAY_CONTEXT_SIZE_PX
                + DESKTOP_PET_OVERLAY_CONTEXT_MASCOT_TOP_OVERLAP_PX,
            width: DESKTOP_PET_OVERLAY_CONTEXT_SIZE_PX,
            height: DESKTOP_PET_OVERLAY_CONTEXT_SIZE_PX,
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

    if (!rootElement || !mascotElement || !controlsElement || (input.trayVisible && !trayElement)) {
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

        const requestFrame: (callback: FrameRequestCallback) => number = globalThis.requestAnimationFrame ?? ((callback) => (
            globalThis.setTimeout(() => callback(Date.now()), 0) as unknown as number
        ));
        const cancelFrame: (handle: number) => void = globalThis.cancelAnimationFrame ?? ((handle) => {
            globalThis.clearTimeout(handle as unknown as ReturnType<typeof globalThis.setTimeout>);
        });
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
