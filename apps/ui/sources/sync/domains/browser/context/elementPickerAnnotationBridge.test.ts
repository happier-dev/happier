import { describe, expect, it } from 'vitest';
import type { BrowserDiagnosticsElementPickerResultV1 } from '@happier-dev/protocol';

import { buildCaptureElementRequestFromPickerResult } from './elementPickerAnnotationBridge';

const baseResult = {
    v: 1,
    pickerRequestId: 'picker_1',
    viewId: 'view_1',
    navigationGeneration: 2,
    tier: 'injectedPage',
    audited: true,
} as const;

describe('element-picker → annotation bridge', () => {
    it('maps a selected element into a captureElement annotation request', () => {
        const result = {
            ...baseResult,
            status: 'selected',
            selectorPath: '  main > button.cta  ',
            accessibleName: '  Buy now  ',
            rect: { x: 10, y: 20, width: 120, height: 48 },
        } satisfies BrowserDiagnosticsElementPickerResultV1;

        expect(buildCaptureElementRequestFromPickerResult(result)).toEqual({
            kind: 'captureElement',
            target: {
                kind: 'element',
                selectorPath: 'main > button.cta',
                accessibleName: 'Buy now',
                rect: { x: 10, y: 20, width: 120, height: 48 },
            },
        });
    });

    it('returns null for non-selected results', () => {
        for (const status of ['cancelled', 'blocked', 'failed'] as const) {
            const result = { ...baseResult, status } satisfies BrowserDiagnosticsElementPickerResultV1;
            expect(buildCaptureElementRequestFromPickerResult(result)).toBeNull();
        }
    });

    it('returns null when no selector path is present', () => {
        const result = { ...baseResult, status: 'selected' } satisfies BrowserDiagnosticsElementPickerResultV1;
        expect(buildCaptureElementRequestFromPickerResult(result)).toBeNull();
    });
});
