import React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type { CodeEditorProps } from '../codeEditorTypes';
import { resolveMonacoLanguageId } from '../codeEditorTypes';
import type { CodeEditorFindHandle, CodeEditorFindSnapshot, CodeEditorHandle, CodeEditorHistory } from '../codeEditorTypes';
import { createMonacoCommands } from './monacoCommands';
import { createMonacoPeekZone } from './monacoPeekZone';
import type { CodeEditorFindSet } from '../bridge/codeEditorFindBridge';
import type { editor as MonacoEditorApi } from 'monaco-editor';
import { TextInput } from '@/components/ui/text/Text';
import { useLocalSetting } from '@/sync/store/settingsReadHooks';
import { CODE_EDITOR_TAB_SIZE, CODE_GUTTER_METRICS, resolveCodeEditorFontMetrics, resolveCodeEditorGutterMetrics } from '../codeEditorFontMetrics';
import { resolveCodeMonoFontFamily } from '../../codeTypography';
import { buildMonacoEditorThemeData, formatCodeEditorBlameMarkCss, formatCodeEditorChangeMarkCss, formatCodeEditorDiagnosticCss, resolveCodeEditorTheme } from '../editorTheme';

/** One shared stylesheet for every mounted Monaco editor's change marks; rewritten when the theme changes. */
const CHANGE_MARK_STYLE_ID = 'happier-editor-change-marks';
/** Per editor: how far Monaco's number box runs past the digits' right edge, and the number size. */
const LINE_NUMBER_SLACK_VAR = '--happier-line-number-slack';
const LINE_NUMBER_FONT_SIZE_VAR = '--happier-line-number-font-size';
import type { CodeEditorTheme } from '../editorTheme';
import { useGlassSurfaceColor } from '@/components/ui/glass/useGlassSurfaceColor';
import { createMonacoDecorations } from './monacoDecorations';
import type { EditorDecoration, EditorDecorationLayer } from '../codeEditorTypes';
import { useKeyboardCommand } from '@/keyboard/KeyboardShortcutProvider';


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
const configuredTypeScriptInstances = new WeakSet<object>();

function disableMonacoTypeScriptServices(monaco: Pick<typeof import('monaco-editor'), 'typescript'>): void {
    if (configuredTypeScriptInstances.has(monaco)) return;
    const off: import('monaco-editor').typescript.ModeConfiguration = {
        completionItems: false, hovers: false, documentSymbols: false, definitions: false, references: false,
        documentHighlights: false, rename: false, diagnostics: false, documentRangeFormattingEdits: false,
        signatureHelp: false, onTypeFormattingEdits: false, codeActions: false, inlayHints: false,
    };
    monaco.typescript.typescriptDefaults.setModeConfiguration(off);
    monaco.typescript.javascriptDefaults.setModeConfiguration(off);
    configuredTypeScriptInstances.add(monaco);
}

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
        disableMonacoTypeScriptServices(window.monaco);
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
    disableMonacoTypeScriptServices(window.monaco);
    return window.monaco;
}

function applyMonacoEditorTheme(monaco: MonacoType, editorTheme: CodeEditorTheme): void {
    const editorApi = monaco?.editor;
    if (!editorApi?.defineTheme || !editorApi?.setTheme) return;
    editorApi.defineTheme(editorTheme.monacoThemeName, buildMonacoEditorThemeData(editorTheme));
    editorApi.setTheme(editorTheme.monacoThemeName);
}

type MonacoEditorViewLike = Readonly<{
    executeEdits?: (
        source: string,
        edits: Array<Readonly<{ range: unknown; text: string; forceMoveMarkers: boolean }>>,
        endCursorState?: unknown,
    ) => void;
    getSelections?: () => unknown;
    setSelections?: (selections: unknown) => void;
    getScrollTop?: () => number;
    getScrollLeft?: () => number;
    setScrollTop?: (value: number) => void;
    setScrollLeft?: (value: number) => void;
}>;

type MonacoModelLike = Readonly<{
    getFullModelRange?: () => unknown;
    setValue: (value: string) => void;
}>;

