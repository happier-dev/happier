import type { FindSurfaceRegistration } from '@happier-dev/plugin-ui/presentation';
import type { KeyboardShortcutDisposition } from './runtime';
import type { NormalizedKeyboardEvent } from './types';

export type { FindSurfaceRegistration } from '@happier-dev/plugin-ui/presentation';

/** One mounted provider owns resolution; models retain all query and result state. */
export function createFindSurfaceRegistry() {
    const entries = new Map<string, FindSurfaceRegistration>();
    let lastInteractedId: string | undefined;
    /** One intent waiting for its surface: an action that just brought that surface forward. */
    let pendingOpenId: string | undefined;
    /** The mount that intent opened: if it is replaced while still open, its replacement opens too. */
    let intentOpened: FindSurfaceRegistration | undefined;
    const openForIntent = (surface: FindSurfaceRegistration) => {
        pendingOpenId = undefined;
        intentOpened = surface;
        surface.open();
    };
    const resolve = (surfaceId?: string): FindSurfaceRegistration | undefined => {
        const surface = surfaceId === undefined
            ? [...entries.values()].reverse().find((entry) => entry.isAvailable?.() !== false && entry.containsFocus())
                ?? (lastInteractedId === undefined ? undefined : entries.get(lastInteractedId))
            : entries.get(surfaceId);
        return surface?.isAvailable?.() === false ? undefined : surface;
    };
    return {
        resolve,
        recordInteraction(target: unknown) {
            lastInteractedId = [...entries.values()].reverse()
                .find(entry => entry.isAvailable?.() !== false && entry.containsTarget?.(target))?.surfaceId;
        },
        register(surface: FindSurfaceRegistration) {
            const replaced = entries.get(surface.surfaceId);
            entries.set(surface.surfaceId, surface);
            if (pendingOpenId === surface.surfaceId && surface.isAvailable?.() !== false) {
                openForIntent(surface);
            } else if (replaced && replaced === intentOpened && replaced.isOpen()) {
                // A remount (the phone tab switch) replaced the open mount before it left.
                openForIntent(surface);
            }
            return () => {
                if (surface === intentOpened) {
                    intentOpened = undefined;
                    // Left while open with nothing in its place yet: the next mount takes the intent.
                    if (entries.get(surface.surfaceId) === surface && surface.isOpen()) pendingOpenId = surface.surfaceId;
                }
                if (entries.get(surface.surfaceId) !== surface) return;
                entries.delete(surface.surfaceId);
                if (lastInteractedId === surface.surfaceId) lastInteractedId = undefined;
            };
        },
        /**
         * `whenRegistered`: the caller has just brought the surface forward (a phone cockpit tab switch),
         * so a surface that registers next opens then. Any later open replaces the intent.
         */
        open(surfaceId?: string, options?: Readonly<{ whenRegistered?: boolean }>): boolean {
            const surface = resolve(surfaceId);
            pendingOpenId = !surface && options?.whenRegistered === true ? surfaceId : undefined;
            if (!surface) return false;
            if (options?.whenRegistered === true) openForIntent(surface);
            else surface.open();
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
