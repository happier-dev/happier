import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';
import type { CodeEditorHandle } from './codeEditorTypes';
import { usePublishCodeEditorHandle } from './usePublishCodeEditorHandle';

describe('editor handle publication', () => {
    it('notifies only accepted incumbent changes when an outgoing transition retires late', async () => {
        const editorRef = { current: null as CodeEditorHandle | null };
        const notify = vi.fn();
        const outgoing = await renderHook(() => usePublishCodeEditorHandle(editorRef, notify));
        const incoming = await renderHook(() => usePublishCodeEditorHandle(editorRef, notify));
        const first: CodeEditorHandle = { getValue: () => 'first', flushPendingChange: async () => {} };
        const second: CodeEditorHandle = { getValue: () => 'second', flushPendingChange: async () => {} };
        outgoing.getCurrent()(first);
        incoming.getCurrent()(second);
        outgoing.getCurrent()(null);
        expect(editorRef.current).toBe(second);
        expect(notify.mock.calls.map(([handle]) => handle)).toEqual([first, second]);
        incoming.getCurrent()(null);
        expect(editorRef.current).toBeNull();
        expect(notify.mock.calls.map(([handle]) => handle)).toEqual([first, second, null]);
    });
});
