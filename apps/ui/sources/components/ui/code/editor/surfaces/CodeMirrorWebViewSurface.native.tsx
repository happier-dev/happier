import React from 'react';
import { PixelRatio, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { useUnistyles } from 'react-native-unistyles';

import { useLocalSetting } from '@/sync/store/settingsReadHooks';
import type { CodeEditorCommand, CodeEditorDocumentChange, CodeEditorFindHandle, CodeEditorFindSnapshot, CodeEditorHandle, CodeEditorProps, CodeEditorHistory, EditorDecoration, EditorDecorationLayer } from '../codeEditorTypes';
import { encodeChunkedEnvelope, decodeChunkedEnvelope } from '@/components/ui/webview/bridge/chunkedBridge';
import { buildCodeMirrorWebViewHtml } from '../bridge/codemirrorWebViewHtml';
import { resolveCodeMirrorWebViewLanguageSpec } from '../bridge/resolveCodeMirrorWebViewLanguageSpec';
import { resolveCodeEditorTheme } from '../editorTheme';
import { readCodeMirrorFindStatus } from '../bridge/codeEditorFindBridge';
import type { CodeEditorFindMessage, CodeEditorFindSet } from '../bridge/codeEditorFindBridge';
import { useEmbeddedEditorKeyboard } from '@/keyboard/KeyboardShortcutProvider';
import { resolveCodeMonoFontFamily } from '../../codeTypography';
import type { CodeEditorLanguageIntelligence } from '../codeEditorTypes';
import { DaemonLspQueryRequestSchema, LanguageIntelligenceSignatureHelpSchema, type LanguageIntelligenceSignatureHelp } from '@happier-dev/protocol/machines/languageIntelligence';
import type { CodeEditorInlineContext, CodeEditorInlineEvent, CodeEditorInlineSuggestion, CodeEditorInlineSuggestions } from '../codeEditorTypes';
import type { CodeMirrorNextEditProjection } from '../bridge/codeMirrorInlineSuggestions';
import type { CodeNextEditAdapter } from '@/sync/domains/workspaces/languageIntelligence/codeNextEditSuggestions';
import { t } from '@/text';

function readInlineContext(value: unknown): CodeEditorInlineContext | null {
    if (!value || typeof value !== 'object') return null;
    const context = value as Record<string, unknown>;
    for (const key of ['line', 'character', 'offset', 'version', 'selectionCount']) if (typeof context[key] !== 'number' || !Number.isInteger(context[key]) || context[key] < 0) return null;
    for (const key of ['hasSelection', 'composing', 'suggestWidgetOpen']) if (typeof context[key] !== 'boolean') return null;
    if (context.eol !== undefined && context.eol !== '\n' && context.eol !== '\r\n' && context.eol !== '\r') return null;
    if (Number(context.line) < 1 || Number(context.selectionCount) < 1) return null;
    return context as CodeEditorInlineContext;
}

function createMessageId(): string {
    return Math.random().toString(36).slice(2);
}

function readEditorPosition(payload: unknown) {
    if (!payload || typeof payload !== 'object' || !('line' in payload) || !('character' in payload)) return null;
    const { line, character } = payload;
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1
        || typeof character !== 'number' || !Number.isInteger(character) || character < 0) return null;
    return { line, character };
}

