import { readBundledAssetBytes } from '@/utils/assets/readBundledAssetBytes';
import { requireMermaidWebViewBundleAsset } from './mermaidWebViewBundle.generated';

let loaded: string | undefined;
let pending: Promise<string> | null = null;

/** The injected runtime script once a diagram has read it, so later diagrams mount at once. */
export function readLoadedMermaidWebViewRuntime(): string | undefined {
    return loaded;
}

/**
 * The native Mermaid WebView's injected runtime script, read from its packaged asset on the first
 * diagram and shared by every later one. A failed read settles as a rejection and the next diagram
 * reads again.
 */
export function loadMermaidWebViewRuntime(): Promise<string> {
    if (loaded !== undefined) return Promise.resolve(loaded);
    pending ??= Promise.resolve()
        .then(() => readBundledAssetBytes(requireMermaidWebViewBundleAsset()))
        .then((bytes) => {
            // A WebView injection must end in a value; build the multi-MB script once.
            loaded = `${new TextDecoder().decode(bytes)}\ntrue;`;
            return loaded;
        })
        .finally(() => { pending = null; });
    return pending;
}
