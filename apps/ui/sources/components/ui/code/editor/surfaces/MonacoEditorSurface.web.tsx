import React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type { CodeEditorProps } from '../codeEditorTypes';
import { resolveMonacoLanguageId } from '../codeEditorTypes';
import type { CodeEditorHandle } from '../codeEditorTypes';
import { TextInput } from '@/components/ui/text/Text';
import { useLocalSetting } from '@/sync/store/hooks';
import { resolveCodeEditorFontMetrics } from '../codeEditorFontMetrics';
import { buildMonacoEditorThemeData, resolveCodeEditorTheme } from '../editorTheme';
import type { CodeEditorTheme } from '../editorTheme';


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
let basicLanguagesPromise: Promise<void> | null = null;

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

async function ensureMonacoBasicLanguages(): Promise<void> {
    if (typeof window === 'undefined') return;
    if (!window.require) return;
    if (basicLanguagesPromise) return await basicLanguagesPromise;

    basicLanguagesPromise = new Promise<void>((resolve) => {
        try {
            window.require(
                ['vs/basic-languages/monaco.contribution'],
                () => resolve(),
                () => resolve(),
            );
        } catch {
            resolve();
        }
    });

    return await basicLanguagesPromise;
}

async function ensureMonaco(): Promise<MonacoType> {
    await ensureMonacoLoader();

    if (window.monaco) {
        // Best-effort: register Monaco basic languages (markdown, yaml, python, etc.).
        await ensureMonacoBasicLanguages();
        return window.monaco;
    }
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

    // Register basic languages before we create models so syntax highlighting is available for common file types.
    await ensureMonacoBasicLanguages();

    if (!window.monaco) throw new Error('Monaco loaded but window.monaco is missing');
    return window.monaco;
}

function applyMonacoEditorTheme(monaco: MonacoType, editorTheme: CodeEditorTheme): void {
    const editorApi = monaco?.editor;
    if (!editorApi?.defineTheme || !editorApi?.setTheme) return;
    editorApi.defineTheme(editorTheme.monacoThemeName, buildMonacoEditorThemeData(editorTheme));
    editorApi.setTheme(editorTheme.monacoThemeName);
}

