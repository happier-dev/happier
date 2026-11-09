import type * as React from 'react';
import type { editor as MonacoEditorApi } from 'monaco-editor';

import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';
import type { createMonacoInlineSuggestions } from './monacoInlineSuggestions';
import type { createMonacoNextEdit } from './monacoNextEdit';
import type { CodeEditorFindHandle } from '../codeEditorTypes';

/** The surface's transient editor UI dismisses before its enclosing pane. */
export function useMonacoEscapeLayer(options: Readonly<{
    editorRef: React.RefObject<MonacoEditorApi.IStandaloneCodeEditor | null>;
    inline: ReturnType<typeof createMonacoInlineSuggestions> | null;
    nextEditRef: React.RefObject<ReturnType<typeof createMonacoNextEdit> | null>;
    find: Pick<CodeEditorFindHandle, 'isOpen'>;
}>) {
    useEscapeLayer({
        enabled: options.inline !== null,
        priority: ESCAPE_LAYER_PRIORITIES.composerSuggestions,
        allowEditableTarget: true,
        onEscape: event => {
            const target = (event as { target?: unknown } | null)?.target;
            const editor = options.editorRef.current;
            if (!(target instanceof Node) || !editor?.getDomNode()?.contains(target)) return false;
            // These widgets have native Escape bindings. App capture must yield before
            // either our next-edit/ghost layer or the enclosing pane can dismiss.
            if (options.inline?.handle.getContext()?.suggestWidgetOpen || options.find.isOpen()) return 'defer-to-target';
            if (options.nextEditRef.current?.dismiss()) return true;
            if (!options.inline?.handle.getSuggestion()) return false;
            options.inline.command('inlineSuggestDismiss');
            return true;
        },
    });
}
