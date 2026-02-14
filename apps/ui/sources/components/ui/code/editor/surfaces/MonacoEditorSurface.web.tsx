import React from 'react';
import { TextInput, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type { CodeEditorProps } from '../codeEditorTypes';
import { resolveMonacoLanguageId } from '../codeEditorTypes';

type MonacoType = any;

declare global {
    interface Window {
        monaco?: MonacoType;
        require?: any;
        MonacoEnvironment?: any;
    }
}

const MONACO_LOADER_SCRIPT_SRC = '/monaco/vs/loader.js';

let loaderPromise: Promise<void> | null = null;

function ensureMonacoLoader(): Promise<void> {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
        return Promise.reject(new Error('Monaco loader requires a browser environment'));
    }
    if (window.require) {
        return Promise.resolve();
    }
    if (loaderPromise) return loaderPromise;

    loaderPromise = new Promise<void>((resolve, reject) => {
        const existing = document.querySelector(`script[data-happier-monaco-loader="1"]`);
        if (existing) {
            // If require didn't materialize yet, poll briefly.
            const started = Date.now();
            const handle = window.setInterval(() => {
                if (window.require) {
                    window.clearInterval(handle);
                    resolve();
                    return;
                }
                if (Date.now() - started > 5000) {
                    window.clearInterval(handle);
                    reject(new Error('Monaco loader timed out'));
                }
            }, 50);
            return;
        }

        const script = document.createElement('script');
        script.src = MONACO_LOADER_SCRIPT_SRC;
        script.async = true;
        script.setAttribute('data-happier-monaco-loader', '1');
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Failed to load Monaco loader'));
        document.head.appendChild(script);
    });

    return loaderPromise;
}

async function ensureMonaco(): Promise<MonacoType> {
    await ensureMonacoLoader();

    if (window.monaco) return window.monaco;
    if (!window.require) throw new Error('Monaco loader did not initialize require()');

    // Configure AMD loader for the vendored static assets.
    window.require.config({ paths: { vs: '/monaco/vs' } });

    // Worker bootstrap compatible with the minified Monaco distribution.
    window.MonacoEnvironment = window.MonacoEnvironment ?? {};
    window.MonacoEnvironment.getWorkerUrl = function getWorkerUrl() {
        const bootstrap = `
          self.MonacoEnvironment = { baseUrl: '/monaco/vs' };
          importScripts('/monaco/vs/base/worker/workerMain.js');
        `;
        return `data:text/javascript;charset=utf-8,${encodeURIComponent(bootstrap)}`;
    };

    await new Promise<void>((resolve, reject) => {
        window.require(['vs/editor/editor.main'], () => resolve(), (err: any) => reject(err));
    });

    if (!window.monaco) throw new Error('Monaco loaded but window.monaco is missing');
    return window.monaco;
}

export function MonacoEditorSurface(props: CodeEditorProps) {
    const { theme } = useUnistyles();
    const containerRef = React.useRef<any>(null);
    const editorRef = React.useRef<any>(null);
    const modelRef = React.useRef<any>(null);
    const ignoreChangeRef = React.useRef(false);

    const [ready, setReady] = React.useState(false);
    const language = resolveMonacoLanguageId(props.language);
    const wrapLines = props.wrapLines ?? true;
    const showLineNumbers = props.showLineNumbers ?? true;
    const readOnly = props.readOnly ?? false;

    React.useEffect(() => {
        let cancelled = false;

        async function boot() {
            try {
                const monaco = await ensureMonaco();
                if (cancelled) return;
                const node = containerRef.current as HTMLElement | null;
                if (!node) return;

                const model = monaco.editor.createModel(props.value, language);
                modelRef.current = model;

                const editor = monaco.editor.create(node, {
                    model,
                    readOnly,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    wordWrap: wrapLines ? 'on' : 'off',
                    lineNumbers: showLineNumbers ? 'on' : 'off',
                    fontSize: 13,
                    fontFamily:
                        'Menlo, ui-monospace, SFMono-Regular, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                    tabSize: 2,
                    insertSpaces: true,
                    automaticLayout: true,
                    renderWhitespace: 'selection',
                });
                editorRef.current = editor;

                editor.onDidChangeModelContent(() => {
                    if (ignoreChangeRef.current) return;
                    const next = model.getValue();
                    props.onChange(next);
                });

                setReady(true);
            } catch {
                // Best-effort: stay on fallback surface.
                setReady(false);
            }
        }

        void boot();

        return () => {
            cancelled = true;
            try {
                editorRef.current?.dispose?.();
            } catch {}
            try {
                modelRef.current?.dispose?.();
            } catch {}
            editorRef.current = null;
            modelRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.resetKey]);

    // Keep the Monaco model in sync when props.value changes externally.
    React.useEffect(() => {
        const model = modelRef.current;
        if (!model) return;
        const current = model.getValue();
        if (current === props.value) return;
        ignoreChangeRef.current = true;
        try {
            model.setValue(props.value);
        } finally {
            ignoreChangeRef.current = false;
        }
    }, [props.value]);

    const borderStyle = {
        flex: 1,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 10,
        overflow: 'hidden' as const,
    };

    if (!ready) {
        return (
            <View style={borderStyle}>
                <TextInput
                    value={props.value}
                    onChangeText={props.onChange}
                    editable={!readOnly}
                    multiline
                    style={{
                        flex: 1,
                        padding: 10,
                        color: theme.colors.text,
                        backgroundColor: theme.colors.surfaceHighest,
                        fontFamily:
                            'Menlo, ui-monospace, SFMono-Regular, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                        fontSize: 13,
                        lineHeight: 20,
                    }}
                />
            </View>
        );
    }

    // Monaco mounts into a DOM node; RN web renders View to a div.
    return (
        <View style={borderStyle}>
            <View ref={containerRef} style={{ flex: 1 }} />
        </View>
    );
}

