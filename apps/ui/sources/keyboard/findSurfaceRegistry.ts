import type { FindController } from '@happier-dev/plugin-ui/presentation';
import type { KeyboardShortcutDisposition } from './runtime';
import type { NormalizedKeyboardEvent } from './types';

export type FindSurfaceRegistration = Readonly<{
    surfaceId: string;
    containsFocus(): boolean;
    open(): void;
    isOpen(): boolean;
    isInputFocused(): boolean;
    /** The native widget owns physical keys and counts; host Actions still address this surface. */
    engineOwnsFind?: boolean;
    controller: FindController;
}>;

/** One mounted provider owns resolution; models retain all query and result state. */
export function createFindSurfaceRegistry() {
    const entries = new Map<string, FindSurfaceRegistration>();
    const resolve = (surfaceId?: string): FindSurfaceRegistration | undefined => surfaceId === undefined
        ? [...entries.values()].reverse().find((entry) => entry.containsFocus())
        : entries.get(surfaceId);
    return {
        resolve,
        register(surface: FindSurfaceRegistration) {
            entries.set(surface.surfaceId, surface);
            return () => { if (entries.get(surface.surfaceId) === surface) entries.delete(surface.surfaceId); };
        },
        open(surfaceId?: string): boolean {
            const surface = resolve(surfaceId);
            if (!surface) return false;
            surface.open();
            return true;
        },
        command(command: 'find.open' | 'find.next' | 'find.previous', event?: NormalizedKeyboardEvent): KeyboardShortcutDisposition {
            const surface = resolve();
            if (!surface || surface.engineOwnsFind || event?.isComposing || event?.repeat) return 'pass';
            if (command === 'find.open') {
                if (surface.isOpen() && surface.isInputFocused()) return 'pass';
                surface.open();
                return 'handled';
            }
            if (!surface.isOpen()) return 'pass';
            if (event && (event.key === 'Enter' || event.code === 'Enter') && !event.ctrlKey && !event.metaKey && !event.altKey
                && !surface.isInputFocused()) return 'pass';
            surface.controller.step(command === 'find.next' ? 1 : -1);
            return 'handled';
        },
        closeFromKeyboard(event: NormalizedKeyboardEvent): KeyboardShortcutDisposition {
            if (event.key !== 'Escape' || event.isComposing || event.repeat || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return 'pass';
            const surface = resolve();
            if (!surface?.isOpen() || surface.engineOwnsFind) return 'pass';
            surface.controller.close();
            return 'handled';
        },
    };
}

export type FindSurfaceRegistry = ReturnType<typeof createFindSurfaceRegistry>;
