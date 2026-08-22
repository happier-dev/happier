import type { WebContents } from 'electron';

import { BRIDGE_CHANNELS, type BridgeCallbackMessage } from '../../shared/bridge';

/**
 * Host side of `@tauri-apps/api`'s event module.
 *
 * `listen(name, handler)` reaches the host as `plugin:event|listen` carrying the callback id the
 * preload minted for `handler`; the host answers with an event id and later pushes payloads back
 * addressed to that callback. The event id returned here *is* the callback id, which is what lets
 * the renderer's `unregisterListener(name, eventId)` release the right callback slot.
 */

type Listener = Readonly<{
    eventName: string;
    callbackId: number;
    sender: WebContents;
}>;

export class DesktopEventBus {
    private readonly listeners = new Map<number, Listener>();

    listen(eventName: string, callbackId: number, sender: WebContents): number {
        this.listeners.set(callbackId, { eventName, callbackId, sender });
        return callbackId;
    }

    unlisten(eventId: number): void {
        this.listeners.delete(eventId);
    }

    /** Drops every listener owned by a renderer that went away. */
    releaseSender(sender: WebContents): void {
        for (const [eventId, listener] of this.listeners) {
            if (listener.sender === sender) {
                this.listeners.delete(eventId);
            }
        }
    }

    emit(eventName: string, payload: unknown): void {
        for (const listener of this.listeners.values()) {
            if (listener.eventName !== eventName) continue;
            if (listener.sender.isDestroyed()) {
                this.listeners.delete(listener.callbackId);
                continue;
            }
            const message: BridgeCallbackMessage = {
                callbackId: listener.callbackId,
                // `@tauri-apps/api` hands the whole event object to the handler, not just the payload.
                payload: { event: eventName, id: listener.callbackId, payload },
                once: false,
            };
            listener.sender.send(BRIDGE_CHANNELS.callback, message);
        }
    }

    listenerCount(eventName?: string): number {
        if (eventName === undefined) return this.listeners.size;
        let count = 0;
        for (const listener of this.listeners.values()) {
            if (listener.eventName === eventName) count += 1;
        }
        return count;
    }
}
