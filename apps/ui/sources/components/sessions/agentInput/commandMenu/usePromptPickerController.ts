import * as React from 'react';
import type { TextInputState, MultiTextInputHandle } from '@/components/ui/forms/MultiTextInput';
import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';

type PickerInput = Readonly<{
    composerKey: string;
    editable: boolean;
    canSend: boolean;
    stateRef: React.MutableRefObject<TextInputState>;
    inputRef: React.RefObject<Pick<MultiTextInputHandle, 'setTextAndSelection' | 'setSelection' | 'focus'> | null>;
    send: () => void;
}>;

type Admission = Readonly<{
    composerKey: string;
    snapshot: TextInputState;
    range: TextInputState['selection'];
    currentness: ReturnType<typeof captureActiveServerAccountScopeCurrentness>;
}> & { busy: boolean; dispose?: () => void };

/** Explicit picker state. Detailed data is owned by the open picker leaf only. */
export function usePromptPickerController(input: PickerInput) {
    const latest = React.useRef(input);
    latest.current = input;
    const admission = React.useRef<Admission | null>(null);
    const [isOpen, setOpen] = React.useState(false);

    const dismiss = React.useCallback((restoreFocus: boolean) => {
        const pending = admission.current;
        admission.current = null;
        pending?.dispose?.();
        setOpen(false);
        if (!restoreFocus || !pending || latest.current.composerKey !== pending.composerKey
            || !pending.currentness.isCurrent() || !latest.current.editable) return;
        // A newer draft keeps its own caret. Cancel restores the admitted selection only.
        if (latest.current.stateRef.current === pending.snapshot) {
            latest.current.inputRef.current?.setSelection(pending.snapshot.selection);
        }
        latest.current.inputRef.current?.focus();
    }, []);
    const close = React.useCallback(() => dismiss(true), [dismiss]);
    const open = React.useCallback((range?: TextInputState['selection']) => {
        const current = latest.current;
        if (!current.editable || !current.inputRef.current) return false;
        if (admission.current) return true;
        const snapshot = current.stateRef.current;
        const pending: Admission = {
            composerKey: current.composerKey, snapshot, range: range ?? snapshot.selection,
            currentness: captureActiveServerAccountScopeCurrentness(), busy: false,
        };
        admission.current = pending;
        pending.dispose = pending.currentness.onRetire(() => dismiss(false)).dispose;
        if (admission.current !== pending) return false;
        setOpen(true);
        return true;
    }, [dismiss]);

    React.useEffect(() => {
        if (admission.current && (admission.current.composerKey !== input.composerKey || !input.editable)) dismiss(false);
    }, [input.composerKey, input.editable, dismiss]);
    React.useEffect(() => () => {
        const pending = admission.current;
        admission.current = null;
        pending?.dispose?.();
    }, []);

    const apply = React.useCallback(async (
        expand: () => Promise<Readonly<{ text: string; argumentRange?: readonly [number, number] }>>,
        mode: 'insert' | 'send',
    ): Promise<boolean> => {
        const pending = admission.current;
        const isCurrent = () => pending !== null && admission.current === pending
            && pending.currentness.isCurrent()
            && latest.current.composerKey === pending.composerKey
            && latest.current.stateRef.current === pending.snapshot
            && latest.current.editable && (mode !== 'send' || latest.current.canSend);
        if (!pending || pending.busy || !isCurrent()) return false;
        pending.busy = true;
        try {
            const rendered = await expand();
            if (!isCurrent() || !latest.current.inputRef.current) return false;
            const { start, end } = pending.range;
            const text = pending.snapshot.text.slice(0, start) + rendered.text + pending.snapshot.text.slice(end);
            const selection = rendered.argumentRange
                ? { start: start + rendered.argumentRange[0], end: start + rendered.argumentRange[1] }
                : { start: start + rendered.text.length, end: start + rendered.text.length };
            latest.current.inputRef.current.setTextAndSelection(text, selection);
            dismiss(false);
            if (mode === 'send') latest.current.send();
            else latest.current.inputRef.current?.focus();
            return true;
        } finally {
            pending.busy = false;
        }
    }, [dismiss]);
    return { isOpen, open, close, apply };
}
