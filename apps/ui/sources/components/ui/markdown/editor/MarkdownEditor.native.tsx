import React from 'react';

import type { MarkdownEditorProps } from './markdownEditorTypes';
import {
    TiptapWebViewSurface,
    type MarkdownEditorSurfaceRef,
} from './surfaces/TiptapWebViewSurface.native';

/**
 * Native `MarkdownEditor` (Lane N / N1) — thin forwarder to the WebView surface.
 *
 * Mirrors `code/editor/CodeEditor.native.tsx`. TipTap reaches native ONLY as the
 * prebuilt bundle string inside the surface's WebView HTML; this module (and the
 * surface it forwards to) imports NO `@tiptap/*` (R18).
 *
 * The forwarded ref carries both the imperative handle and the controller — see
 * {@link MarkdownEditorSurfaceRef}.
 */
export const MarkdownEditor = React.forwardRef<MarkdownEditorSurfaceRef, MarkdownEditorProps>(
    function MarkdownEditor(props, ref) {
        return <TiptapWebViewSurface {...props} ref={ref} />;
    },
);

export type { MarkdownEditorSurfaceRef } from './surfaces/TiptapWebViewSurface.native';
