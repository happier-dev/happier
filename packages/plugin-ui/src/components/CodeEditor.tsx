import { forwardRef, useCallback, useRef } from 'react';
import type { CodeEditorHandle, CodeEditorProps, CodeEditorSelectionRange } from '../presentation/content/CodeEditor.js';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { TextField } from './Form.js';

/** The incumbent native/web editor; workspace intelligence remains with its workspace host. */
export const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor({ onSelection, ...props }, ref) {
    const host = useOptionalPluginUiPresentationHost();
    const unsubscribeSelection = useRef<(() => void) | undefined>(undefined);
    const bindEditor = useCallback((handle: CodeEditorHandle | null) => {
        unsubscribeSelection.current?.();
        unsubscribeSelection.current = undefined;
        if (typeof ref === 'function') ref(handle);
        else if (ref) ref.current = handle;
        if (!handle || !onSelection) return;
        let previous: CodeEditorSelectionRange | null | undefined;
        const publish = () => {
            const next = handle.getSelection?.()?.range ?? null;
            // The incumbent subscription also publishes scrolling/geometry; this callback owns only the range.
            if (previous === next || (previous && next && previous.start === next.start && previous.end === next.end)) return;
            previous = next;
            onSelection(next);
        };
        unsubscribeSelection.current = handle.subscribeSelection?.(publish);
        publish();
    }, [onSelection, ref]);
    const editor = host?.renderCodeEditor?.({ ...props, editorRef: bindEditor });
    if (editor !== undefined && editor !== null) return <>{editor}</>;
    return <TextField multiline label={props.testID ?? 'Code'} value={props.value} onChange={props.onChange}
        disabled={props.readOnly} testID={props.testID} presentation={props.presentation === 'canvas' ? 'document' : 'field'} />;
});
export type { CodeEditorProps, CodeEditorHandle, CodeEditorSelectionRange, CodeEditorCompletionSource, CodeEditorCompletionPosition, CodeEditorCompletionItem } from '../presentation/content/CodeEditor.js';
