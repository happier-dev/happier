import type { BrowserDiagnosticsElementPickerResultV1 } from '@happier-dev/protocol';

import type { BrowserAnnotationAdapterRequest } from './runtimeAnnotationExecutor';

/**
 * Bridges a diagnostics element-picker result into a `captureElement` annotation request. The picker
 * (injected-devtools / automation) already returns a selected element with a stable selector path +
 * optional accessible name + bounding rect; this turns that selection into the canonical annotation
 * capture action so the two half-features become one (FINALIZATION-PLAN finding #47 / Phase 4.2(d)).
 * Returns null for non-`selected` results (cancelled/blocked/failed) so the caller does nothing.
 */
export function buildCaptureElementRequestFromPickerResult(
    result: BrowserDiagnosticsElementPickerResultV1,
): Extract<BrowserAnnotationAdapterRequest, { kind: 'captureElement' }> | null {
    if (result.status !== 'selected') return null;
    const selectorPath = result.selectorPath?.trim();
    if (!selectorPath) return null;
    const accessibleName = result.accessibleName?.trim();
    return {
        kind: 'captureElement',
        target: {
            kind: 'element',
            selectorPath: selectorPath.slice(0, 1024),
            ...(accessibleName ? { accessibleName: accessibleName.slice(0, 512) } : {}),
            ...(result.rect ? { rect: result.rect } : {}),
        },
    };
}
