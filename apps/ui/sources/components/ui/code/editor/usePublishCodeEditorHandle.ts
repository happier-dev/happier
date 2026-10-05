import * as React from 'react';

import type { CodeEditorHandle } from './codeEditorTypes';

/** Outgoing transition layers may unmount after the incoming editor publishes. */
export function usePublishCodeEditorHandle(
    editorRef: React.MutableRefObject<CodeEditorHandle | null>,
    onPublished?: (handle: CodeEditorHandle | null) => void,
): React.RefCallback<CodeEditorHandle> {
    const publishedHandle = React.useRef<CodeEditorHandle | null>(null);
    const onPublishedRef = React.useRef(onPublished);
    onPublishedRef.current = onPublished;
    return React.useCallback((handle: CodeEditorHandle | null) => {
        if (handle !== null || editorRef.current === publishedHandle.current) {
            editorRef.current = handle;
            onPublishedRef.current?.(handle);
        }
        publishedHandle.current = handle;
    }, [editorRef]);
}
