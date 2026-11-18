import { vi } from 'vitest';
import * as nativeTransfer from '@/utils/platform/tauri/transferFetch';
import { registerStandardCleanupTarget } from '../cleanup/standardCleanup';

let installed = false;

/** Substitute the native HTTP SDK adapter; host placement and network requests stay real. */
export function installNativeRuntimeFetchBoundary(): () => void {
    const transfer = vi.spyOn(nativeTransfer, 'resolveTauriRuntimeFetch').mockResolvedValue(
        (input, init) => globalThis.fetch(input, init),
    );
    return () => transfer.mockRestore();
}

/** Overlapping journey clients share this physical adapter until the test ends. */
export function installNativeRuntimeFetchBoundaryForTest(): void {
    if (installed) return;
    const restore = installNativeRuntimeFetchBoundary();
    installed = true;
    registerStandardCleanupTarget({ unmount() { restore(); installed = false; } });
}