function applyMonacoModelValuePreservingViewState(editor: MonacoEditorViewLike | null | undefined, model: MonacoModelLike, nextValue: string): void {
    const activeEditor = editor ?? null;
    const fullRange = typeof model.getFullModelRange === 'function' ? model.getFullModelRange() : null;
    const executeEdits = typeof activeEditor?.executeEdits === 'function' ? activeEditor.executeEdits.bind(activeEditor) : null;
    if (!activeEditor || !fullRange || !executeEdits) {
        model.setValue(nextValue);
        return;
    }

    const selections = typeof activeEditor.getSelections === 'function' ? activeEditor.getSelections() : null;
    const scrollTop = typeof activeEditor.getScrollTop === 'function' ? activeEditor.getScrollTop() : null;
    const scrollLeft = typeof activeEditor.getScrollLeft === 'function' ? activeEditor.getScrollLeft() : null;

    try {
        executeEdits(
            'happier.external-value',
            [{ range: fullRange, text: nextValue, forceMoveMarkers: true }],
            selections ?? undefined,
        );
    } catch {
        model.setValue(nextValue);
        return;
    }

    if (selections && typeof activeEditor.setSelections === 'function') {
        try {
            activeEditor.setSelections(selections);
        } catch {
            // Selection may be invalid for a shorter external document.
        }
    }

    if (typeof scrollTop === 'number' && Number.isFinite(scrollTop) && typeof activeEditor.setScrollTop === 'function') {
        try {
            activeEditor.setScrollTop(scrollTop);
        } catch {
            // ignore
        }
    }
    if (typeof scrollLeft === 'number' && Number.isFinite(scrollLeft) && typeof activeEditor.setScrollLeft === 'function') {
        try {
            activeEditor.setScrollLeft(scrollLeft);
        } catch {
            // ignore
        }
    }
}

/**
 * Monaco colours bracket pairs from its configuration, which it re-applies to every model whenever any editor
 * option changes, and it accepts that setting only under the schema's dotted key: the nested
 * `bracketPairColorization: { enabled }` option and a model-level option are both overwritten. The key is untyped in
 * Monaco's option types, hence the narrow record here.
 */
const MONACO_BRACKET_COLOURS_OFF: Readonly<Record<string, unknown>> = { 'bracketPairColorization.enabled': false };

