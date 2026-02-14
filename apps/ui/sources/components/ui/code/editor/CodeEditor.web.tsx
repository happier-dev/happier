import React from 'react';

import type { CodeEditorProps } from './codeEditorTypes';
import { MonacoEditorSurface } from './surfaces/MonacoEditorSurface.web';

export function CodeEditor(props: CodeEditorProps) {
    return <MonacoEditorSurface {...props} />;
}