export const MonacoEditorSurface = React.forwardRef<CodeEditorHandle, CodeEditorProps>(function MonacoEditorSurface(
    props,
    ref,
) {
    const { theme } = useUnistyles();
    const uiFontScale = useLocalSetting('uiFontScale');
    const fontMetrics = React.useMemo(
        () => resolveCodeEditorFontMetrics({ uiFontScale }),
        [uiFontScale],
    );
    const editorTheme = React.useMemo(
        () => resolveCodeEditorTheme(theme),
        [
            theme.dark,
            theme.colors.accent.blue,
            theme.colors.divider,
            theme.colors.surfaceHigh,
            theme.colors.surfaceHighest,
            theme.colors.syntaxComment,
            theme.colors.syntaxDefault,
            theme.colors.syntaxFunction,
            theme.colors.syntaxKeyword,
            theme.colors.syntaxNumber,
            theme.colors.syntaxString,
            theme.colors.text,
            theme.colors.textTertiary,
        ],
    );
    const containerRef = React.useRef<any>(null);
    const editorRef = React.useRef<any>(null);
    const modelRef = React.useRef<any>(null);
    const changeDebounceMsRef = React.useRef<number>(typeof props.changeDebounceMs === 'number' ? props.changeDebounceMs : 250);
    const onChangeRef = React.useRef(props.onChange);
    const ignoreChangeRef = React.useRef(false);
    const latestValueRef = React.useRef(props.value);
    const latestLanguageRef = React.useRef(resolveMonacoLanguageId(props.language));
    const latestReadOnlyRef = React.useRef(props.readOnly ?? false);
    const latestWrapLinesRef = React.useRef(props.wrapLines ?? true);
    const latestShowLineNumbersRef = React.useRef(props.showLineNumbers ?? true);
    const latestFontMetricsRef = React.useRef(resolveCodeEditorFontMetrics({ uiFontScale }));
    const latestEditorThemeRef = React.useRef(editorTheme);
    const pendingChangeRef = React.useRef<string | null>(null);
    const changeTimerRef = React.useRef<number | null>(null);
    const disposablesRef = React.useRef<Array<{ dispose?: () => void }> | null>(null);

    React.useEffect(() => {
        changeDebounceMsRef.current = typeof props.changeDebounceMs === 'number' ? props.changeDebounceMs : 250;
    }, [props.changeDebounceMs]);

    React.useEffect(() => {
        onChangeRef.current = props.onChange;
    }, [props.onChange]);

    React.useEffect(() => {
        latestValueRef.current = props.value;
    }, [props.value]);

    const [ready, setReady] = React.useState(false);
    const language = resolveMonacoLanguageId(props.language);
    const wrapLines = props.wrapLines ?? true;
    const showLineNumbers = props.showLineNumbers ?? true;
    const readOnly = props.readOnly ?? false;

    React.useEffect(() => {
        latestLanguageRef.current = language;
    }, [language]);

    React.useEffect(() => {
        latestReadOnlyRef.current = readOnly;
    }, [readOnly]);

    React.useEffect(() => {
        latestWrapLinesRef.current = wrapLines;
    }, [wrapLines]);

    React.useEffect(() => {
        latestShowLineNumbersRef.current = showLineNumbers;
    }, [showLineNumbers]);

    React.useEffect(() => {
        latestFontMetricsRef.current = fontMetrics;
    }, [fontMetrics]);

    React.useEffect(() => {
        latestEditorThemeRef.current = editorTheme;
        const monaco = window.monaco;
        if (!editorRef.current || !monaco) return;
        try {
            applyMonacoEditorTheme(monaco, editorTheme);
        } catch {
            // ignore
        }
    }, [editorTheme]);

    const flushPendingChange = React.useCallback(() => {
        if (changeTimerRef.current != null) {
            clearTimeout(changeTimerRef.current);
            changeTimerRef.current = null;
        }
        if (pendingChangeRef.current == null) return;
        const next = pendingChangeRef.current;
        pendingChangeRef.current = null;
        onChangeRef.current(next);
    }, []);

    const scheduleChange = React.useCallback((next: string) => {
        pendingChangeRef.current = next;
        const debounceMs = changeDebounceMsRef.current;
        if (debounceMs <= 0) {
            flushPendingChange();
            return;
        }
        if (changeTimerRef.current != null) {
            clearTimeout(changeTimerRef.current);
        }
        changeTimerRef.current = setTimeout(() => {
            flushPendingChange();
        }, debounceMs);
    }, [flushPendingChange]);

    React.useImperativeHandle(
        ref,
        () => ({
            getValue: () => {
                try {
                    return modelRef.current?.getValue?.() ?? latestValueRef.current;
                } catch {
                    return latestValueRef.current;
                }
            },
            flushPendingChange: async () => {
                flushPendingChange();
            },
        }),
        [flushPendingChange],
    );

    React.useEffect(() => {
        let cancelled = false;

        async function boot() {
            try {
                const monaco = await ensureMonaco();
                if (cancelled) return;
                const node = containerRef.current as HTMLElement | null;
                if (!node) return;

                const initialFontMetrics = latestFontMetricsRef.current;
                const initialWrapLines = latestWrapLinesRef.current;
                const initialShowLineNumbers = latestShowLineNumbersRef.current;
                const initialReadOnly = latestReadOnlyRef.current;
                const initialLanguage = latestLanguageRef.current;
                const initialEditorTheme = latestEditorThemeRef.current;

                const model = monaco.editor.createModel(latestValueRef.current, initialLanguage);
                modelRef.current = model;
                applyMonacoEditorTheme(monaco, initialEditorTheme);

                const editor = monaco.editor.create(node, {
                    model,
                    theme: initialEditorTheme.monacoThemeName,
                    readOnly: initialReadOnly,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    wordWrap: initialWrapLines ? 'on' : 'off',
                    lineNumbers: initialShowLineNumbers ? 'on' : 'off',
                    fontSize: initialFontMetrics.fontSize,
                    lineHeight: initialFontMetrics.lineHeight,
                    fontFamily:
                        'Menlo, ui-monospace, SFMono-Regular, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                    tabSize: 2,
                    insertSpaces: true,
                    automaticLayout: true,
                    renderWhitespace: 'selection',
                });
                editorRef.current = editor;

                disposablesRef.current = [
                    editor.onDidChangeModelContent(() => {
                    if (ignoreChangeRef.current) return;
                    const next = model.getValue();
                    scheduleChange(next);
                    }),
                    editor.onDidBlurEditorText(() => {
                        flushPendingChange();
                    }),
                ];

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
                flushPendingChange();
            } catch {}
            try {
                disposablesRef.current?.forEach((item) => item?.dispose?.());
            } catch {}
            try {
                editorRef.current?.dispose?.();
            } catch {}
            try {
                modelRef.current?.dispose?.();
            } catch {}
            try {
                if (changeTimerRef.current != null) {
                    clearTimeout(changeTimerRef.current);
                    changeTimerRef.current = null;
                }
            } catch {}
            disposablesRef.current = null;
            editorRef.current = null;
            modelRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.resetKey]);

    React.useEffect(() => {
        const editor = editorRef.current;
        if (!editor?.updateOptions) return;
        try {
            editor.updateOptions({
                fontSize: fontMetrics.fontSize,
                lineHeight: fontMetrics.lineHeight,
                readOnly,
                wordWrap: wrapLines ? 'on' : 'off',
                lineNumbers: showLineNumbers ? 'on' : 'off',
            });
        } catch {
            // ignore
        }
    }, [fontMetrics.fontSize, fontMetrics.lineHeight, readOnly, showLineNumbers, wrapLines]);

    React.useEffect(() => {
        const model = modelRef.current;
        const monaco = window.monaco;
        if (!model || !monaco?.editor?.setModelLanguage) return;
        try {
            monaco.editor.setModelLanguage(model, language);
        } catch {
            // ignore
        }
    }, [language]);

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
        borderColor: editorTheme.dividerColor,
        borderRadius: 10,
        overflow: 'hidden' as const,
        backgroundColor: editorTheme.backgroundColor,
    };

    // Monaco mounts into a DOM node; RN web renders View to a div. The container must be rendered
    // even while Monaco is loading, otherwise `containerRef.current` never materializes and Monaco
    // cannot boot (leaving the editor stuck on the fallback textarea).
    return (
        <View style={borderStyle}>
            <View testID={props.testID} ref={containerRef} style={{ flex: 1, backgroundColor: editorTheme.backgroundColor }} />
            {ready ? null : (
                <View style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}>
                    <TextInput
                        value={props.value}
                        onChangeText={props.onChange}
                        editable={!readOnly}
                        multiline
                        disableUiFontScaling
                        style={{
                            flex: 1,
                            padding: 10,
                            color: editorTheme.syntax.defaultColor,
                            backgroundColor: editorTheme.backgroundColor,
                            fontFamily:
                                'Menlo, ui-monospace, SFMono-Regular, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                            fontSize: fontMetrics.fontSize,
                            lineHeight: fontMetrics.lineHeight,
                        }}
                    />
                </View>
            )}
        </View>
    );
});
