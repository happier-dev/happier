import React from 'react';

import type { MarkdownEditorProps } from './markdownEditorTypes';
import type { MarkdownEditorSurfaceRef } from './surfaces/TiptapEditorSurface.web';

const TiptapEditorSurface = React.lazy(async () => {
    const surface = await import('./markdownEditorEngine.web');
    return { default: surface.TiptapEditorSurface };
});

/**
 * Web entry for the unified `MarkdownEditor` (Lane W / W1).
 *
 * Demand-loaded forwarder onto `TiptapEditorSurface.web` (the direct `@tiptap/react`
 * surface), mirroring `code/editor/CodeEditor.web.tsx`. Metro resolves this file
 * for web; the base `MarkdownEditor.tsx` (owned by Lane N) re-exports the native
 * variant so Node/Vitest/native never pull `@tiptap/*` (R18).
 *
 * The forwarded ref carries both the imperative handle and the controller — see
 * {@link MarkdownEditorSurfaceRef}. This matches `MarkdownEditor.native`, so the
 * integration (Lane I) wires a single ref shape on both platforms.
 * Its caller owns Suspense around the complete panel, so subscriptions do not
 * commit against an empty surface ref while the engine is arriving.
 */
export const MarkdownEditor = React.forwardRef<MarkdownEditorSurfaceRef, MarkdownEditorProps>(
    function MarkdownEditor(props, ref) {
        return <TiptapEditorSurface {...props} ref={ref} />;
    },
);

export type { MarkdownEditorSurfaceRef } from './surfaces/TiptapEditorSurface.web';