export const MonacoEditorSurface = React.forwardRef<CodeEditorHandle, CodeEditorProps>(function MonacoEditorSurface(
    props,
    ref,
) {
    const { theme } = useUnistyles();
    const executeKeyboardCommand = useKeyboardCommand();
    const executeKeyboardCommandRef = React.useRef(executeKeyboardCommand);
    executeKeyboardCommandRef.current = executeKeyboardCommand;
    const uiFontScale = useLocalSetting('uiFontScale');
    const fontMetrics = React.useMemo(
        () => resolveCodeEditorFontMetrics({ uiFontScale }),
        [uiFontScale],
    );
    const canvas = props.presentation === 'canvas';
    // A canvas editor sits on the page's own surface (the page's colour), a framed one on the inset well.
    const backgroundColor = useGlassSurfaceColor(canvas ? theme.colors.surface.base : theme.colors.surface.inset, 'content');
    const editorTheme = React.useMemo(
        () => resolveCodeEditorTheme(theme, { backgroundColor }),
        [
            backgroundColor,
            theme.dark,
            theme.colors.accent.blue,
            theme.colors.border.default,
            theme.colors.surface.inset,
            theme.colors.surface.elevated,
            theme.colors.syntax.comment,
            theme.colors.syntax.default,
            theme.colors.syntax.function,
            theme.colors.syntax.keyword,
            theme.colors.syntax.number,
            theme.colors.syntax.string,
            theme.colors.text.primary,
            theme.colors.text.secondary,
            theme.colors.text.tertiary,
            theme.colors.diff.added.border,
        ],
    );
    // The change gutter's marks (P4-R9) are Monaco line decorations; their stroke comes from the theme owner.
    React.useEffect(() => {
        if (typeof document === 'undefined') return;
        let style = document.getElementById(CHANGE_MARK_STYLE_ID) as HTMLStyleElement | null;
        if (!style) { style = document.createElement('style'); style.id = CHANGE_MARK_STYLE_ID; document.head.appendChild(style); }
        style.textContent = [
            formatCodeEditorChangeMarkCss(editorTheme, (kind) => `.monaco-editor .cldr.happier-editor-change-${kind}`,
                // Monaco's decoration lane starts where its whole-character number box ends, a little past the
                // digits; the mark sits a fixed step after the digits themselves, clear of them and of the text.
                { inset: `calc(${CODE_GUTTER_METRICS.columnGap + 2}px - var(${LINE_NUMBER_SLACK_VAR}, 0px))` }),
            formatCodeEditorDiagnosticCss(editorTheme, (severity) => `.monaco-editor .happier-editor-diagnostic-${severity}`),
            formatCodeEditorBlameMarkCss(editorTheme, (tone) => `.monaco-editor .cldr.happier-editor-blame-${tone}`),
            // The code view's numbers (CodeGutter): the smaller number size, right edge where View draws it.
            `.monaco-editor .margin-view-overlays .line-numbers{font-size:var(${LINE_NUMBER_FONT_SIZE_VAR});padding-right:var(${LINE_NUMBER_SLACK_VAR}, 0px)}`,
        ].join('\n');
    }, [editorTheme]);
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
    // A document that is the page (canvas) with no numbers has no code gutter: its source starts on the page's
    // text edge, under the title, where its rich view starts too. A file's code keeps the code view's gutter.
    const bareCanvasRef = React.useRef(false);
    bareCanvasRef.current = canvas && (props.showLineNumbers ?? true) === false && !props.reviewLaneWidth;
    const latestFontMetricsRef = React.useRef(resolveCodeEditorFontMetrics({ uiFontScale }));
    const contentPaddingVerticalRef = React.useRef(props.contentPaddingVertical ?? 0);
    contentPaddingVerticalRef.current = props.contentPaddingVertical ?? 0;
    const gutterPropsRef = React.useRef({ lineNumberDigits: props.lineNumberDigits ?? 1, reviewLaneWidth: props.reviewLaneWidth ?? 0,
        insetLeft: props.contentPaddingHorizontal ?? 0 });
    gutterPropsRef.current = { lineNumberDigits: props.lineNumberDigits ?? 1, reviewLaneWidth: props.reviewLaneWidth ?? 0,
        insetLeft: props.contentPaddingHorizontal ?? 0 };
    const contentPaddingVertical = props.contentPaddingVertical ?? 0;
    const latestEditorThemeRef = React.useRef(editorTheme);
    const pendingChangeRef = React.useRef<Readonly<{ text: string; history?: 'undo' | 'redo' }> | null>(null);
    const changeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const disposablesRef = React.useRef<Array<{ dispose?: () => void }> | null>(null);
    const pendingFindRef = React.useRef<CodeEditorFindSet | 'open' | null>(null);
    const decorationControllerRef = React.useRef<ReturnType<typeof createMonacoDecorations> | null>(null);
    const decorationsRef = React.useRef(new Map<EditorDecorationLayer, readonly EditorDecoration[]>());
    const decorationListenersRef = React.useRef(new Set<Parameters<CodeEditorHandle['onDecorationPress']>[0]>());
    const findSnapshotRef = React.useRef<CodeEditorFindSnapshot>({
        query: '', options: { matchCase: false, regex: false }, status: { kind: 'idle' },
    });
    const findListenersRef = React.useRef(new Set<() => void>());
    const pointerListenersRef = React.useRef(new Set<Parameters<NonNullable<CodeEditorHandle['onPointerPosition']>>[0]>());
    const activationListenersRef = React.useRef(new Set<Parameters<NonNullable<CodeEditorHandle['onActivatePosition']>>[0]>());
    const composingRef = React.useRef(false);
    const commandsRef = React.useRef<ReturnType<typeof createMonacoCommands> | null>(null);
    const peekZoneRef = React.useRef<ReturnType<typeof createMonacoPeekZone> | null>(null);
    const historyListenersRef = React.useRef(new Set<(state: CodeEditorHistory) => void>());
    const publishHistory = React.useCallback(() => {
        const state = commandsRef.current?.getHistory() ?? { canUndo: false, canRedo: false };
        for (const listener of historyListenersRef.current) listener(state);
    }, []);
    const pendingRevealRef = React.useRef<null | { line: number; options?: Parameters<CodeEditorHandle['revealLine']>[1] }>(
        props.initialLine ? { line: props.initialLine, options: { behavior: 'instant' } } : null,
    );
    const onReadyRef = React.useRef(props.onReady);
    onReadyRef.current = props.onReady;
    React.useEffect(() => {
        pendingRevealRef.current = props.initialLine ? { line: props.initialLine, options: { behavior: 'instant' } } : null;
    }, [props.resetKey]);
    const revealLine = React.useCallback<CodeEditorHandle['revealLine']>((requestedLine, options) => {
        if (!commandsRef.current) { pendingRevealRef.current = { line: requestedLine, options }; return; }
        commandsRef.current.revealLine(requestedLine, options);
        pendingRevealRef.current = null;
    }, []);
    const alignGutter = React.useCallback(() => {
        const editor = editorRef.current as MonacoEditorApi.IStandaloneCodeEditor | null;
        const model = modelRef.current as MonacoEditorApi.ITextModel | null;
        let layout = editor?.getLayoutInfo?.();
        if (!editor || !model || !layout) return;
        const { lineNumberDigits, reviewLaneWidth, insetLeft } = gutterPropsRef.current;
        const showNumbers = latestShowLineNumbersRef.current;
        const digits = Math.max(lineNumberDigits, String(model.getLineCount()).length);
        const options = window.monaco?.editor?.EditorOption;
        const fontInfo = options?.fontInfo !== undefined ? editor.getOption(options.fontInfo) as { maxDigitWidth?: number } | null : null;
        const minCharsOption = options?.lineNumbersMinChars !== undefined ? editor.getOption(options.lineNumbersMinChars) : null;
        // Monaco sizes its number box in whole digits of the code font; the code view sizes it in digits of the
        // smaller number font. Both right-align the digits, so the box is made at least as wide as the code view's
        // number column and its remaining slack is padded away on the digits' right.
        const codeDigitWidth = fontInfo?.maxDigitWidth ?? layout.lineNumbersWidth / Math.max(digits, typeof minCharsOption === 'number' ? minCharsOption : digits);
        const metrics = latestFontMetricsRef.current;
        const gutter = bareCanvasRef.current ? { textOffset: 0 } : resolveCodeEditorGutterMetrics({ lineNumberDigits: digits,
            digitWidth: codeDigitWidth * metrics.lineNumberFontSize / metrics.fontSize, showLineNumbers: showNumbers, reviewLaneWidth });
        const textOffset = insetLeft + gutter.textOffset;
        const numbersEnd = textOffset - CODE_GUTTER_METRICS.numberPaddingRight;
        if (showNumbers && codeDigitWidth > 0) {
            const minChars = Math.max(digits, Math.ceil(numbersEnd / codeDigitWidth));
            if (minCharsOption !== minChars) {
                editor.updateOptions({ lineNumbersMinChars: minChars });
                layout = editor.getLayoutInfo();
            }
        }
        const node = editor.getDomNode?.();
        node?.style.setProperty(LINE_NUMBER_SLACK_VAR, `${showNumbers ? Math.max(0, layout.lineNumbersWidth - numbersEnd) : 0}px`);
        node?.style.setProperty(LINE_NUMBER_FONT_SIZE_VAR, `${metrics.lineNumberFontSize}px`);
        const widthOption = options?.lineDecorationsWidth;
        const configuredDecorationWidth = widthOption !== undefined ? editor.getOption(widthOption) : null;
        // Monaco adds its own folding-control width to the configured decoration gap.
        const controlsWidth = typeof configuredDecorationWidth === 'number' ? layout.decorationsWidth - configuredDecorationWidth : 0;
        if (layout.contentLeft !== textOffset) editor.updateOptions({ lineDecorationsWidth: textOffset - layout.lineNumbersWidth - controlsWidth });
    }, []);
    const lineDigitsRef = React.useRef(0);
    const selectionListenersRef = React.useRef(new Set<() => void>());
    const getSelection = React.useCallback<NonNullable<CodeEditorHandle['getSelection']>>(() => {
        const editor = editorRef.current as MonacoEditorApi.IStandaloneCodeEditor | null;
        const model = modelRef.current as MonacoEditorApi.ITextModel | null;
        const selection = editor?.getSelection?.();
        if (!editor || !selection || !model) return null;
        const empty = selection.startLineNumber === selection.endLineNumber && selection.startColumn === selection.endColumn;
        const position = editor.getScrolledVisiblePosition?.({ lineNumber: selection.startLineNumber, column: selection.startColumn });
        const bounds = editor.getDomNode?.()?.getBoundingClientRect();
        return {
            startLine: selection.startLineNumber,
            endLine: selection.endLineNumber > selection.startLineNumber && selection.endColumn === 1
                ? selection.endLineNumber - 1 : selection.endLineNumber,
            text: empty ? model.getLineContent(selection.startLineNumber) : model.getValueInRange(selection),
            rect: position && bounds ? { x: bounds.left + position.left, y: bounds.top + position.top, width: 0, height: position.height } : null,
            collapsed: empty,
        };
    }, []);
    const applyFind = React.useCallback((request?: CodeEditorFindSet) => {
        const editor = editorRef.current as MonacoEditorApi.IStandaloneCodeEditor | null;
        if (!editor) { pendingFindRef.current = request ?? 'open'; return; }
        pendingFindRef.current = null;
        if (!request) {
            // No arguments preserve a nonempty native query/options. actions.find would reseed
            // the editor selection, and the host's last explicit seed is not the widget's state.
            editor.trigger('happier.find', 'editor.actions.findWithArgs', undefined);
            return;
        }
        if (request.target) {
            const position = { lineNumber: request.target.line, column: request.target.column ?? 1 };
            editor.setPosition(position);
            editor.revealPositionInCenter(position);
        }
        editor.trigger('happier.find', 'editor.actions.findWithArgs', {
            searchString: request.query,
            isRegex: request.options.regex,
            isCaseSensitive: request.options.matchCase,
            matchWholeWord: false,
            findInSelection: false,
        });
    }, []);
    const find = React.useMemo<CodeEditorFindHandle>(() => {
        const editor = () => editorRef.current as MonacoEditorApi.IStandaloneCodeEditor | null;
        const widget = () => editor()?.getDomNode?.()?.querySelector<HTMLElement>('.find-widget');
        const seed: CodeEditorFindHandle['seed'] = (query, options, target) => {
            findSnapshotRef.current = { query, options, status: { kind: 'idle' } };
            applyFind({ query, options, ...(target ? { target } : {}) });
            for (const listener of findListenersRef.current) listener();
        };
        return {
            presentation: 'native', open: () => applyFind(), seed, set: (query, options) => seed(query, options),
            step: (direction) => editor()?.trigger('happier.find', direction === 1 ? 'editor.action.nextMatchFindAction' : 'editor.action.previousMatchFindAction', null),
            close: () => { pendingFindRef.current = null; editor()?.trigger('happier.find', 'closeFindWidget', null); },
            // Monaco's public API exposes actions, not its current query/options or counters.
            // This snapshot records explicit host seeds; native widget state remains engine-owned.
            getSnapshot: () => findSnapshotRef.current,
            subscribe: (listener) => { findListenersRef.current.add(listener); return () => { findListenersRef.current.delete(listener); }; },
            containsFocus: () => editor()?.hasWidgetFocus?.() === true,
            isOpen: () => widget()?.classList.contains('visible') === true,
            isInputFocused: () => Boolean(widget()?.contains(typeof document === 'undefined' ? null : document.activeElement)),
        };
    }, [applyFind]);

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
        if (next.history) onChangeRef.current(next.text, { history: next.history });
        else onChangeRef.current(next.text);
    }, []);

    const cancelPendingChange = React.useCallback(() => {
        if (changeTimerRef.current != null) {
            clearTimeout(changeTimerRef.current);
            changeTimerRef.current = null;
        }
        pendingChangeRef.current = null;
    }, []);

    const scheduleChange = React.useCallback((next: string, history?: 'undo' | 'redo') => {
        pendingChangeRef.current = { text: next, ...(history ? { history } : {}) };
        const debounceMs = changeDebounceMsRef.current;
        if (history || debounceMs <= 0) {
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
            focus: () => editorRef.current?.focus?.(),
            find,
            getSelection,
            getLineRect: (line) => {
                const editor = editorRef.current as MonacoEditorApi.IStandaloneCodeEditor | null;
                const model = modelRef.current as MonacoEditorApi.ITextModel | null;
                if (!editor || !model || line < 1 || line > model.getLineCount()) return null;
                const bounds = editor.getDomNode?.()?.getBoundingClientRect();
                const layout = editor.getLayoutInfo?.();
                if (!bounds || !layout) return null;
                // The text column of that line, in window coordinates (wrapped lines span every visual row).
                const top = editor.getTopForLineNumber(line) - editor.getScrollTop();
                const height = line < model.getLineCount()
                    ? editor.getTopForLineNumber(line + 1) - editor.getScrollTop() - top : latestFontMetricsRef.current.lineHeight;
                return { x: bounds.left + layout.contentLeft, y: bounds.top + top, width: layout.contentWidth, height };
            },
            getPositionRect: (line, character) => {
                const editor = editorRef.current as MonacoEditorApi.IStandaloneCodeEditor | null;
                const model = modelRef.current as MonacoEditorApi.ITextModel | null;
                if (!editor || !model || line < 1 || line > model.getLineCount()) return null;
                const bounds = editor.getDomNode?.()?.getBoundingClientRect();
                const column = Math.min(character + 1, model.getLineMaxColumn(line));
                const point = editor.getScrolledVisiblePosition?.({ lineNumber: line, column });
                if (!bounds || !point) return null;
                return { x: bounds.left + point.left, y: bounds.top + point.top, width: 0, height: point.height };
            },
            subscribeSelection: (listener) => {
                selectionListenersRef.current.add(listener);
                return () => { selectionListenersRef.current.delete(listener); };
            },
            setPeekZone: (zone) => peekZoneRef.current?.setPeekZone(zone),
            getPeekZoneRect: () => peekZoneRef.current?.getPeekZoneRect() ?? null,
            revealLine,
            runCommand: (command) => commandsRef.current?.runCommand(command),
            subscribeHistory: (listener) => {
                historyListenersRef.current.add(listener);
                listener(commandsRef.current?.getHistory() ?? { canUndo: false, canRedo: false });
                return () => { historyListenersRef.current.delete(listener); };
            },
            setDecorations: (layer, items) => {
                decorationsRef.current.set(layer, items);
                decorationControllerRef.current?.set(layer, items);
            },
            removeDecoration: (layer, id) => {
                const items = decorationsRef.current.get(layer);
                if (items) decorationsRef.current.set(layer, items.filter(item => item.id !== id));
                decorationControllerRef.current?.remove(layer, id);
            },
            onDecorationPress: (listener) => {
                decorationListenersRef.current.add(listener);
                return () => { decorationListenersRef.current.delete(listener); };
            },
            onPointerPosition: (listener) => {
                pointerListenersRef.current.add(listener);
                return () => { pointerListenersRef.current.delete(listener); };
            },
            onActivatePosition: (listener) => {
                activationListenersRef.current.add(listener);
                return () => { activationListenersRef.current.delete(listener); };
            },
            getCursorPosition: () => {
                const position = (editorRef.current as MonacoEditorApi.IStandaloneCodeEditor | null)?.getPosition?.();
                return position ? { line: position.lineNumber, character: position.column - 1 } : null;
            },
        }),
        [find, flushPendingChange, getSelection, publishHistory, revealLine],
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
                    hover: { enabled: false },
                    minimap: { enabled: false },
                    // No ruler marks beside the text: the cursor's tick reads as a stray dark box in a framed editor.
                    hideCursorInOverviewRuler: true,
                    overviewRulerBorder: false,
                    scrollBeyondLastLine: false,
                    wordWrap: initialWrapLines ? 'on' : 'off',
                    lineNumbers: initialShowLineNumbers ? 'on' : 'off',
                    lineNumbersMinChars: gutterPropsRef.current.lineNumberDigits,
                    glyphMargin: false,
                    // No fold lane beside a bare canvas source (it would hold the text off the page's edge).
                    folding: !bareCanvasRef.current,
                    // The code view's top and bottom inset, scrolling with the text as View's does.
                    padding: { top: contentPaddingVerticalRef.current, bottom: contentPaddingVerticalRef.current },
                    // The current line is one quiet fill across numbers and text (files lab ED1), never a box.
                    renderLineHighlight: 'all',
                    // Only the caret and the current line differ from View (files lab ED1): no indent guides the
                    // code view does not draw, and no bracket colours (see MONACO_BRACKET_COLOURS_OFF).
                    guides: { indentation: false },
                    ...MONACO_BRACKET_COLOURS_OFF,
                    // Placing the caret is not a search: no boxes on every other copy of the word under it
                    // (nor their marks in the scrollbar). Selecting text still marks its other copies.
                    occurrencesHighlight: 'off',
                    fontSize: initialFontMetrics.fontSize,
                    lineHeight: initialFontMetrics.lineHeight,
                    fontFamily: resolveCodeMonoFontFamily(),
                    tabSize: CODE_EDITOR_TAB_SIZE,
                    insertSpaces: true,
                    automaticLayout: true,
                    renderWhitespace: 'selection',
                });
                editorRef.current = editor;
                // Capture before Monaco's keybinding and modifier-click contributions see the event.
                const captureGotoKey = (event: KeyboardEvent) => {
                    if ((event.key !== 'F12' && event.key !== 'F2') || event.isComposing || composingRef.current || event.ctrlKey || event.metaKey) return;
                    // F2 is Happier's semantic rename (P7 U7), never Monaco's single-model rename.
                    if (event.key === 'F2' && (event.shiftKey || event.altKey)) return;
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    executeKeyboardCommandRef.current(event.key === 'F2' ? 'code.rename' : event.shiftKey ? 'code.findReferences' : 'code.goToDefinition');
                };
                const captureGotoClick = (event: MouseEvent) => {
                    if ((!event.metaKey && !event.ctrlKey) || event.button > 0 || composingRef.current) return;
                    const target = editor.getTargetAtClientPoint?.(event.clientX, event.clientY);
                    const position = target?.position;
                    if (!position) return;
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    for (const listener of activationListenersRef.current) listener({ line: position.lineNumber, character: position.column - 1 });
                };
                node.addEventListener('keydown', captureGotoKey, true);
                node.addEventListener('mousedown', captureGotoClick, true);
                const publishPointer = (position: { lineNumber: number; column: number } | null) => {
                    const point = position ? editor.getScrolledVisiblePosition?.(position) : null;
                    const bounds = editor.getDomNode?.()?.getBoundingClientRect();
                    const value = position && point && bounds ? { line: position.lineNumber, character: position.column - 1,
                        rect: { x: bounds.left + point.left, y: bounds.top + point.top, width: 0, height: point.height } } : null;
                    for (const listener of pointerListenersRef.current) listener(value);
                };
                alignGutter();
                commandsRef.current = createMonacoCommands(editor, model, {
                    isComposing: () => composingRef.current,
                    isReadOnly: () => latestReadOnlyRef.current,
                    openFind: () => find.open(),
                    navigateChange: (direction) => decorationControllerRef.current?.navigate(direction),
                    onHistory: publishHistory,
                });
                if (pendingRevealRef.current) revealLine(pendingRevealRef.current.line, pendingRevealRef.current.options);
                peekZoneRef.current = createMonacoPeekZone(editor, () => {
                    for (const listener of selectionListenersRef.current) listener();
                });
                if (editor.createDecorationsCollection && editor.onMouseDown) {
                    const controller = createMonacoDecorations(editor, monaco, (layer, item) => {
                        for (const listener of decorationListenersRef.current) listener(layer, item);
                    });
                    decorationControllerRef.current = controller;
                    for (const [layer, items] of decorationsRef.current) controller.set(layer, items);
                }
                if (pendingFindRef.current) applyFind(pendingFindRef.current === 'open' ? undefined : pendingFindRef.current);

                disposablesRef.current = [
                    { dispose: () => {
                        node.removeEventListener('keydown', captureGotoKey, true);
                        node.removeEventListener('mousedown', captureGotoClick, true);
                    } },
                    editor.onMouseMove?.((event: MonacoEditorApi.IEditorMouseEvent) => publishPointer(event.target.position)),
                    editor.onMouseLeave?.(() => publishPointer(null)),
                    editor.onDidLayoutChange?.(alignGutter),
                    editor.onDidCompositionStart?.(() => { composingRef.current = true; }),
                    editor.onDidCompositionEnd?.(() => { composingRef.current = false; }),
                    editor.onDidChangeCursorSelection?.(() => {
                        for (const listener of selectionListenersRef.current) listener();
                    }),
                    // A scroll moves every anchored surface (selection toolbar, change peek), as CodeMirror's
                    // bridge reports on its viewport changes.
                    editor.onDidScrollChange?.(() => {
                        for (const listener of selectionListenersRef.current) listener();
                    }),
                    editor.onDidChangeModelContent((event: MonacoEditorApi.IModelContentChangedEvent) => {
                        const lineDigits = String(model.getLineCount()).length;
                        if (lineDigits !== lineDigitsRef.current) { lineDigitsRef.current = lineDigits; alignGutter(); }
                        publishHistory();
                        for (const listener of selectionListenersRef.current) listener();
                        if (ignoreChangeRef.current) return;
                        const next = model.getValue();
                        scheduleChange(next, event.isUndoing ? 'undo' : event.isRedoing ? 'redo' : undefined);
                    }),
                    editor.onDidBlurEditorText(() => {
                        flushPendingChange();
                    }),
                ];

                for (const listener of selectionListenersRef.current) listener();

                editor.render?.(true);
                setReady(true);
                publishHistory();
                onReadyRef.current?.();
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
                decorationControllerRef.current?.dispose();
                decorationControllerRef.current = null;
                peekZoneRef.current?.dispose();
                peekZoneRef.current = null;
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
            commandsRef.current = null;
            for (const listener of pointerListenersRef.current) listener(null);
            composingRef.current = false;
            publishHistory();
            for (const listener of selectionListenersRef.current) listener();
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
                padding: { top: contentPaddingVertical, bottom: contentPaddingVertical },
            });
            alignGutter();
        } catch {
            // ignore
        }
    }, [alignGutter, contentPaddingVertical, fontMetrics.fontSize, fontMetrics.lineHeight, readOnly, showLineNumbers, wrapLines,
        props.lineNumberDigits, props.reviewLaneWidth, props.contentPaddingHorizontal]);

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
        if (current === props.value) {
            // Editor and parent agree; any still-pending change is a settled echo.
            cancelPendingChange();
            return;
        }
        if (pendingChangeRef.current != null || changeTimerRef.current != null) {
            // The user has unflushed local edits: the incoming value is stale relative
            // to the editor (a debounce-window echo or a racing async write-back).
            // Replacing the document here would reset the cursor and lose keystrokes.
            // Local text wins; flush it upward so the parent state converges instead.
            flushPendingChange();
            return;
        }
        ignoreChangeRef.current = true;
        try {
            applyMonacoModelValuePreservingViewState(editorRef.current, model, props.value);
        } finally {
            ignoreChangeRef.current = false;
        }
    }, [cancelPendingChange, flushPendingChange, props.value]);

    const borderStyle = {
        flex: 1,
        borderWidth: canvas ? 0 : 1,
        borderColor: editorTheme.dividerColor,
        borderRadius: canvas ? 0 : 10,
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
                            fontFamily: resolveCodeMonoFontFamily(),
                            fontSize: fontMetrics.fontSize,
                            lineHeight: fontMetrics.lineHeight,
                        }}
                    />
                </View>
            )}
        </View>
    );
});
