import React from 'react';

import type { CodeEditorProps } from './codeEditorTypes';
import { CodeMirrorWebViewSurface } from './surfaces/CodeMirrorWebViewSurface.native';

export function CodeEditor(props: CodeEditorProps) {
    return <CodeMirrorWebViewSurface {...props} />;
}
