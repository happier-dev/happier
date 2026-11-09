import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';
import type { TextInputState } from '@/components/ui/forms/MultiTextInput';
import { usePromptPickerController } from './usePromptPickerController';
import { renderPromptTemplateTextV1 } from '@happier-dev/protocol/prompts/library/renderPromptTemplateTextV1';

describe('prompt picker composer admission', () => {
    function setup(text = '@file before selected after') {
        const stateRef = { current: { text, selection: { start: 13, end: 21 } } as TextInputState };
        const apply = vi.fn((next: string, selection: TextInputState['selection']) => {
            stateRef.current = { text: next, selection };
        });
        const inputRef = { current: { setTextAndSelection: apply, setSelection: vi.fn(), focus: vi.fn() } };
        const submitted: string[] = [];
        const send = () => { submitted.push(stateRef.current.text); };
        return { stateRef, inputRef, send, apply, submitted };
    }

    it('is inert until explicitly opened, then inserts only at the selection and selects the argument', async () => {
        const input = setup();
        const hook = await renderHook(() => usePromptPickerController({ ...input, composerKey: 'draft', editable: true, canSend: true }));
        expect(hook.getCurrent().isOpen).toBe(false);
        expect(input.apply).not.toHaveBeenCalled();
        await act(async () => { await hook.getCurrent().open(); });
        await act(async () => { await hook.getCurrent().apply(async () => renderPromptTemplateTextV1({
            templateMarkdown: 'Review $ARGUMENTS please', argsText: '',
        }), 'insert'); });
        expect(input.stateRef.current).toEqual({ text: '@file before Review  please after', selection: { start: 20, end: 20 } });
        expect(input.submitted).toEqual([]);
        expect(hook.getCurrent().isOpen).toBe(false);
    });

    it('replaces an active slash span and sends through the existing host callback', async () => {
        const input = setup('before /prompt after');
        input.stateRef.current.selection = { start: 14, end: 14 };
        const hook = await renderHook(() => usePromptPickerController({ ...input, composerKey: 'session', editable: true, canSend: true }));
        await act(async () => { await hook.getCurrent().open({ start: 7, end: 14 }); });
        await act(async () => { await hook.getCurrent().apply(async () => renderPromptTemplateTextV1({
            templateMarkdown: 'Hello', argsText: '',
        }), 'send'); });
        expect(input.stateRef.current.text).toBe('before Hello after');
        expect(input.submitted).toEqual(['before Hello after']);
    });

    it('rejects delayed expansion after a newer edit or a different composer, preserving the new draft', async () => {
        const input = setup();
        let resolve!: (value: { text: string }) => void;
        const hook = await renderHook((props: { composerKey: string }) => usePromptPickerController({ ...input, ...props, editable: true, canSend: true }), { initialProps: { composerKey: 'first' } });
        await act(async () => { await hook.getCurrent().open(); });
        let pending!: Promise<boolean>;
        await act(async () => { pending = hook.getCurrent().apply(() => new Promise((done) => { resolve = done; }), 'insert'); });
        input.stateRef.current = { text: 'newer', selection: { start: 5, end: 5 } };
        await hook.rerender({ composerKey: 'second' });
        await act(async () => { resolve({ text: 'obsolete' }); await pending; });
        expect(input.apply).not.toHaveBeenCalled();
        expect(input.stateRef.current.text).toBe('newer');
    });

    it('never edits when send is locked and restores the original caret on cancel', async () => {
        const input = setup();
        const hook = await renderHook(() => usePromptPickerController({ ...input, composerKey: 'draft', editable: true, canSend: false }));
        await act(async () => { await hook.getCurrent().open(); });
        await act(async () => { await hook.getCurrent().apply(async () => ({ text: 'Hello' }), 'send'); });
        expect(input.apply).not.toHaveBeenCalled();
        await act(async () => hook.getCurrent().close());
        expect(input.inputRef.current.setSelection).toHaveBeenCalledWith({ start: 13, end: 21 });
        expect(input.inputRef.current.focus).toHaveBeenCalled();
    });

    it('refuses an aborted Action expansion before editing or handing off submission', async () => {
        const input = setup();
        const controller = new AbortController();
        let resolve!: (value: { text: string }) => void;
        const hook = await renderHook(() => usePromptPickerController({ ...input, composerKey: 'draft', editable: true, canSend: true }));
        await act(async () => { hook.getCurrent().open(); });
        let pending!: Promise<boolean>;
        await act(async () => { pending = hook.getCurrent().apply(() => new Promise(done => { resolve = done; }), 'send', controller.signal); });
        controller.abort();
        await act(async () => { resolve({ text: 'obsolete' }); expect(await pending).toBe(false); });
        expect(input.stateRef.current.text).toBe('@file before selected after');
        expect(input.submitted).toEqual([]);
        expect(input.apply).not.toHaveBeenCalled();
    });
});
