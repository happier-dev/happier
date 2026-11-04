import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { applyRecordingFrameOperations, createRecordingDocument, reduceRecordingDocument, type RecordingDocument } from './recordingDocument';
import { useRecordingAuthoring, useRecordingFrameAnnotator } from './useRecordingAuthoring';

const source = { uri: 'blob:frame', width: 80, height: 60, scale: 1 };

describe('controlled recording authoring', () => {
    afterEach(() => standardCleanup());

    it('shows external frame marks without a write and preserves them through the next gesture and own echo', async () => {
        const writes = vi.fn();
        let update: (document: RecordingDocument) => void = () => {};
        const initial = createRecordingDocument({ frameDurationMs: 1000 / 25, sourceCaptureRef: 'movie', durationMs: 20_000, includeWindowText: true });
        const external = applyRecordingFrameOperations(initial, 2_000, [{ kind: 'mark.add', mark: {
            id: 'agent-blur', kind: 'blur', rect: { x: 0, y: 0, width: 20, height: 20 }, size: 'm',
        } }], { width: 80, height: 60, scale: 1 });
        const hook = await renderHook(() => {
            const [document, setDocument] = React.useState(initial);
            update = setDocument;
            const authoring = useRecordingAuthoring({ document, onDocumentChange: (next, previous, operations) => {
                writes(next, previous, operations); setDocument(next);
            } });
            return useRecordingFrameAnnotator({ authoring, sourceTimeMs: 2_000, source, onCommitError: () => {} });
        });
        try {
            await act(async () => { update(external); });
            expect(hook.getCurrent().annotator.store.getState().document.marks.map(mark => mark.id)).toEqual(['agent-blur']);
            expect(writes).not.toHaveBeenCalled();
            await act(async () => { hook.getCurrent().annotator.apply([{ kind: 'mark.add', mark: {
                id: 'person-arrow', kind: 'arrow', from: { x: 0, y: 0 }, to: { x: 30, y: 30 }, color: 'red', size: 'm',
            } }]); await hook.getCurrent().flush(); });
            expect(writes).toHaveBeenCalledTimes(1);
            expect(writes.mock.calls[0]?.[1]).toBe(external);
            expect(writes.mock.calls[0]?.[2]).toEqual([{ kind: 'frame.document', sourceTimeMs: 2_000,
                document: writes.mock.calls[0]?.[0].frames[0].document, cause: 'edit' }]);
            expect(hook.getCurrent().annotator.store.getState().document.marks.map(mark => mark.id)).toEqual(['agent-blur', 'person-arrow']);
            const history = hook.getCurrent().annotator.store.getState().history;
            await act(async () => { update(JSON.parse(JSON.stringify(writes.mock.calls[0]?.[0]))); });
            expect(hook.getCurrent().annotator.store.getState().history).toBe(history);
            expect(writes).toHaveBeenCalledTimes(1);
        } finally { await hook.unmount(); }
    });

    it('retains a refused local blur and requires explicit retry against the latest document before delivery can flush', async () => {
        const initial = createRecordingDocument({ frameDurationMs: 1000 / 25, sourceCaptureRef: 'movie', durationMs: 20_000, includeWindowText: true });
        let adopted = initial;
        let update: (document: RecordingDocument) => void = () => {};
        let release: () => void = () => {};
        const gate = new Promise<void>(resolve => { release = resolve; });
        const refusal = new Error('capture_in_use');
        let holding = true;
        const writes: { next: RecordingDocument; previous: RecordingDocument }[] = [];
        const onCommitError = vi.fn();
        const hook = await renderHook(() => {
            const [document, setDocument] = React.useState(initial);
            update = setDocument;
            const authoring = useRecordingAuthoring({ document, onDocumentChange: async (next, previous) => {
                writes.push({ next, previous });
                if (holding) await gate;
                if (previous !== adopted) throw refusal;
                adopted = next; setDocument(next);
            } });
            return useRecordingFrameAnnotator({ authoring, sourceTimeMs: 2_000, source, onCommitError });
        });
        try {
            await act(async () => { hook.getCurrent().annotator.apply([{ kind: 'mark.add', mark: {
                id: 'local-blur', kind: 'blur', rect: { x: 0, y: 0, width: 20, height: 20 }, size: 'm',
            } }]); });
            const agent = reduceRecordingDocument(initial, { kind: 'pin.add', sourceTimeMs: 7_000 });
            await act(async () => { adopted = agent; update(agent); });
            expect(hook.getCurrent().annotator.store.getState().document.marks.map(mark => mark.id)).toEqual(['local-blur']);
            await act(async () => { release(); await expect(hook.getCurrent().flush()).rejects.toBe(refusal); });
            await act(async () => { adopted = { ...agent }; update(adopted); });
            expect(hook.getCurrent().annotator.store.getState().document.marks.map(mark => mark.id)).toEqual(['local-blur']);
            await expect(hook.getCurrent().flush()).rejects.toBe(refusal);
            expect(writes).toHaveLength(1);
            holding = false;
            await act(async () => { await hook.getCurrent().retry(); });
            expect(writes).toHaveLength(2);
            expect(adopted.pins).toEqual([7_000]);
            expect(adopted.frames[0]?.document.marks.map(mark => mark.id)).toEqual(['local-blur']);
            expect(adopted.videoDisclosure.included).toBe(false);
            await expect(hook.getCurrent().flush()).resolves.toBeUndefined();
            expect(onCommitError).toHaveBeenCalledWith(refusal);
        } finally { await hook.unmount(); }
    });

    it('commits only annotation edits, keeps P2 history and awaits the owning write before leaving the frame', async () => {
        const writes: RecordingDocument[] = [];
        let release: () => void = () => {};
        let holding = false;
        const persisted = new Promise<void>(resolve => { release = resolve; });
        const onCommitError = vi.fn();
        const hook = await renderHook(() => {
            const [document, setDocument] = React.useState(() => createRecordingDocument({ frameDurationMs: 1000 / 25, sourceCaptureRef: 'movie', durationMs: 20_000, includeWindowText: false }));
            const authoring = useRecordingAuthoring({ document, onDocumentChange: async next => {
                writes.push(next); setDocument(next); if (holding) await persisted;
            } });
            return { authoring, frame: useRecordingFrameAnnotator({ authoring, sourceTimeMs: 2_000, source, onCommitError }) };
        });
        try {
            expect(writes).toHaveLength(0);
            const annotator = hook.getCurrent().frame.annotator;
            await act(async () => {
                annotator.setTool('crop');
                for (let n = 0; n < 100; n++) { annotator.setCanvasFocused(n % 2 === 0); annotator.select(null); }
            });
            expect(annotator.store.getState().tool).not.toBe('crop');
            expect(writes).toHaveLength(0);
            holding = true;
            await act(async () => { annotator.apply([{ kind: 'mark.add', mark: { id: 'private', kind: 'blur',
                rect: { x: 0, y: 0, width: 20, height: 20 }, size: 'm' } }]); });
            expect(writes).toHaveLength(1);
            expect(hook.getCurrent().authoring.document.videoDisclosure.included).toBe(false);
            expect(annotator.store.getState().history.undo).toHaveLength(1);
            let flushed = false;
            const flush = hook.getCurrent().frame.flush().then(() => { flushed = true; });
            await act(async () => { await Promise.resolve(); });
            expect(flushed).toBe(false);
            await act(async () => { release(); await flush; });
            holding = false;
            await act(async () => { annotator.undo(); await hook.getCurrent().frame.flush(); });
            expect(writes).toHaveLength(2);
            expect(hook.getCurrent().authoring.document.videoDisclosure.included).toBe(true);
            await act(async () => { annotator.redo(); await hook.getCurrent().frame.flush(); });
            expect(writes).toHaveLength(3);
            expect(hook.getCurrent().authoring.document.videoDisclosure.showBlurCallout).toBe(true);
            await act(async () => { await hook.getCurrent().authoring.setIncludeVideo('on'); });
            expect(hook.getCurrent().authoring.document.videoDisclosure.warning).toBe('pending');
            await act(async () => { await hook.getCurrent().authoring.resolveWarning(true); });
            expect(hook.getCurrent().authoring.document.videoDisclosure.included).toBe(true);
            expect(onCommitError).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });

    it('batches a committed trim and note once and reports a failed frame write without retrying or dropping P2 edits', async () => {
        const writes = vi.fn<(document: RecordingDocument) => Promise<void>>().mockResolvedValue(undefined);
        const onCommitError = vi.fn();
        const initial = createRecordingDocument({ frameDurationMs: 1000 / 25, sourceCaptureRef: 'movie', durationMs: 20_000, includeWindowText: false });
        const hook = await renderHook(() => {
            const authoring = useRecordingAuthoring({ document: initial, onDocumentChange: writes });
            return { authoring, frame: useRecordingFrameAnnotator({ authoring, sourceTimeMs: 2_000, source, onCommitError }) };
        });
        try {
            await act(async () => { await hook.getCurrent().authoring.commit([
                { kind: 'trim.set', startMs: 1_000, endMs: 10_000 },
                { kind: 'note.set', id: 'words', sourceTimeMs: 2_000, text: 'One timestamped note' },
            ]); });
            expect(writes).toHaveBeenCalledTimes(1);
            expect(writes.mock.calls[0]?.[0]).toMatchObject({ trim: { startMs: 1_000, endMs: 10_000 },
                notes: [{ sourceTimeMs: 2_000, text: 'One timestamped note' }] });
            const refusal = new Error('native_failure');
            writes.mockRejectedValueOnce(refusal);
            await act(async () => { hook.getCurrent().frame.annotator.apply([{ kind: 'mark.add', mark: {
                id: 'mark', kind: 'arrow', from: { x: 0, y: 0 }, to: { x: 20, y: 20 }, color: 'red', size: 'm',
            } }]); });
            await expect(hook.getCurrent().frame.flush()).rejects.toBe(refusal);
            expect(onCommitError).toHaveBeenCalledWith(refusal);
            expect(writes).toHaveBeenCalledTimes(2);
            expect(hook.getCurrent().frame.annotator.store.getState().document.marks).toHaveLength(1);
        } finally { await hook.unmount(); }
    });
});
