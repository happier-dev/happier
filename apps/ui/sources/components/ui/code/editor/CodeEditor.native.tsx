import React from 'react';

import type { CodeEditorHandle, CodeEditorProps } from './codeEditorTypes';
import { CodeMirrorWebViewSurface } from './surfaces/CodeMirrorWebViewSurface.native';

export const CodeEditor = React.forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor(props, ref) {
    return <CodeMirrorWebViewSurface {...props} ref={ref} />;
});
