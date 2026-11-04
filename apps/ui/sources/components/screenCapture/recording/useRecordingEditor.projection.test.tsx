import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { createRecordingDocument } from './recordingDocument';
import { insertRecordingTimeChip } from './recordingEditorProjection';
import { useRecordingFrameAnnotator } from './useRecordingAuthoring';
import { useRecordingEditor, type RecordingMediaAccess } from './useRecordingEditor';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
afterEach(() => standardCleanup());

// Frame decoding is a browser boundary; authoring and the effective projection stay real.
const source = { uri: 'data:image/png;base64,AQID', width: 80, height: 60, scale: 1 };
const media: RecordingMediaAccess = { renderPlayer: () => null, withFrames: operation => operation({
    seekTo: () => {}, readFrame: async () => ({ ...source, timeSeconds: 0 }),
}) };

describe('recording editor effective projection', () => {
    it('projects blur disclosure through edit, undo, redo and explicit inclusion', async () => {
        const hook = await renderHook(() => {
            const [document, setDocument] = React.useState(() => createRecordingDocument({ sourceCaptureRef: 'movie',
                durationMs: 20_000, frameDurationMs: 1000 / 25, includeWindowText: false }));
            const editor = useRecordingEditor({ document, commitDocument: next => { setDocument(next); }, media, scale: 1 });
            const frame = useRecordingFrameAnnotator({ authoring: editor.authoring, sourceTimeMs: 2_000, source,
                onCommitError: error => { throw error; } });
            return { editor, frame };
        });
        expect(hook.getCurrent().editor.projection.includeVideo).toBe(true);
        await act(async () => {
            hook.getCurrent().frame.annotator.apply([{ kind: 'mark.add', mark: { id: 'private', kind: 'blur',
                rect: { x: 0, y: 0, width: 20, height: 20 }, size: 'm' } }]);
            await hook.getCurrent().frame.flush();
        });
        expect(hook.getCurrent().editor.projection.includeVideo).toBe(false);
        await act(async () => { hook.getCurrent().frame.annotator.undo(); await hook.getCurrent().frame.flush(); });
        expect(hook.getCurrent().editor.projection.includeVideo).toBe(true);
        await act(async () => { hook.getCurrent().frame.annotator.redo(); await hook.getCurrent().frame.flush(); });
        expect(hook.getCurrent().editor.projection.includeVideo).toBe(false);
        await act(async () => { await hook.getCurrent().editor.authoring.setIncludeVideo('on'); });
        expect(hook.getCurrent().editor.projection.includeVideo).toBe(false);
        await act(async () => { await hook.getCurrent().editor.authoring.resolveWarning(true); });
        expect(hook.getCurrent().editor.projection.includeVideo).toBe(true);
    });

    it('includes an uncommitted timestamped note in the outgoing frame projection', async () => {
        const document = createRecordingDocument({ sourceCaptureRef: 'movie', durationMs: 20_000,
            frameDurationMs: 1000 / 25, includeWindowText: false });
        const commitDocument = vi.fn();
        const hook = await renderHook(() => useRecordingEditor({ document, commitDocument, media, scale: 1 }));
        const draft = insertRecordingTimeChip({ text: 'Inspect this', references: [] }, 0, 3_000);
        await act(async () => {
            hook.getCurrent().onReferencesChange(draft.references);
            hook.getCurrent().onNoteChange(draft.text);
        });
        expect(hook.getCurrent().projection.frames).toMatchObject([{ sourceTimeMs: 3_000,
            notes: [{ text: 'Inspect this' }] }]);
        expect(hook.getCurrent().authoring.document.notes).toEqual([]);
        expect(commitDocument).not.toHaveBeenCalled();
    });
});
