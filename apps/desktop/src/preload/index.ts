/**
 * Seam shim.
 *
 * Happier's renderer reaches the desktop host through `apps/ui/sources/utils/platform/tauri.ts`,
 * a 55-line wrapper that reads `window.__TAURI_INTERNALS__`. Exposing an object with the same
 * shape here makes that wrapper — and `@tauri-apps/api`, which the wrapper lazily imports for
 * events — work against Electron with no change to the React app.
 *
 * Runs sandboxed with context isolation, so `require` can only load `electron` and a handful of
 * Node builtins. This file therefore has no runtime imports of its own; the channel names come in
 * as erased `import type` aliases so the compiler still catches drift from the main process.
 */
import { contextBridge, ipcRenderer } from 'electron';

import type {
    BridgeCallbackMessage,
    CallbackChannel,
    InvokeChannel,
} from '../shared/bridge';
import type { DesktopRuntimeConfig } from '../main/renderer/runtimeConfig';

const INVOKE_CHANNEL: InvokeChannel = 'happier-desktop:invoke';
const CALLBACK_CHANNEL: CallbackChannel = 'happier-desktop:callback';
const RUNTIME_CONFIG_ARGUMENT_PREFIX = '--happier-runtime-config=';

type RegisteredCallback = Readonly<{
    callback: (payload: unknown) => void;
    once: boolean;
}>;

const callbacks = new Map<number, RegisteredCallback>();
let nextCallbackId = 1;

function normalizeInvokeArgs(args: unknown): Record<string, unknown> {
    return args && typeof args === 'object' && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};
}

function invoke(command: string, args?: unknown): Promise<unknown> {
    return ipcRenderer.invoke(INVOKE_CHANNEL, {
        command: String(command),
        args: normalizeInvokeArgs(args),
    });
}

/**
 * Stores a renderer callback and returns the identifier the host uses to address it, mirroring
 * `window.__TAURI_INTERNALS__.transformCallback`.
 */
function transformCallback(callback?: (payload: unknown) => void, once = false): number {
    const callbackId = nextCallbackId;
    nextCallbackId += 1;
    if (typeof callback === 'function') {
        callbacks.set(callbackId, { callback, once });
    }
    return callbackId;
}

function unregisterCallback(callbackId: number): void {
    callbacks.delete(callbackId);
}

/**
 * Mirrors `convertFileSrc`. Tauri rewrites a filesystem path onto its asset protocol; this target
 * serves the renderer over loopback HTTP, so a `file://` URL is the equivalent addressable form.
 */
function convertFileSrc(filePath: string): string {
    const normalized = String(filePath).replace(/\\/g, '/');
    const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
    return `file://${withLeadingSlash.split('/').map(encodeURIComponent).join('/')}`;
}

ipcRenderer.on(CALLBACK_CHANNEL, (_event, message: BridgeCallbackMessage) => {
    const registered = callbacks.get(message.callbackId);
    if (!registered) return;
    if (registered.once || message.once) {
        callbacks.delete(message.callbackId);
    }
    registered.callback(message.payload);
});

contextBridge.exposeInMainWorld('__TAURI_INTERNALS__', {
    invoke,
    transformCallback,
    unregisterCallback,
    convertFileSrc,
});

/**
 * `@tauri-apps/api`'s `unlisten` calls `unregisterListener` before telling the host to drop the
 * listener. The host owns listener state here, so the renderer-side half only has to release the
 * callback slot; the matching `plugin:event|unlisten` invoke does the rest.
 */
contextBridge.exposeInMainWorld('__TAURI_EVENT_PLUGIN_INTERNALS__', {
    unregisterListener: (_event: string, eventId: number) => {
        unregisterCallback(eventId);
    },
});

/**
 * Publishes the host-supplied relay configuration the app reads at boot. Nothing is exposed when
 * the host did not supply one, so the app keeps its own default resolution.
 */
function readRuntimeConfigArgument(): DesktopRuntimeConfig | null {
    const argument = process.argv.find((value) => value.startsWith(RUNTIME_CONFIG_ARGUMENT_PREFIX));
    if (argument === undefined) return null;
    try {
        const parsed: unknown = JSON.parse(argument.slice(RUNTIME_CONFIG_ARGUMENT_PREFIX.length));
        return parsed && typeof parsed === 'object' ? (parsed as DesktopRuntimeConfig) : null;
    } catch {
        return null;
    }
}

const runtimeConfig = readRuntimeConfigArgument();
if (runtimeConfig !== null) {
    contextBridge.exposeInMainWorld('__HAPPIER_WEB_RUNTIME_CONFIG__', runtimeConfig);
}
