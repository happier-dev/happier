import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import type { MediaPlayerVideoControls } from '@/components/workspaces/files/file/videoFrameAccess';
import { createRecordingDocument, type RecordingDocument } from './recordingDocument';
import { useRecordingEditor, type RecordingEditor, type RecordingMediaAccess } from './useRecordingEditor';
import { useRecordingSurface } from './useRecordingSurface';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
afterEach(() => standardCleanup());

// The decoder and native document admission are system boundaries; the editor, keyed
// surface leaf, annotator history and flush/retry owner all run together unchanged.
async function mountedEditor(write: (next: RecordingDocument) => Promise<void>) {
    const controls: MediaPlayerVideoControls = {
        seekTo: () => {},
        readFrame: async ({ timeSeconds = 0 } = {}) => ({ uri: 'data:image/png;base64,AQID', width: 80, height: 60, timeSeconds }),
    };
    const media: RecordingMediaAccess = { renderPlayer: () => null, withFrames: operation => operation(controls) };
    let editor!: RecordingEditor;
    function Capture() {
        const [document, setDocument] = React.useState(() => createRecordingDocument({ sourceCaptureRef: 'movie',
            durationMs: 20_000, frameDurationMs: 1000 / 25, includeWindowText: false }));
        editor = useRecordingEditor({ document, media, scale: 1, commitDocument: async next => {
            await write(next); setDocument(next);
        } });
        const surface = useRecordingSurface(editor, { media, aspectRatio: 4 / 3, appName: null, agentName: null, byteSize: 400 });
        return surface.frameSession;
    }
    await renderScreen(<Capture />);
    await act(async () => editor.setControls(controls));
    return () => editor;
}

const blur = { kind: 'mark.add', mark: { id: 'private', kind: 'blur', rect: { x: 0, y: 0, width: 20, height: 20 }, size: 'm' } } as const;

describe('recording frame transitions', () => {
    it.each(['seek', 'decode Retry'] as const)('keeps a refused blur in its keyed leaf through %s, blocks delivery, and retains it for explicit Retry', async transition => {
        const refusal = new Error('capture_in_use');
        const write = vi.fn<(next: RecordingDocument) => Promise<void>>().mockRejectedValueOnce(refusal).mockResolvedValue(undefined);
        const editor = await mountedEditor(write);
        await act(async () => { editor().seek(2_000); });
        const first = editor().session!;
        await act(async () => { first.annotator.apply([blur]); await expect(first.flush()).rejects.toBe(refusal); });
        await act(async () => { if (transition === 'seek') editor().seek(3_000); else editor().retry(); });
        expect(editor().frame?.sourceTimeMs).toBe(2_000);
        expect(editor().session).toBe(first);
        expect(first.annotator.store.getState().document.marks.map(mark => mark.id)).toEqual(['private']);
        expect(editor().commitFailed).toBe(true);
        await expect(editor().prepareDelivery()).rejects.toBe(refusal);
        expect(write).toHaveBeenCalledTimes(1);
        await act(async () => { await editor().session!.retry(); });
        expect(editor().effective.frames[0]?.document.marks.map(mark => mark.id)).toEqual(['private']);
        expect(editor().projection.includeVideo).toBe(false);
        await act(async () => { editor().seek(3_000); });
        expect(editor().frame?.sourceTimeMs).toBe(3_000);
        expect(editor().session).not.toBe(first);
        await expect(editor().prepareDelivery()).resolves.toMatchObject({ note: '' });
        expect(write).toHaveBeenCalledTimes(2);
    });

    it('waits for an admitted frame write before replacing the leaf on a successful seek', async () => {
        let finish: () => void = () => {};
        const pending = new Promise<void>(resolve => { finish = resolve; });
        const editor = await mountedEditor(async () => pending);
        const first = editor().session!;
        await act(async () => { first.annotator.apply([blur]); });
        await act(async () => { editor().seek(3_000); });
        expect(editor().frame?.sourceTimeMs).toBe(0);
        expect(editor().session).toBe(first);
        await act(async () => { finish(); await first.flush(); });
        expect(editor().frame?.sourceTimeMs).toBe(3_000);
        expect(editor().effective.frames[0]?.document.marks.map(mark => mark.id)).toEqual(['private']);
    });
});
