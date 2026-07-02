import React from 'react';

import type { MarkdownEditorProps } from './markdownEditorTypes';
import {
    TiptapEditorSurface,
    type MarkdownEditorSurfaceRef,
} from './surfaces/TiptapEditorSurface.web';

/**
 * Web entry for the unified `MarkdownEditor` (Lane W / W1).
 *
 * Thin forwarder onto `TiptapEditorSurface.web` (the direct `@tiptap/react`
 * surface), mirroring `code/editor/CodeEditor.web.tsx`. Metro resolves this file
 * for web; the base `MarkdownEditor.tsx` (owned by Lane N) re-exports the native
 * variant so Node/Vitest/native never pull `@tiptap/*` (R18).
 *
 * The forwarded ref carries both the imperative handle and the controller — see
 * {@link MarkdownEditorSurfaceRef}. This matches `MarkdownEditor.native`, so the
 * integration (Lane I) wires a single ref shape on both platforms.
 */
export const MarkdownEditor = React.forwardRef<MarkdownEditorSurfaceRef, MarkdownEditorProps>(
    function MarkdownEditor(props, ref) {
        return <TiptapEditorSurface {...props} ref={ref} />;
    },
);

export type { MarkdownEditorSurfaceRef } from './surfaces/TiptapEditorSurface.web';
