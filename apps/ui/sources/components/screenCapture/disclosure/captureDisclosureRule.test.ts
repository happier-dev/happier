import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageMarksDocumentV1Schema, applyImageMarksOperations } from '@happier-dev/protocol';
import { captureDisclosureIsAmber, createCaptureDisclosureState, reduceCaptureDisclosure, reduceCaptureDisclosureDocument } from './captureDisclosureRule';

describe('shared window-text and recording-video disclosure', () => {
    afterEach(() => vi.useRealTimers());

    it('retains settled inclusion identity for an unchanged request and publishes a real toggle', () => {
        const included = createCaptureDisclosureState(true);
        const excluded = createCaptureDisclosureState(false);
        expect(reduceCaptureDisclosure(included, { type: 'toggle', included: true })).toBe(included);
        expect(reduceCaptureDisclosure(excluded, { type: 'toggle', included: false })).toBe(excluded);
        expect(reduceCaptureDisclosure(included, { type: 'toggle', included: false })).toMatchObject({ included: false });
    });

    it('turns off at blur, restores on Undo, turns off on Redo, and stays off after hand deletion', () => {
        let state = createCaptureDisclosureState(true);
        state = reduceCaptureDisclosure(state, { type: 'document', blurCount: 1, cause: 'edit' });
        expect(state).toMatchObject({ included: false, showBlurCallout: true });
        state = reduceCaptureDisclosure(state, { type: 'document', blurCount: 0, cause: 'undo' });
        expect(state.included).toBe(true);
        state = reduceCaptureDisclosure(state, { type: 'document', blurCount: 1, cause: 'redo' });
        expect(state.included).toBe(false);
        state = reduceCaptureDisclosure(state, { type: 'document', blurCount: 0, cause: 'edit' });
        expect(state.included).toBe(false);
        state = reduceCaptureDisclosure(state, { type: 'document', blurCount: 1, cause: 'undo' });
        state = reduceCaptureDisclosure(state, { type: 'document', blurCount: 0, cause: 'undo' });
        expect(state.included).toBe(false);
    });

    it('keeps a deliberately disabled disclosure off when a blur is undone', () => {
        let state = createCaptureDisclosureState(false);
        state = reduceCaptureDisclosure(state, { type: 'document', blurCount: 1, cause: 'edit' });
        state = reduceCaptureDisclosure(state, { type: 'document', blurCount: 0, cause: 'undo' });
        expect(state.included).toBe(false);
    });

    it('restores only when Undo removes the final blur, without adding another history', () => {
        let state = createCaptureDisclosureState(true);
        state = reduceCaptureDisclosure(state, { type: 'document', blurCount: 1, cause: 'edit' });
        // A second blur and its Undo leave the first blur in the document.
        state = reduceCaptureDisclosure(state, { type: 'document', blurCount: 2, cause: 'edit' });
        state = reduceCaptureDisclosure(state, { type: 'document', blurCount: 1, cause: 'undo' });
        expect(state.included).toBe(false);
        state = reduceCaptureDisclosure(state, { type: 'document', blurCount: 0, cause: 'undo' });
        expect(state.included).toBe(true);
        state = reduceCaptureDisclosure(state, { type: 'document', blurCount: 1, cause: 'redo' });
        expect(state.included).toBe(false);
    });

    it('turns included text off for a further blur and restores it when only that blur is undone', () => {
        let state = createCaptureDisclosureState(false, 1);
        state = reduceCaptureDisclosure(state, { type: 'toggle', included: true });
        state = reduceCaptureDisclosure(state, { type: 'warning', include: true });
        expect(captureDisclosureIsAmber(state)).toBe(true);
        state = reduceCaptureDisclosure(state, { type: 'document', blurCount: 2, cause: 'edit' });
        expect(state.included).toBe(false);
        state = reduceCaptureDisclosure(state, { type: 'document', blurCount: 3, cause: 'edit' });
        state = reduceCaptureDisclosure(state, { type: 'document', blurCount: 2, cause: 'undo' });
        expect(state.included).toBe(false);
        state = reduceCaptureDisclosure(state, { type: 'document', blurCount: 1, cause: 'undo' });
        expect(state.included).toBe(true);
        expect(captureDisclosureIsAmber(state)).toBe(true);
        state = reduceCaptureDisclosure(state, { type: 'document', blurCount: 2, cause: 'redo' });
        expect(state.included).toBe(false);
    });

    it('consumes real marks documents through the canonical blur selector', () => {
        const empty = ImageMarksDocumentV1Schema.parse({ v: 1, image: { width: 100, height: 100, scale: 1 }, marks: [] });
        const first = applyImageMarksOperations(empty, [{ kind: 'mark.add',
            mark: { id: 'first', kind: 'blur', rect: { x: 0, y: 0, width: 10, height: 10 }, size: 's' } }]);
        const second = applyImageMarksOperations(first, [{ kind: 'mark.add',
            mark: { id: 'second', kind: 'blur', rect: { x: 50, y: 50, width: 10, height: 10 }, size: 's' } }]);
        let state = reduceCaptureDisclosureDocument(createCaptureDisclosureState(true), first, 'edit');
        state = reduceCaptureDisclosure(state, { type: 'toggle', included: true });
        state = reduceCaptureDisclosure(state, { type: 'warning', include: true });
        state = reduceCaptureDisclosureDocument(state, second, 'edit');
        expect(state).toMatchObject({ included: false, blurCount: 2 });
        state = reduceCaptureDisclosureDocument(state, first, 'undo');
        expect(state.included).toBe(true);
    });

    it('warns once per capture, keeps rejection off, and marks accepted inclusion amber', () => {
        let state = createCaptureDisclosureState(false, 1);
        state = reduceCaptureDisclosure(state, { type: 'toggle', included: true });
        expect(state).toMatchObject({ included: false, warning: 'pending' });
        state = reduceCaptureDisclosure(state, { type: 'warning', include: false });
        expect(state.included).toBe(false);
        expect(captureDisclosureIsAmber(state)).toBe(false);
        state = reduceCaptureDisclosure(state, { type: 'toggle', included: true });
        expect(state).toMatchObject({ included: false, warning: 'pending' });
        state = reduceCaptureDisclosure(state, { type: 'warning', include: true });
        expect(state).toMatchObject({ included: true, warning: 'acknowledged' });
        expect(captureDisclosureIsAmber(state)).toBe(true);
        state = reduceCaptureDisclosure(state, { type: 'toggle', included: false });
        state = reduceCaptureDisclosure(state, { type: 'toggle', included: true });
        expect(state.warning).toBe('acknowledged');
        let accepted = reduceCaptureDisclosure(createCaptureDisclosureState(false, 1), { type: 'toggle', included: true });
        accepted = reduceCaptureDisclosure(accepted, { type: 'warning', include: true });
        expect(accepted.included).toBe(true);
        expect(captureDisclosureIsAmber(accepted)).toBe(true);
    });

    it('holds its callout until input without arming a timer', () => {
        vi.useFakeTimers();
        let state = reduceCaptureDisclosure(createCaptureDisclosureState(true), { type: 'document', blurCount: 1, cause: 'edit' });
        expect(state.showBlurCallout).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
        vi.runAllTimers();
        expect(state.showBlurCallout).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
        state = reduceCaptureDisclosure(state, { type: 'input' });
        expect(state.showBlurCallout).toBe(false);
    });
});
