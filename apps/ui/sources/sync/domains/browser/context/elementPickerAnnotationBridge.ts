import type { BrowserDiagnosticsElementPickerResultV1 } from '@happier-dev/protocol/browser/diagnostics/v1';
import type { ImagePointV1, ImageRectV1 } from '@happier-dev/protocol';

export type BrowserAnnotationPickedElement = Readonly<{
    rect: ImageRectV1;
    label: string;
    /** The element's tag, read from the selector, for the hover tooltip's "name · role · size". */
    role?: string;
    selectorPath: string;
    accessibleName?: string;
    componentName?: string;
    sourceLocation?: BrowserDiagnosticsElementPickerResultV1['sourceLocation'];
}>;

export type BrowserAnnotationElementPicker = Readonly<{
    setActive: (active: boolean) => void;
    hover: (point: ImagePointV1) => void;
    pick: (point: ImagePointV1) => Promise<BrowserAnnotationPickedElement | null>;
    dispose: () => void;
}>;

/** The picker returns viewport CSS coordinates, including on scrolled pages; marks use image pixels. */
function pickedElement(result: BrowserDiagnosticsElementPickerResultV1 | null, scale: number): BrowserAnnotationPickedElement | null {
    if (result?.status !== 'selected' || !result.selectorPath || !result.rect) return null;
    const { rect, selectorPath, accessibleName, componentName, sourceLocation } = result;
    const role = /(?:^|[\s>])([a-zA-Z][\w-]*)[^\s>]*$/.exec(selectorPath)?.[1]?.toLowerCase();
    return { rect: { x: rect.x * scale, y: rect.y * scale, width: rect.width * scale, height: rect.height * scale },
        label: componentName || accessibleName || selectorPath, selectorPath, ...(role ? { role } : {}),
        ...(accessibleName ? { accessibleName } : {}), ...(componentName ? { componentName } : {}),
        ...(sourceLocation ? { sourceLocation } : {}) };
}

/** One transport query in flight, one pending hover point. No clock or work while the pointer is still. */
export function createBrowserAnnotationElementPicker(input: Readonly<{
    query: (point: ImagePointV1) => Promise<BrowserDiagnosticsElementPickerResultV1 | null>;
    scale: number;
    onHover: (element: BrowserAnnotationPickedElement | null) => void;
}>): BrowserAnnotationElementPicker {
    let active = false;
    let disposed = false;
    let lastPoint: ImagePointV1 | null = null;
    let pendingPoint: ImagePointV1 | null = null;
    let inFlight: Promise<BrowserAnnotationPickedElement | null> | null = null;

    function query(point: ImagePointV1) {
        const result = input.query({ x: point.x / input.scale, y: point.y / input.scale })
            .then(value => pickedElement(value, input.scale), () => null);
        inFlight = result;
        return result;
    }
    function drainPendingHover(): boolean {
        if (!active || disposed || !pendingPoint) return false;
        const latest = pendingPoint;
        pendingPoint = null;
        void drainHover(latest);
        return true;
    }
    async function drainHover(point: ImagePointV1): Promise<void> {
        const result = await query(point);
        inFlight = null;
        if (!active || disposed) return;
        if (!drainPendingHover()) input.onHover(result);
    }
    return {
        setActive(value: boolean) {
            active = value;
            if (!value) { lastPoint = null; pendingPoint = null; input.onHover(null); }
        },
        hover(point: ImagePointV1) {
            if (!active || disposed || (lastPoint?.x === point.x && lastPoint.y === point.y)) return;
            lastPoint = point;
            if (inFlight) pendingPoint = point;
            else void drainHover(point);
        },
        async pick(point: ImagePointV1): Promise<BrowserAnnotationPickedElement | null> {
            pendingPoint = null;
            while (inFlight) await inFlight;
            if (!active || disposed) return null;
            const result = await query(point);
            inFlight = null;
            drainPendingHover();
            return active && !disposed ? result : null;
        },
        dispose() { disposed = true; active = false; pendingPoint = null; },
    };
}
