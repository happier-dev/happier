import { describe, expect, it, vi } from 'vitest';

import {
    createBrowserAnnotationRuntimeExecutor,
    resolveBrowserAnnotationRuntimeActionIdForRequest,
    type BrowserAnnotationAdapterRequest,
    type BrowserContextAnnotationAdapter,
} from './runtimeAnnotationExecutor';
import { createBrowserContextState } from './state';

type Recorded = { requests: BrowserAnnotationAdapterRequest[] };

function buildRecordingAdapter(): { adapter: BrowserContextAnnotationAdapter; recorded: Recorded } {
    const recorded: Recorded = { requests: [] };
    const adapter: BrowserContextAnnotationAdapter = {
        dispatch: vi.fn((request: BrowserAnnotationAdapterRequest) => {
            recorded.requests.push(request);
            // captureRegion/captureElement resolve to a captured result; the others are not exercised
            // here. Returning a captured shape lets the success path serialize.
            return {
                status: 'captured' as const,
                state: createBrowserContextState(),
                attachmentId: 'browser_context_attachment:ctx_1',
                contextId: 'ctx_1',
            };
        }),
    };
    return { adapter, recorded };
}

const BASE = { browserSessionId: 'browser_session_1', viewId: 'view_1' } as const;

describe('createBrowserAnnotationRuntimeExecutor — structural validation (ANNO-4a)', () => {
    it('maps only runtime-backed adapter requests to the canonical annotation action ids', () => {
        expect(resolveBrowserAnnotationRuntimeActionIdForRequest({ kind: 'start' }))
            .toBe('browser.context.annotation.start');
        expect(resolveBrowserAnnotationRuntimeActionIdForRequest({
            kind: 'addDraftTarget',
            target: { kind: 'element', selectorPath: '#header' },
        })).toBeNull();
    });

    it('rejects a malformed element target (missing selectorPath) with invalid_parameters and never dispatches', async () => {
        const { adapter, recorded } = buildRecordingAdapter();
        const execute = createBrowserAnnotationRuntimeExecutor({ adapter });

        const result = await execute('browser.context.annotation.captureElement', {
            ...BASE,
            target: { kind: 'element' },
        });

        expect(result).toEqual({ ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' });
        expect(recorded.requests).toHaveLength(0);
    });

    it('rejects a present-but-malformed stroke (point outside [0,1]) with invalid_parameters and never dispatches', async () => {
        const { adapter, recorded } = buildRecordingAdapter();
        const execute = createBrowserAnnotationRuntimeExecutor({ adapter });

        const result = await execute('browser.context.annotation.captureRegion', {
            ...BASE,
            stroke: { shape: 'freehand', points: [{ x: 2, y: 0 }] },
        });

        expect(result).toEqual({ ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' });
        expect(recorded.requests).toHaveLength(0);
    });

    it('rejects a malformed region target (negative width) with invalid_parameters', async () => {
        const { adapter, recorded } = buildRecordingAdapter();
        const execute = createBrowserAnnotationRuntimeExecutor({ adapter });

        const result = await execute('browser.context.annotation.captureRegion', {
            ...BASE,
            target: { kind: 'region', rect: { x: 0, y: 0, width: -4, height: 10 } },
        });

        expect(result).toEqual({ ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' });
        expect(recorded.requests).toHaveLength(0);
    });

    it('passes a fully valid element target + stroke through to the adapter (parsed, not raw-cast)', async () => {
        const { adapter, recorded } = buildRecordingAdapter();
        const execute = createBrowserAnnotationRuntimeExecutor({ adapter });

        const result = await execute('browser.context.annotation.captureElement', {
            ...BASE,
            target: { kind: 'element', selectorPath: '#header', accessibleName: 'Header' },
            stroke: { shape: 'freehand', points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }] },
        });

        expect(result).toMatchObject({ status: 'captured', contextId: 'ctx_1' });
        expect(recorded.requests).toHaveLength(1);
        const request = recorded.requests[0];
        expect(request.kind).toBe('captureElement');
        if (request.kind === 'captureElement') {
            expect(request.target).toEqual({ kind: 'element', selectorPath: '#header', accessibleName: 'Header' });
            expect(request.stroke).toEqual({ shape: 'freehand', points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }] });
        }
    });

    it('still allows a region capture with no target and no stroke (full-page provider snapshot)', async () => {
        const { adapter, recorded } = buildRecordingAdapter();
        const execute = createBrowserAnnotationRuntimeExecutor({ adapter });

        const result = await execute('browser.context.annotation.captureRegion', { ...BASE });

        expect(result).toMatchObject({ status: 'captured' });
        expect(recorded.requests).toHaveLength(1);
        expect(recorded.requests[0].kind).toBe('captureRegion');
    });
});
