/**
 * Canonical contract between the Electron main process and the preload bridge.
 *
 * The preload script runs sandboxed, where `require` cannot load arbitrary local files, so it
 * cannot import this module at runtime. It imports the channel *types* instead (`import type`,
 * fully erased at compile time) and declares the literals with these types, which makes the
 * compiler reject any drift between the two sides.
 */

export type InvokeChannel = 'happier-desktop:invoke';
export type CallbackChannel = 'happier-desktop:callback';

export const BRIDGE_CHANNELS = {
    /** Renderer -> main, one request per `__TAURI_INTERNALS__.invoke` call. */
    invoke: 'happier-desktop:invoke' satisfies InvokeChannel,
    /** Main -> renderer, delivers a payload to a callback registered by `transformCallback`. */
    callback: 'happier-desktop:callback' satisfies CallbackChannel,
} as const;

/** Payload sent over {@link BRIDGE_CHANNELS.invoke}. */
export type BridgeInvokeRequest = Readonly<{
    command: string;
    args: Readonly<Record<string, unknown>>;
}>;

/** Payload sent over {@link BRIDGE_CHANNELS.callback}. */
export type BridgeCallbackMessage = Readonly<{
    callbackId: number;
    payload: unknown;
    /** `transformCallback(fn, true)` callbacks are dropped by the preload after one delivery. */
    once: boolean;
}>;

/**
 * Error message prefix used for every command this target has not implemented yet.
 *
 * The Tauri seam surfaces command failures as promise rejections, so an unimplemented command
 * rejects like a failing one. This prefix is what makes the two distinguishable: a rejection
 * carrying it means "this Electron target has no implementation", never "the operation failed".
 * Nothing in this target may return fabricated success data in its place.
 */
export const NOT_IMPLEMENTED_ERROR_PREFIX = 'HAPPIER_DESKTOP_NOT_IMPLEMENTED';

export function formatNotImplementedError(command: string): string {
    return `${NOT_IMPLEMENTED_ERROR_PREFIX}: ${command}`;
}

export function isNotImplementedError(value: unknown): boolean {
    const message = typeof value === 'string' ? value : (value as Error | null)?.message;
    return typeof message === 'string' && message.startsWith(`${NOT_IMPLEMENTED_ERROR_PREFIX}:`);
}