export const CodeMirrorWebViewSurface = React.forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeMirrorWebViewSurface(
    props,
    ref,
) {
    const { theme } = useUnistyles();
    const keyboard = useEmbeddedEditorKeyboard();
    const keyboardRef = React.useRef(keyboard);
    keyboardRef.current = keyboard;
    const uiFontScale = useLocalSetting('uiFontScale');
    const canvas = props.presentation === 'canvas';
    const editorTheme = React.useMemo(
        // A canvas editor sits on the page's own surface, a framed one on the inset well.
        () => resolveCodeEditorTheme(theme, canvas ? { backgroundColor: theme.colors.surface.base } : {}),
        [
            canvas,
            theme.colors.surface.base,
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
            theme.colors.text.tertiary,
            theme.colors.find.matchAll,
            theme.colors.find.matchCurrent,
            theme.colors.find.matchCurrentForeground,
        ],
    );
    const webViewRef = React.useRef<WebView>(null);
    const readyRef = React.useRef(false);
    const intelligenceRef = React.useRef<CodeEditorLanguageIntelligence | null>(null);
    const intelligenceSubscriptionRef = React.useRef<(() => void) | null>(null);
    const nextEditSubscriptionRef = React.useRef<(() => void) | null>(null);
    const intelligenceRequestsRef = React.useRef(new Map<string, AbortController>());
    const formatRequestsRef = React.useRef(new Map<string, () => void>());
    const nextEditApplyRef = React.useRef<null | { requestId: string; resolve(applied: boolean): void }>(null);
    const settleNextEditApply = React.useCallback((applied: boolean) => {
        const pending = nextEditApplyRef.current;
        nextEditApplyRef.current = null;
        pending?.resolve(applied);
    }, []);
    const signatureRef = React.useRef<LanguageIntelligenceSignatureHelp | null>(null);
    const signatureListenersRef = React.useRef(new Set<() => void>());
    const pendingInitRef = React.useRef<null | { doc: string }>(null);
    const lastDocRef = React.useRef(props.value);
    const propsRef = React.useRef(props);
    propsRef.current = props;
    const historyCommandRef = React.useRef<Promise<void> | null>(null);
    const pendingDocRequestRef = React.useRef(new Map<string, { resolve: (confirmed: boolean) => void; timeoutId: ReturnType<typeof setTimeout>; change?: CodeEditorDocumentChange }>());
    const latestLanguageRef = React.useRef(props.language);
    const latestReadOnlyRef = React.useRef(false);
    const gutterPropsRef = React.useRef({ lineNumberDigits: props.lineNumberDigits ?? 1, reviewLaneWidth: props.reviewLaneWidth ?? 0 });
    gutterPropsRef.current = { lineNumberDigits: props.lineNumberDigits ?? 1, reviewLaneWidth: props.reviewLaneWidth ?? 0 };
    const focusedRef = React.useRef(false);
    const findOpenRef = React.useRef(false);
    const findRequestRef = React.useRef<CodeEditorFindSet | null>(null);
    const findSnapshotRef = React.useRef<CodeEditorFindSnapshot>({
        query: '', options: { matchCase: false, regex: false }, status: { kind: 'idle' },
    });
    const findListenersRef = React.useRef(new Set<() => void>());
    const cursorRef = React.useRef<ReturnType<NonNullable<CodeEditorHandle['getCursorPosition']>>>(null);
    const pointerListenersRef = React.useRef(new Set<Parameters<NonNullable<CodeEditorHandle['onPointerPosition']>>[0]>());
    const activationListenersRef = React.useRef(new Set<Parameters<NonNullable<CodeEditorHandle['onActivatePosition']>>[0]>());
    const inlineContextRef = React.useRef<CodeEditorInlineContext | null>(null);
    const inlineSuggestionRef = React.useRef<CodeEditorInlineSuggestion | null>(null);
    const inlineListenersRef = React.useRef(new Set<() => void>());
    const inlineEventsRef = React.useRef(new Set<(event: CodeEditorInlineEvent) => void>());
    const inlineGuardRef = React.useRef<((id: string) => boolean) | null>(null);
    const historyRef = React.useRef<CodeEditorHistory>({ canUndo: false, canRedo: false });
    const historyListenersRef = React.useRef(new Set<(state: CodeEditorHistory) => void>());
    const pendingRevealRef = React.useRef<null | { line: number; focus?: boolean; select?: boolean; behavior?: 'smooth' | 'instant' }>(
        props.initialLine ? { line: props.initialLine, behavior: 'instant' } : null,
    );
    const onReadyRef = React.useRef(props.onReady);
    onReadyRef.current = props.onReady;
    React.useEffect(() => {
        lastDocRef.current = props.value;
        historyCommandRef.current = null;
        pendingInitRef.current = { doc: props.value };
        pendingRevealRef.current = props.initialLine ? { line: props.initialLine, behavior: 'instant' } : null;
        historyRef.current = { canUndo: false, canRedo: false };
        for (const listener of historyListenersRef.current) listener(historyRef.current);
        geometryRef.current.clear();
        geometryWatchRef.current.clear();
    }, [props.resetKey]);
    const decorationsRef = React.useRef(new Map<EditorDecorationLayer, readonly EditorDecoration[]>());
    const decorationListenersRef = React.useRef(new Set<Parameters<CodeEditorHandle['onDecorationPress']>[0]>());
    const selectionRef = React.useRef<ReturnType<NonNullable<CodeEditorHandle['getSelection']>>>(null);
    const selectionListenersRef = React.useRef(new Set<() => void>());
    const publishSelection = React.useCallback((selection: typeof selectionRef.current) => {
        selectionRef.current = selection;
        for (const listener of selectionListenersRef.current) listener();
    }, []);
    // Geometry the host draws over (Track's caret and wash): asked of the WebView once per line/position and
    // answered again as the text moves. Rects arrive in the WebView's coordinates; the container adds its origin.
    type GeometryRect = NonNullable<ReturnType<NonNullable<CodeEditorHandle['getLineRect']>>>;
    const containerRef = React.useRef<View | null>(null);
    const originRef = React.useRef({ x: 0, y: 0 });
    const geometryRef = React.useRef(new Map<string, GeometryRect | null>());
    const geometryWatchRef = React.useRef(new Map<string, { line: number; character: number | null }>());

    const wrapLines = props.wrapLines ?? true;
    const showLineNumbers = props.showLineNumbers ?? true;
    const readOnly = props.readOnly ?? false;
    const changeDebounceMs = typeof props.changeDebounceMs === 'number' ? props.changeDebounceMs : 250;
    const maxChunkBytes = typeof props.bridgeMaxChunkBytes === 'number' ? props.bridgeMaxChunkBytes : 64_000;

    latestLanguageRef.current = props.language;
    latestReadOnlyRef.current = readOnly;

    const html = React.useMemo(
        () =>
            buildCodeMirrorWebViewHtml({
                theme: editorTheme,
                wrapLines,
                showLineNumbers,
                changeDebounceMs,
                maxChunkBytes,
                uiFontScale,
                osFontScale: typeof PixelRatio.getFontScale === 'function' ? PixelRatio.getFontScale() : 1,
                fontFamily: resolveCodeMonoFontFamily(),
                contentPaddingHorizontal: props.contentPaddingHorizontal,
                contentPaddingVertical: props.contentPaddingVertical,
            }),
        [
            changeDebounceMs,
            props.contentPaddingHorizontal,
            props.contentPaddingVertical,
            editorTheme,
            maxChunkBytes,
            showLineNumbers,
            uiFontScale,
            wrapLines,
        ],
    );

    const postEnvelope = React.useCallback(
        (envelope: { v: 1; type: string; payload: unknown }) => {
            const messages = encodeChunkedEnvelope({ envelope, maxChunkBytes, messageId: createMessageId() });
            for (const msg of messages) {
                webViewRef.current?.postMessage(JSON.stringify(msg));
            }
        },
        [maxChunkBytes],
    );
    const inlineSuggestions = React.useMemo<CodeEditorInlineSuggestions>(() => ({
        set: suggestion => { if (readyRef.current) postEnvelope({ v: 1, type: 'inline.set', payload: suggestion }); },
        getContext: () => inlineContextRef.current,
        getSuggestion: () => inlineSuggestionRef.current,
        subscribeContext: listener => { inlineListenersRef.current.add(listener); return () => { inlineListenersRef.current.delete(listener); }; },
        onEvent: listener => { inlineEventsRef.current.add(listener); return () => { inlineEventsRef.current.delete(listener); }; },
        setAcceptGuard: guard => { inlineGuardRef.current = guard; },
    }), [postEnvelope]);
    React.useEffect(() => {
        if (readyRef.current) postEnvelope({ v: 1, type: 'keyboard.config', payload: { signatures: keyboard.signatures } });
    }, [keyboard.signatures, postEnvelope]);

    const postIntelligence = React.useCallback(() => {
        const port = intelligenceRef.current;
        const completionSource = propsRef.current.completionSource;
        if (readyRef.current) postEnvelope({ v: 1, type: 'intelligence.configure', payload: port || completionSource ? {
            ...(port ? { path: port.path, inlayHints: port.inlayHints, semanticHighlighting: port.semanticHighlighting, capabilities: port.getSnapshot().capabilities } : {}),
            ...(completionSource ? { completion: { triggerCharacters: completionSource.triggerCharacters } } : {}),
        } : null });
    }, [postEnvelope]);
    React.useEffect(() => { postIntelligence(); }, [props.completionSource, postIntelligence]);
    /** The shared next-edit snapshot, drawn by the WebView; hint words come from the host's locale. */
    const postNextEdit = React.useCallback(() => {
        if (!readyRef.current) return;
        const snapshot = intelligenceRef.current?.nextEditSuggestions?.getSnapshot();
        const suggestion = snapshot?.suggestion;
        const first = suggestion?.edits[0];
        let payload: CodeMirrorNextEditProjection | null = snapshot?.status === 'requesting' ? { status: 'requesting' } : null;
        if (suggestion && first && (snapshot.status === 'ready' || snapshot.status === 'preview')) {
            const line = first.range.start.line + 1;
            // Without keys (phone) the key row carries Go/Apply/Dismiss; the ready label stays as a tappable place name.
            const keys = intelligenceRef.current?.nextEditKeys !== false;
            const place = { text: inlineContextRef.current?.line === line ? t('files.editing.aiSuggestions.nextEditHere') : t('files.editing.aiSuggestions.nextEditAt', { line }) };
            const hint = snapshot.status === 'preview'
                ? keys ? [{ key: true, text: 'Tab' }, { text: t('files.editing.aiSuggestions.nextEditApply') }, { key: true, text: 'Esc' }, { text: t('files.editing.aiSuggestions.nextEditDismiss') }] : []
                : keys ? [{ key: true, text: 'Tab' }, place] : [place];
            payload = { id: suggestion.id, status: snapshot.status, hint,
                edits: suggestion.edits.map(edit => ({ start: edit.range.start, end: edit.range.end, oldText: edit.oldText, newText: edit.newText })) };
        }
        postEnvelope({ v: 1, type: 'nextEdit.set', payload });
    }, [postEnvelope]);
    const nextEditAdapter = React.useMemo<CodeNextEditAdapter>(() => ({
        jump: position => { postEnvelope({ v: 1, type: 'nextEdit.jump', payload: position }); },
        apply: (_edits, captured) => {
            // The WebView re-checks its own buffer against the drawn preview before its one transaction.
            const id = intelligenceRef.current?.nextEditSuggestions?.getSnapshot().suggestion?.id;
            if (!readyRef.current || !id || nextEditApplyRef.current || lastDocRef.current !== captured.text || inlineContextRef.current?.version !== captured.version) return false;
            const requestId = createMessageId();
            return new Promise<boolean>(resolve => {
                nextEditApplyRef.current = { requestId, resolve };
                postEnvelope({ v: 1, type: 'nextEdit.apply', payload: { id, requestId } });
            });
        },
    }), [postEnvelope]);
    const setLanguageIntelligence = React.useCallback((port: CodeEditorLanguageIntelligence | null) => {
        settleNextEditApply(false);
        intelligenceSubscriptionRef.current?.(); intelligenceSubscriptionRef.current = null;
        nextEditSubscriptionRef.current?.(); nextEditSubscriptionRef.current = null;
        for (const request of intelligenceRequestsRef.current.values()) request.abort(); intelligenceRequestsRef.current.clear();
        intelligenceRef.current = port;
        let capabilities = port?.getSnapshot().capabilities;
        if (port) intelligenceSubscriptionRef.current = port.subscribe(() => {
            const next = port.getSnapshot().capabilities;
            if (next !== capabilities) { capabilities = next; postIntelligence(); }
        });
        if (port?.nextEditSuggestions) nextEditSubscriptionRef.current = port.nextEditSuggestions.subscribe(postNextEdit);
        postIntelligence();
        postNextEdit();
    }, [postIntelligence, postNextEdit, settleNextEditApply]);

    const publishFind = React.useCallback((snapshot: CodeEditorFindSnapshot) => {
        findSnapshotRef.current = snapshot;
        for (const listener of findListenersRef.current) listener();
    }, []);
    const postFind = React.useCallback((message: CodeEditorFindMessage) => postEnvelope(message), [postEnvelope]);
    const seedFind = React.useCallback<CodeEditorFindHandle['seed']>((query, options, target) => {
        const request: CodeEditorFindSet = { query, options, ...(target ? { target } : {}) };
        findOpenRef.current = true;
        findRequestRef.current = request;
        publishFind({ query, options, status: query ? { kind: 'searching', total: 0 } : { kind: 'idle' } });
        if (readyRef.current) postFind({ v: 1, type: 'find.set', payload: request });
    }, [postFind, publishFind]);
    const find = React.useMemo<CodeEditorFindHandle>(() => ({
        presentation: 'shared',
        open: () => {
            if (!findOpenRef.current) {
                const { query, options } = findSnapshotRef.current;
                seedFind(query, options);
            }
        },
        seed: seedFind,
        set: (query, options) => seedFind(query, options),
        step: (direction) => { if (readyRef.current && findOpenRef.current) postFind({ v: 1, type: 'find.step', payload: { direction } }); },
        close: () => {
            findOpenRef.current = false;
            findRequestRef.current = null;
            publishFind({ ...findSnapshotRef.current, status: { kind: 'idle' } });
            if (readyRef.current) postFind({ v: 1, type: 'find.close', payload: {} });
        },
        getSnapshot: () => findSnapshotRef.current,
        subscribe: (listener) => { findListenersRef.current.add(listener); return () => { findListenersRef.current.delete(listener); }; },
        containsFocus: () => focusedRef.current,
        isOpen: () => findOpenRef.current,
        isInputFocused: () => false, // The host's shared FindBar owns its input focus.
    }), [postFind, publishFind, seedFind]);

    const requestDocumentSnapshot = React.useCallback(async (change?: CodeEditorDocumentChange): Promise<void> => {
        if (!readyRef.current) throw new Error('editor_document_snapshot_unconfirmed');
        const requestId = createMessageId();
        const confirmed = await new Promise<boolean>((resolve) => {
            const timeoutId = setTimeout(() => {
                pendingDocRequestRef.current.delete(requestId);
                resolve(false);
            }, 1500);
            pendingDocRequestRef.current.set(requestId, { resolve, timeoutId, change });
            postEnvelope({
                v: 1,
                type: 'requestDoc',
                payload: { requestId },
            });
        });
        if (!confirmed) throw new Error('editor_document_snapshot_unconfirmed');
    }, [postEnvelope]);
    const flushPendingChange = React.useCallback(async (): Promise<void> => {
        const command = historyCommandRef.current;
        if (command) {
            try { await command; }
            catch (error) {
                if (historyCommandRef.current === command) historyCommandRef.current = null;
                throw error;
            }
        }
        await requestDocumentSnapshot();
    }, [requestDocumentSnapshot]);

    const runCommand = React.useCallback((command: CodeEditorCommand) => {
        if ((command === 'undo' || command === 'redo' || typeof command === 'object') && propsRef.current.history) {
            // Commands cross an asynchronous bridge; preserve consecutive Undo key presses in order.
            const pending = (historyCommandRef.current ?? Promise.resolve()).catch(() => {}).then(async () => {
                const history = propsRef.current.history;
                if (!history || propsRef.current.readOnly) return;
                await requestDocumentSnapshot();
                if (history !== propsRef.current.history || !readyRef.current) return;
                if (typeof command === 'object') {
                    postEnvelope({ v: 1, type: 'command', payload: { command } });
                    await requestDocumentSnapshot('replaceDocument' in command && command.history ? { history: command.history } : undefined);
                    return;
                }
                const next = history[command](lastDocRef.current);
                if (next === null) return;
                lastDocRef.current = next;
                if (readyRef.current) postEnvelope({ v: 1, type: 'command', payload: { command: { replaceDocument: next, history: command } } });
                propsRef.current.onChange(next, { history: command });
            });
            historyCommandRef.current = pending;
            // Keep the failure for the public flush without leaking a void command's rejection.
            void pending.catch(() => {});
            return;
        }
        if (readyRef.current) postEnvelope({ v: 1, type: 'command', payload: { command } });
    }, [requestDocumentSnapshot, postEnvelope]);

    const readGeometry = React.useCallback((line: number, character: number | null): GeometryRect | null => {
        const key = `${line}:${character ?? ''}`;
        if (!geometryWatchRef.current.has(key)) {
            geometryWatchRef.current.set(key, { line, character });
            if (readyRef.current) postEnvelope({ v: 1, type: 'geometry.watch', payload: { positions: [...geometryWatchRef.current.values()] } });
            return null;
        }
        const rect = geometryRef.current.get(key);
        return rect ? { ...rect, x: rect.x + originRef.current.x, y: rect.y + originRef.current.y } : null;
    }, [postEnvelope]);
    React.useImperativeHandle(
        ref,
        () => ({
            getValue: () => lastDocRef.current,
            flushPendingChange,
            focus: () => {
                webViewRef.current?.requestFocus?.();
                if (readyRef.current) postEnvelope({ v: 1, type: 'focus', payload: {} });
            },
            find,
            inlineSuggestions,
            getSelection: () => selectionRef.current,
            getLineRect: (line) => readGeometry(line, null),
            getPositionRect: (line, character) => readGeometry(line, character),
            subscribeSelection: (listener) => {
                selectionListenersRef.current.add(listener);
                return () => { selectionListenersRef.current.delete(listener); };
            },
            revealLine: (line, options) => {
                const payload = { line, ...options };
                pendingRevealRef.current = payload;
                if (readyRef.current) { postEnvelope({ v: 1, type: 'reveal', payload }); pendingRevealRef.current = null; }
            },
            runCommand,
            subscribeHistory: (listener) => {
                if (propsRef.current.history) {
                    return propsRef.current.history.subscribe(listener);
                }
                historyListenersRef.current.add(listener);
                listener(historyRef.current);
                return () => { historyListenersRef.current.delete(listener); };
            },
            setDecorations: (layer, items) => {
                decorationsRef.current.set(layer, items);
                if (readyRef.current) postEnvelope({ v: 1, type: 'decorations.set', payload: { layer, items } });
            },
            removeDecoration: (layer, id) => {
                const items = decorationsRef.current.get(layer);
                if (items) decorationsRef.current.set(layer, items.filter(item => item.id !== id));
                if (readyRef.current) postEnvelope({ v: 1, type: 'decorations.remove', payload: { layer, id } });
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
            getCursorPosition: () => cursorRef.current,
            setLanguageIntelligence,
            formatDocument: async () => {
                if (!readyRef.current || !intelligenceRef.current) return;
                const id = createMessageId();
                await new Promise<void>(resolve => { formatRequestsRef.current.set(id, resolve); postEnvelope({ v: 1, type: 'intelligence.format', payload: { id } }); });
            },
            getSignatureHelp: () => signatureRef.current,
            subscribeSignatureHelp: listener => { signatureListenersRef.current.add(listener); return () => { signatureListenersRef.current.delete(listener); }; },
        }),
        [find, flushPendingChange, inlineSuggestions, postEnvelope, readGeometry, runCommand, setLanguageIntelligence],
    );

    const sendInit = React.useCallback(() => {
        if (!readyRef.current) return;
        settleNextEditApply(false);
        const doc = pendingInitRef.current?.doc ?? lastDocRef.current;
        pendingInitRef.current = null;
        lastDocRef.current = doc;
        postEnvelope({
            v: 1,
            type: 'init',
            payload: {
                doc,
                language: resolveCodeMirrorWebViewLanguageSpec(latestLanguageRef.current),
                readOnly: latestReadOnlyRef.current,
                sharedHistory: Boolean(propsRef.current.history),
                ...gutterPropsRef.current,
                ...(pendingRevealRef.current ? { reveal: pendingRevealRef.current } : {}),
            },
        });
        pendingRevealRef.current = null;
        postEnvelope({ v: 1, type: 'keyboard.config', payload: { signatures: keyboardRef.current.signatures } });
        postIntelligence();
        postNextEdit();
        if (findRequestRef.current) postFind({ v: 1, type: 'find.set', payload: findRequestRef.current });
        for (const [layer, items] of decorationsRef.current) postEnvelope({ v: 1, type: 'decorations.set', payload: { layer, items } });
        if (geometryWatchRef.current.size) postEnvelope({ v: 1, type: 'geometry.watch', payload: { positions: [...geometryWatchRef.current.values()] } });
    }, [postEnvelope, postFind, postIntelligence, postNextEdit, settleNextEditApply]);

    React.useEffect(() => {
        if (lastDocRef.current === props.value) return;
        pendingInitRef.current = { doc: props.value };
        lastDocRef.current = props.value;
        if (readyRef.current) {
            postEnvelope({
                v: 1,
                type: 'setDoc',
                payload: { doc: props.value },
            });
        }
    }, [props.value]);

    React.useEffect(() => {
        if (!readyRef.current) return;
        sendInit();
    }, [props.language, readOnly, sendInit, props.lineNumberDigits, props.reviewLaneWidth]);

    React.useEffect(() => {
        return () => {
            readyRef.current = false;
            settleNextEditApply(false);
            intelligenceSubscriptionRef.current?.(); intelligenceSubscriptionRef.current = null;
            nextEditSubscriptionRef.current?.(); nextEditSubscriptionRef.current = null;
            for (const request of intelligenceRequestsRef.current.values()) request.abort(); intelligenceRequestsRef.current.clear();
            for (const resolve of formatRequestsRef.current.values()) resolve(); formatRequestsRef.current.clear();
            focusedRef.current = false;
            cursorRef.current = null;
            inlineContextRef.current = null;
            inlineSuggestionRef.current = null;
            for (const listener of inlineListenersRef.current) listener();
            for (const listener of pointerListenersRef.current) listener(null);
            publishSelection(null);
            for (const pending of pendingDocRequestRef.current.values()) {
                clearTimeout(pending.timeoutId);
                pending.resolve(false);
            }
            pendingDocRequestRef.current.clear();
        };
    }, [props.resetKey, html, settleNextEditApply]);

    return (
        <View
            ref={containerRef}
            collapsable={false}
            testID={props.testID}
            style={{ flex: 1, borderWidth: canvas ? 0 : 1, borderColor: editorTheme.dividerColor, borderRadius: canvas ? 0 : 10, overflow: 'hidden', backgroundColor: editorTheme.backgroundColor }}
        >
            <WebView
                key={props.resetKey}
                ref={webViewRef}
                source={{ html }}
                style={{ flex: 1 }}
                onMessage={(event) => {
                    const raw = event.nativeEvent.data;
                    let parsed: any = null;
                    try {
                        parsed = JSON.parse(raw);
                    } catch {
                        return;
                    }
                    const decoded = decodeChunkedEnvelope({ message: parsed });
                    if (!decoded) return;
                    if (decoded.type === 'intelligence.cancel') {
                        const payload = decoded.payload as { id?: unknown } | null;
                        if (typeof payload?.id === 'string') { intelligenceRequestsRef.current.get(payload.id)?.abort(); intelligenceRequestsRef.current.delete(payload.id); }
                        return;
                    }
                    if (decoded.type === 'intelligence.request') {
                        const payload = decoded.payload as { id?: unknown; kind?: unknown; options?: unknown } | null;
                        if (typeof payload?.id !== 'string') return;
                        if (payload.kind === 'portableCompletion') {
                            const id = payload.id;
                            const position = payload.options as Record<string, unknown> | null;
                            const source = propsRef.current.completionSource;
                            if (!source || !position || !Number.isInteger(position.offset) || Number(position.offset) < 0
                                || !Number.isInteger(position.line) || Number(position.line) < 1
                                || !Number.isInteger(position.character) || Number(position.character) < 0 || typeof position.explicit !== 'boolean') {
                                postEnvelope({ v: 1, type: 'intelligence.result', payload: { id, result: null } }); return;
                            }
                            const abort = new AbortController(); intelligenceRequestsRef.current.set(id, abort);
                            const at = { offset: Number(position.offset), line: Number(position.line), character: Number(position.character), explicit: position.explicit };
                            void Promise.resolve().then(() => source.complete(at, abort.signal))
                                .then(result => { if (!abort.signal.aborted && source === propsRef.current.completionSource) postEnvelope({ v: 1, type: 'intelligence.result', payload: { id, result } }); })
                                .catch(() => { if (!abort.signal.aborted) postEnvelope({ v: 1, type: 'intelligence.result', payload: { id, result: null } }); })
                                .finally(() => intelligenceRequestsRef.current.delete(id));
                            return;
                        }
                        const port = intelligenceRef.current, id = payload.id;
                        const parsed = DaemonLspQueryRequestSchema.safeParse({ ...(payload.options && typeof payload.options === 'object' ? payload.options : {}),
                            kind: payload.kind, rootPath: '/', path: port?.path ?? 'unavailable' });
                        if (!port || !parsed.success) { postEnvelope({ v: 1, type: 'intelligence.result', payload: { id, result: null } }); return; }
                        const { rootPath: _root, path: _path, kind, version: _version, generation: _generation, text: _text, ...options } = parsed.data;
                        const abort = new AbortController(); intelligenceRequestsRef.current.set(id, abort);
                        void port.request(kind, options, abort.signal).then(result => {
                            if (!abort.signal.aborted && port === intelligenceRef.current) postEnvelope({ v: 1, type: 'intelligence.result', payload: { id, result } });
                        }).catch(() => { if (!abort.signal.aborted) postEnvelope({ v: 1, type: 'intelligence.result', payload: { id, result: null } }); })
                            .finally(() => intelligenceRequestsRef.current.delete(id));
                        return;
                    }
                    if (decoded.type === 'intelligence.signature') {
                        const payload = decoded.payload as { help?: unknown } | null;
                        const parsed = payload?.help === null ? null : LanguageIntelligenceSignatureHelpSchema.safeParse(payload?.help);
                        signatureRef.current = parsed?.success ? parsed.data : null;
                        for (const listener of signatureListenersRef.current) listener();
                        return;
                    }
                    if (decoded.type === 'intelligence.formatted') {
                        const payload = decoded.payload as { id?: unknown } | null;
                        if (typeof payload?.id === 'string') { formatRequestsRef.current.get(payload.id)?.(); formatRequestsRef.current.delete(payload.id); }
                        return;
                    }
                    if (decoded.type === 'nextEdit.applied') {
                        const payload = decoded.payload as { requestId?: unknown; applied?: unknown } | null;
                        if (typeof payload?.requestId === 'string' && typeof payload.applied === 'boolean'
                            && payload.requestId === nextEditApplyRef.current?.requestId) settleNextEditApply(payload.applied);
                        return;
                    }

                    if (decoded.type === 'inline.context') {
                        const payload = decoded.payload as { context?: unknown; changes?: unknown; suggestion?: unknown } | null;
                        const context = readInlineContext(payload?.context);
                        if (!context) return;
                        if (Array.isArray(payload?.changes)) {
                            // Offsets refer to the pre-transaction UTF-16 document; apply from its end.
                            for (const change of [...payload.changes].reverse()) {
                                if (!change || typeof change !== 'object') continue;
                                const { from, to, insert } = change as Record<string, unknown>;
                                if (typeof from === 'number' && typeof to === 'number' && Number.isInteger(from) && Number.isInteger(to)
                                    && from >= 0 && to >= from && to <= lastDocRef.current.length && typeof insert === 'string') {
                                    lastDocRef.current = lastDocRef.current.slice(0, from) + insert + lastDocRef.current.slice(to);
                                }
                            }
                        }
                        inlineContextRef.current = context;
                        const suggestion = payload?.suggestion as Record<string, unknown> | null;
                        const position = readEditorPosition(suggestion);
                        if (suggestion && position && typeof suggestion.id === 'string' && typeof suggestion.text === 'string') {
                            const previous = inlineSuggestionRef.current;
                            if (!previous || previous.id !== suggestion.id || previous.text !== suggestion.text
                                || previous.line !== position.line || previous.character !== position.character) {
                                inlineSuggestionRef.current = { id: suggestion.id, text: suggestion.text, ...position };
                            }
                        } else inlineSuggestionRef.current = null;
                        for (const listener of inlineListenersRef.current) listener();
                        return;
                    }
                    if (decoded.type === 'inline.acceptRequested') {
                        const payload = decoded.payload as { id?: unknown; version?: unknown; partial?: unknown } | null;
                        if (typeof payload?.id === 'string' && typeof payload.partial === 'boolean'
                            && payload.version === inlineContextRef.current?.version && inlineGuardRef.current?.(payload.id) === true) {
                            postEnvelope({ v: 1, type: 'inline.accept', payload });
                        }
                        return;
                    }
                    if (decoded.type === 'nextEdit.key') {
                        const kind = (decoded.payload as { kind?: unknown } | null)?.kind;
                        const port = intelligenceRef.current?.nextEditSuggestions;
                        const context = inlineContextRef.current;
                        if (!port) return;
                        if (kind === 'dismiss') port.dismiss();
                        else if (kind === 'tab' && context) port.tab(context, lastDocRef.current, nextEditAdapter);
                        return;
                    }
                    if (decoded.type === 'inline.event') {
                        const payload = decoded.payload as Record<string, unknown> | null;
                        if (!payload || !['shown', 'accepted', 'partiallyAccepted', 'dismissed', 'trigger'].includes(String(payload.kind))) return;
                        const event: CodeEditorInlineEvent = { kind: payload.kind as CodeEditorInlineEvent['kind'],
                            ...(typeof payload.id === 'string' ? { id: payload.id } : {}),
                            ...(typeof payload.acceptedText === 'string' ? { acceptedText: payload.acceptedText } : {}) };
                        for (const listener of inlineEventsRef.current) listener(event);
                        return;
                    }

                    if (decoded.type === 'cursor') {
                        const position = readEditorPosition(decoded.payload);
                        if (position || decoded.payload === null) cursorRef.current = position;
                        return;
                    }
                    if (decoded.type === 'activate') {
                        const position = readEditorPosition(decoded.payload);
                        if (position) for (const listener of activationListenersRef.current) listener(position);
                        return;
                    }
                    if (decoded.type === 'pointer') {
                        if (decoded.payload === null) {
                            for (const listener of pointerListenersRef.current) listener(null);
                            return;
                        }
                        const position = readEditorPosition(decoded.payload);
                        const payload = decoded.payload;
                        if (!position || !payload || typeof payload !== 'object' || !('rect' in payload)) return;
                        const rect = payload.rect;
                        if (!rect || typeof rect !== 'object' || !('x' in rect) || !('y' in rect) || !('width' in rect) || !('height' in rect)) return;
                        const { x, y, width, height } = rect;
                        if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number'
                            || ![x, y, width, height].every(Number.isFinite)) return;
                        for (const listener of pointerListenersRef.current) listener({ ...position, rect: { x, y, width, height } });
                        return;
                    }

                    if (decoded.type === 'ready') {
                        readyRef.current = true;
                        sendInit();
                        return;
                    }
                    if (decoded.type === 'editor.ready') { onReadyRef.current?.(); return; }
                    if (decoded.type === 'find.open') { find.open(); return; }
                    if (decoded.type === 'keyboard.shortcut') {
                        const payload = decoded.payload;
                        if (!payload || typeof payload !== 'object' || !('key' in payload) || typeof payload.key !== 'string' || !('modifiers' in payload)) return;
                        const modifiers = payload.modifiers;
                        if (!modifiers || typeof modifiers !== 'object' || !('shift' in modifiers) || !('ctrl' in modifiers) || !('meta' in modifiers) || !('alt' in modifiers)) return;
                        keyboardRef.current.dispatch({ key: payload.key,
                            ...('code' in payload && typeof payload.code === 'string' ? { code: payload.code } : {}),
                            modifiers: { shift: modifiers.shift === true, ctrl: modifiers.ctrl === true, meta: modifiers.meta === true, alt: modifiers.alt === true },
                            repeat: 'repeat' in payload && payload.repeat === true,
                            isEditableTarget: true,
                        });
                        return;
                    }
                    if (decoded.type === 'history.command') {
                        const payload = decoded.payload;
                        if (payload && typeof payload === 'object' && 'command' in payload && (payload.command === 'undo' || payload.command === 'redo')) runCommand(payload.command);
                        return;
                    }
                    if (decoded.type === 'history.state') {
                        if (propsRef.current.history) return;
                        const payload = decoded.payload;
                        if (payload && typeof payload === 'object' && 'canUndo' in payload && 'canRedo' in payload
                            && typeof payload.canUndo === 'boolean' && typeof payload.canRedo === 'boolean') {
                            historyRef.current = { canUndo: payload.canUndo, canRedo: payload.canRedo };
                            for (const listener of historyListenersRef.current) listener(historyRef.current);
                        }
                        return;
                    }

                    if (decoded.type === 'editor.focus') {
                        const payload = decoded.payload;
                        if (payload && typeof payload === 'object' && 'focused' in payload) focusedRef.current = payload.focused === true;
                        return;
                    }
                    if (decoded.type === 'decorations.press') {
                        const payload = decoded.payload as { layer?: unknown; item?: unknown } | null;
                        if (!payload || (payload.layer !== 'change' && payload.layer !== 'diagnostic' && payload.layer !== 'blame')) return;
                        if (!payload.item || typeof payload.item !== 'object' || !('id' in payload.item) || !('startLine' in payload.item)) return;
                        // The embedded editor returns the same host-authored item with engine-mapped positions.
                        const item = payload.item as EditorDecoration;
                        if (!decorationsRef.current.get(payload.layer)?.some((owned) => owned.id === item.id)) return;
                        for (const listener of decorationListenersRef.current) listener(payload.layer, item);
                        return;
                    }
                    if (decoded.type === 'geometry') {
                        const items = (decoded.payload as { items?: unknown } | null)?.items;
                        if (!Array.isArray(items)) return;
                        for (const item of items) {
                            if (!item || typeof item !== 'object') continue;
                            const value = item as Record<string, unknown>;
                            if (!Number.isInteger(value.line) || (value.character !== null && !Number.isInteger(value.character))) continue;
                            const rect = value.rect && typeof value.rect === 'object' ? value.rect as Record<string, unknown> : null;
                            const valid = rect && ['x', 'y', 'width', 'height'].every((key) => typeof rect[key] === 'number' && Number.isFinite(rect[key]));
                            geometryRef.current.set(`${value.line}:${value.character ?? ''}`, valid
                                ? { x: Number(rect.x), y: Number(rect.y), width: Number(rect.width), height: Number(rect.height) } : null);
                        }
                        for (const listener of selectionListenersRef.current) listener();
                        // The WebView answers in its own coordinates; follow where the editor sits in the window.
                        containerRef.current?.measureInWindow?.((x, y) => {
                            if (x === originRef.current.x && y === originRef.current.y) return;
                            originRef.current = { x, y };
                            for (const listener of selectionListenersRef.current) listener();
                        });
                        return;
                    }
                    if (decoded.type === 'selection') {
                        const payload = decoded.payload;
                        if (payload === null) { publishSelection(null); return; }
                        if (!payload || typeof payload !== 'object') return;
                        const value = payload as Record<string, unknown>;
                        const range = value.range && typeof value.range === 'object' ? value.range as Record<string, unknown> : null;
                        if (!Number.isInteger(value.startLine) || Number(value.startLine) < 1
                            || !Number.isInteger(value.endLine) || Number(value.endLine) < Number(value.startLine)
                            || typeof value.text !== 'string' || !range || !Number.isInteger(range.start) || Number(range.start) < 0
                            || !Number.isInteger(range.end) || Number(range.end) < Number(range.start)) return;
                        const rect = value.rect;
                        const position = rect && typeof rect === 'object' ? rect as Record<string, unknown> : null;
                        publishSelection({ startLine: Number(value.startLine), endLine: Number(value.endLine), text: value.text,
                            range: { start: Number(range.start), end: Number(range.end) },
                            rect: position && ['x', 'y', 'width', 'height'].every((key) => typeof position[key] === 'number' && Number.isFinite(position[key]))
                                ? { x: Number(position.x), y: Number(position.y), width: Number(position.width), height: Number(position.height) } : null,
                            collapsed: value.collapsed === true,
                        });
                        return;
                    }
                    if (decoded.type === 'find.status') {
                        const status = readCodeMirrorFindStatus(decoded.payload, findSnapshotRef.current);
                        if (status && findOpenRef.current) publishFind({ ...findSnapshotRef.current, status });
                        return;
                    }
                    if (decoded.type === 'error') {
                        readyRef.current = false;
                        settleNextEditApply(false);
                        cursorRef.current = null;
                        for (const listener of pointerListenersRef.current) listener(null);
                        publishSelection(null);
                        if (findOpenRef.current) publishFind({ ...findSnapshotRef.current, status: { kind: 'unavailable', reason: 'unsupportedEngine' } });
                        return;
                    }

                    if (decoded.type === 'docChanged') {
                        const payload = decoded.payload;
                        if (payload && typeof payload === 'object' && 'doc' in payload && typeof payload.doc === 'string') {
                            lastDocRef.current = payload.doc;
                            const history = 'history' in payload ? payload.history : undefined;
                            if (history === 'undo' || history === 'redo') props.onChange(payload.doc, { history });
                            else props.onChange(payload.doc);
                        }
                        return;
                    }

                    if (decoded.type === 'docSnapshot') {
                        const payload: any = decoded.payload;
                        const requestId = payload && typeof payload.requestId === 'string' ? payload.requestId : '';
                        const doc = payload && typeof payload.doc === 'string' ? payload.doc : null;
                        if (!requestId || doc === null) return;

                        const pending = pendingDocRequestRef.current.get(requestId);
                        if (!pending) return;
                        if (lastDocRef.current !== doc) {
                            lastDocRef.current = doc;
                            if (pending.change) props.onChange(doc, pending.change);
                            else props.onChange(doc);
                        }
                        pendingDocRequestRef.current.delete(requestId);
                        clearTimeout(pending.timeoutId);
                        pending.resolve(true);
                        return;
                    }
                }}
            />
        </View>
    );
});
