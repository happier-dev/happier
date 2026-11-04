import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaAnnotationActionRequestV1 } from '@happier-dev/protocol';
import { createImageAnnotator } from '@/components/ui/media/annotation/annotatorStore';
import { createCaptureDisclosureState, reduceCaptureDisclosureDocument } from '@/components/screenCapture/disclosure/captureDisclosureRule';
import { registerCaptureAnnotationTarget, requestCaptureAnnotationAction } from './captureAnnotationActions';

const events = vi.hoisted(() => new Set<(event: { payload: unknown }) => void>());
// Native IPC is the boundary; annotation operations and the disclosure owner stay real.
vi.mock('@tauri-apps/api/event', () => ({ listen: async (_event: string, handler: (event: { payload: unknown }) => void) => {
    events.add(handler);
    return () => events.delete(handler);
} }));

const scope = { serverId: 'home', accountId: 'account' };
const unavailable = { status: 'unavailable', reason: 'annotation.targetUnavailable' } as const;
let lifetimes: AbortController[];
let requests: number;
beforeEach(() => {
    lifetimes = [];
    requests = 0;
    let requestId = 0;
    const ready = new Set<string>();
    const pending = new Map<number, { captureRef: string; resolve: (result: unknown) => void }>();
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args: Record<string, unknown>) => {
        const captureRef = String(args.captureRef);
        if (command === 'desktop_capture_annotation_ready') {
            if (args.ready) ready.add(captureRef);
            else {
                ready.delete(captureRef);
                for (const [id, waiter] of pending) if (waiter.captureRef === captureRef) {
                    pending.delete(id);
                    waiter.resolve(unavailable);
                }
            }
            return;
        }
        if (command === 'desktop_capture_annotation_request') {
            requests++;
            if (!ready.has(captureRef)) return unavailable;
            const id = ++requestId;
            return new Promise(resolve => {
                pending.set(id, { captureRef, resolve });
                for (const receive of events) receive({ payload: { captureRef, requestId: id, request: args.request } });
            });
        }
        if (command === 'desktop_capture_annotation_result') {
            const id = Number(args.requestId);
            const waiter = pending.get(id);
            if (waiter?.captureRef === captureRef) { pending.delete(id); waiter.resolve(args.result); }
            return;
        }
        throw new Error(`Unexpected native annotation boundary: ${command}`);
    } });
});
afterEach(async () => {
    for (const lifetime of lifetimes) lifetime.abort();
    await Promise.resolve();
    events.clear();
    vi.unstubAllGlobals();
});

async function open(captureRef: string) {
    const lifetime = new AbortController();
    lifetimes.push(lifetime);
    let disclosure = createCaptureDisclosureState(true);
    let changes = 0;
    const annotator = createImageAnnotator({ source: { uri: 'data:image/png;base64,AQID', width: 40, height: 30, scale: 1 },
        onDocumentChange(document, cause) {
            changes++;
            disclosure = reduceCaptureDisclosureDocument(disclosure, document, cause);
        } });
    await registerCaptureAnnotationTarget({ captureRef, annotator, signal: lifetime.signal });
    return { annotator, lifetime, disclosure: () => disclosure, changes: () => changes };
}
function request(captureRef: string, input: Readonly<{ reset: true }> | Readonly<{ operations: Extract<MediaAnnotationActionRequestV1, { actionId: 'media.annotation.apply' }>['input']['operations'] }>) {
    return requestCaptureAnnotationAction(captureRef, { actionId: 'media.annotation.apply',
        input: { scope, target: { kind: 'capture', captureRef }, ...input } });
}

describe('still-capture annotation endpoints', () => {
    it('refuses a still-capture Action outside a desktop host', async () => {
        vi.stubGlobal('__TAURI_INTERNALS__', undefined);
        expect(await request('first', { reset: true })).toEqual({ ok: false, errorCode: 'desktop_only', error: 'desktop_only' });
        expect(requests).toBe(0);
    });
    it('edits only the addressed editor and updates its existing blur disclosure and Undo', async () => {
        const first = await open('first');
        const second = await open('second');
        const sibling = second.annotator.store.getState();
        const count = requests;
        const blur = { kind: 'mark.add', mark: { id: 'private', kind: 'blur', rect: { x: 1, y: 2, width: 10, height: 10 }, size: 'm' } } as const;
        expect(await request('first', { operations: [blur] })).toEqual({ status: 'replaced' });
        expect(first.annotator.store.getState().document.marks).toEqual([blur.mark]);
        expect(first.disclosure()).toMatchObject({ included: false, blurCount: 1, showBlurCallout: true });
        expect(first.changes()).toBe(1);
        expect(second.annotator.store.getState()).toBe(sibling);
        expect(second.disclosure()).toMatchObject({ included: true, blurCount: 0 });
        expect(second.changes()).toBe(0);
        expect(requests - count).toBe(1);
        expect(await requestCaptureAnnotationAction('first', { actionId: 'media.annotation.read',
            input: { scope, target: { kind: 'capture', captureRef: 'first' } } }))
            .toEqual({ document: first.annotator.store.getState().document, image: { width: 40, height: 30, scale: 1 }, hasBlur: true });
        expect(first.changes()).toBe(1);
        first.annotator.undo();
        expect(first.disclosure()).toMatchObject({ included: true, blurCount: 0 });
        expect(await request('first', { operations: [blur] })).toEqual({ status: 'replaced' });
        expect(await request('first', { reset: true })).toEqual({ status: 'reverted' });
        expect(first.annotator.store.getState().document.marks).toEqual([]);
        // Reset is an edit, not a user Undo that can restore disclosure.
        expect(first.disclosure()).toMatchObject({ included: false, blurCount: 0 });
        expect(second.annotator.store.getState()).toBe(sibling);
    });

    it('refuses missing and retired references without changing a sibling or retaining its listener', async () => {
        const first = await open('first');
        const second = await open('second');
        const sibling = second.annotator.store.getState();
        expect(await request('missing', { reset: true })).toEqual(unavailable);
        first.lifetime.abort();
        await Promise.resolve();
        expect(events.size).toBe(1);
        expect(await request('first', { reset: true })).toEqual(unavailable);
        expect(second.annotator.store.getState()).toBe(sibling);
        expect(second.changes()).toBe(0);
    });

    it('settles invalid mark edits without partially replacing the current document', async () => {
        const first = await open('first');
        const arrow = { kind: 'mark.add', mark: { id: 'arrow', kind: 'arrow', from: { x: 1, y: 1 }, to: { x: 10, y: 10 }, color: 'red', size: 'm' } } as const;
        expect(await request('first', { operations: [arrow] })).toEqual({ status: 'replaced' });
        const document = first.annotator.store.getState().document;
        expect(await request('first', { operations: [arrow] })).toEqual({ ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' });
        expect(first.annotator.store.getState().document).toBe(document);
    });
});
