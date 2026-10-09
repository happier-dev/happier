import { Platform } from 'react-native';
import {
    useCompanionPointerDragSession as useNeutralPointerDragSession,
    type CompanionPointerListenerHost,
    type HappierFloatingFramePointerBinding,
    type UseCompanionPointerDragSessionParams,
} from '@happier-dev/plugin-ui/presentation';
import { resolvePointerClientPoint } from '@/components/ui/panels/resolvePointerClientPoint';
import { resolvePointerScreenPoint } from '@/components/ui/panels/resolvePointerScreenPoint';

export type {
    CompanionPointerDragCoordinateSpace, CompanionPointerId, CompanionPointerDragMove,
    CompanionPointerDragStart, CompanionPointerDragEnd, CompanionPointerDragRelease, CompanionPointerDragSelectors,
} from '@happier-dev/plugin-ui/presentation';

type PointerTarget = Readonly<{
    addEventListener?: (name: string, listener: EventListener) => void;
    removeEventListener?: (name: string, listener: EventListener) => void;
    setPointerCapture?: (pointerId: number) => void;
    releasePointerCapture?: (pointerId: number) => void;
}>;

function pointerTarget(value: unknown): PointerTarget | null {
    return value != null && typeof value === 'object' ? value as PointerTarget : null;
}

const pointerHost: CompanionPointerListenerHost = {
    capturePointer(target, pointerId) {
        if (pointerId == null) return;
        try { pointerTarget(target)?.setPointerCapture?.(pointerId); }
        catch { /* The browser may already have cancelled this pointer. */ }
    },
    releasePointer(target, pointerId) {
        if (pointerId == null) return;
        try { pointerTarget(target)?.releasePointerCapture?.(pointerId); }
        catch { /* Capture cleanup is best effort after browser cancellation. */ }
    },
    listenForStart(target, start) {
        const node = pointerTarget(target);
        node?.addEventListener?.('pointerdown', start as EventListener);
        return () => node?.removeEventListener?.('pointerdown', start as EventListener);
    },
    listenForActive(target, handlers) {
        const node = pointerTarget(target);
        const win = pointerTarget((globalThis as { window?: unknown }).window);
        const listeners = [
            ['pointermove', handlers.move], ['mousemove', handlers.move], ['touchmove', handlers.move],
            ['pointerup', handlers.end], ['mouseup', handlers.end], ['touchend', handlers.end],
            ['pointercancel', handlers.cancel], ['touchcancel', handlers.cancel],
        ] as const;
        for (const [name, handler] of listeners) win?.addEventListener?.(name, handler as EventListener);
        node?.addEventListener?.('lostpointercapture', handlers.cancel as EventListener);
        return () => {
            for (const [name, handler] of listeners) win?.removeEventListener?.(name, handler as EventListener);
            node?.removeEventListener?.('lostpointercapture', handlers.cancel as EventListener);
        };
    },
};

/**
 * The web pointer boundary as one binding: Happier's companions and the shared `FloatingFrame`
 * (Session viewer, public authors through the presentation host) read pointers the same way.
 */
export const COMPANION_WEB_POINTER_BINDING: HappierFloatingFramePointerBinding = Object.freeze({
    pointerHost,
    readClientPoint: resolvePointerClientPoint,
    readScreenPoint: resolvePointerScreenPoint,
});

/** Host platform/coordinate adapter; pointer custody and release have one neutral owner. */
export function useCompanionPointerDragSession<TDragState = never>(
    input: Omit<UseCompanionPointerDragSessionParams<TDragState>, 'readClientPoint' | 'readScreenPoint' | 'pointerHost'>,
) {
    return useNeutralPointerDragSession<TDragState>({
        ...input,
        enabled: Platform.OS === 'web' && input.enabled !== false,
        ...COMPANION_WEB_POINTER_BINDING,
    });
}
