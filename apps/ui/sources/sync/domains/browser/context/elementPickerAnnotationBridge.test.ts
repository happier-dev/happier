import { describe, expect, it, vi } from 'vitest';
import type { BrowserDiagnosticsElementPickerResultV1 } from '@happier-dev/protocol/browser/diagnostics/v1';

import * as bridge from './elementPickerAnnotationBridge';

const baseResult = {
    v: 1,
    pickerRequestId: 'picker_1',
    viewId: 'view_1',
    navigationGeneration: 2,
    tier: 'injectedPage',
    audited: true,
} as const;

describe('element-picker → annotation bridge', () => {
    it('drains the latest hover that arrived while a click query was in flight', async () => {
        const pending: ((value: BrowserDiagnosticsElementPickerResultV1 | null) => void)[] = [];
        const query = vi.fn(() => new Promise<BrowserDiagnosticsElementPickerResultV1 | null>(resolve => pending.push(resolve)));
        const hover = vi.fn();
        const picker = bridge.createBrowserAnnotationElementPicker({ query, scale: 1, onHover: hover });
        picker.setActive(true);
        const pick = picker.pick({ x: 10, y: 20 });
        picker.hover({ x: 30, y: 40 });
        expect(query).toHaveBeenCalledTimes(1);
        pending.shift()!(null);
        await pick;
        expect(query.mock.calls).toEqual([[{ x: 10, y: 20 }], [{ x: 30, y: 40 }]]);
        pending.shift()!({ ...baseResult, status: 'selected', selectorPath: 'button', rect: { x: 30, y: 40, width: 10, height: 10 } });
        await Promise.resolve();
        await Promise.resolve();
        expect(hover).toHaveBeenLastCalledWith(expect.objectContaining({ selectorPath: 'button' }));
        picker.dispose();
    });
    it('coalesces 200 moving hover points to one in flight and the latest point, with no idle queries', async () => {
        expect(bridge.createBrowserAnnotationElementPicker).toBeTypeOf('function');
        const pending: ((value: BrowserDiagnosticsElementPickerResultV1 | null) => void)[] = [];
        const query = vi.fn(() => new Promise<BrowserDiagnosticsElementPickerResultV1 | null>(resolve => pending.push(resolve)));
        const hover = vi.fn();
        const picker = bridge.createBrowserAnnotationElementPicker({ query, scale: 2, onHover: hover });
        picker.setActive(true);
        picker.hover({ x: 0, y: 20 });
        for (let x = 1; x <= 200; x++) picker.hover({ x, y: 20 });
        expect(query.mock.calls).toEqual([[{ x: 0, y: 10 }]]);
        pending.shift()!(null);
        await Promise.resolve();
        await Promise.resolve();
        expect(query.mock.calls).toEqual([[{ x: 0, y: 10 }], [{ x: 100, y: 10 }]]);
        pending.shift()!({ ...baseResult, status: 'selected', selectorPath: 'button', rect: { x: 90, y: 10, width: 10, height: 12 } });
        await Promise.resolve();
        await Promise.resolve();
        expect(hover).toHaveBeenLastCalledWith(expect.objectContaining({ rect: { x: 180, y: 20, width: 20, height: 24 } }));
        for (let i = 0; i < 100; i++) picker.hover({ x: 200, y: 20 });
        await Promise.resolve();
        expect(query).toHaveBeenCalledTimes(2);
        picker.setActive(false);
        picker.hover({ x: 300, y: 20 });
        expect(query).toHaveBeenCalledTimes(2);
        picker.dispose();
    });

    it('picks in CSS viewport coordinates at DPR 2 and preserves selector/source facts in image space', async () => {
        expect(bridge.createBrowserAnnotationElementPicker).toBeTypeOf('function');
        const query = vi.fn(async () => ({ ...baseResult, status: 'selected' as const,
            selectorPath: 'main > button', accessibleName: 'Checkout', componentName: 'CheckoutButton',
            sourceLocation: { file: 'src/Checkout.tsx', line: 12 },
            // getBoundingClientRect stays viewport-relative even when the page is scrolled.
            rect: { x: 20, y: 30, width: 100, height: 40 } }));
        const picker = bridge.createBrowserAnnotationElementPicker({ query, scale: 2, onHover: () => {} });
        picker.setActive(true);
        expect(await picker.pick({ x: 60, y: 80 })).toEqual({ rect: { x: 40, y: 60, width: 200, height: 80 },
            label: 'CheckoutButton', role: 'button', selectorPath: 'main > button', accessibleName: 'Checkout', componentName: 'CheckoutButton',
            sourceLocation: { file: 'src/Checkout.tsx', line: 12 } });
        expect(query).toHaveBeenCalledWith({ x: 30, y: 40 });
        picker.dispose();
    });

    it('retires hover results when another tool is selected and recovers after a failed query without polling', async () => {
        expect(bridge.createBrowserAnnotationElementPicker).toBeTypeOf('function');
        let complete!: (value: BrowserDiagnosticsElementPickerResultV1 | null) => void;
        const query = vi.fn().mockRejectedValueOnce(new Error('transport unavailable'))
            .mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
        const hover = vi.fn();
        const picker = bridge.createBrowserAnnotationElementPicker({ query, scale: 1, onHover: hover });
        picker.setActive(true);
        picker.hover({ x: 1, y: 1 });
        await Promise.resolve();
        await Promise.resolve();
        picker.hover({ x: 2, y: 2 });
        picker.setActive(false);
        complete({ ...baseResult, status: 'selected', selectorPath: 'button', rect: { x: 1, y: 1, width: 2, height: 2 } });
        await Promise.resolve();
        expect(hover).not.toHaveBeenCalledWith(expect.objectContaining({ selectorPath: 'button' }));
        expect(query).toHaveBeenCalledTimes(2);
        picker.dispose();
    });
});
