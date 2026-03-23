import React from 'react';
import { Platform } from 'react-native';

import type { CodeEditorHandle, CodeEditorProps } from './codeEditorTypes';

type Impl = React.ForwardRefExoticComponent<CodeEditorProps & React.RefAttributes<CodeEditorHandle>>;

function loadImpl(): Impl {
    // Vite/Vitest doesn't resolve RN platform suffixes by default, so we route via runtime Platform.OS.
    // The bundler still tree-shakes appropriately in production builds.
    if (Platform.OS === 'web') {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('./CodeEditor.web').CodeEditor as Impl;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('./CodeEditor.native').CodeEditor as Impl;
}

const ImplComponent = loadImpl();

export const CodeEditor = React.forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor(props, ref) {
    return <ImplComponent {...props} ref={ref} />;
});
