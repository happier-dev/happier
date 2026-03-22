import React from 'react';

import type { CodeEditorHandle, CodeEditorProps } from './codeEditorTypes';
import { MonacoEditorSurface } from './surfaces/MonacoEditorSurface.web';

export const CodeEditor = React.forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor(props, ref) {
    return <MonacoEditorSurface {...props} ref={ref} />;
});
