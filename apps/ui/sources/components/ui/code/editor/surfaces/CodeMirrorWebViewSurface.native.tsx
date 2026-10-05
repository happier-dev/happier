import React from 'react';
import { PixelRatio, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { useUnistyles } from 'react-native-unistyles';

import { useLocalSetting } from '@/sync/store/hooks';
import type { CodeEditorFindHandle, CodeEditorFindSnapshot, CodeEditorHandle, CodeEditorProps } from '../codeEditorTypes';
import { encodeChunkedEnvelope, decodeChunkedEnvelope } from '@/components/ui/webview/bridge/chunkedBridge';
import { buildCodeMirrorWebViewHtml } from '../bridge/codemirrorWebViewHtml';
import { resolveCodeMirrorWebViewLanguageSpec } from '../bridge/resolveCodeMirrorWebViewLanguageSpec';
import { resolveCodeEditorTheme } from '../editorTheme';
import { readCodeMirrorFindStatus } from '../bridge/codeEditorFindBridge';
import type { CodeEditorFindMessage, CodeEditorFindSet } from '../bridge/codeEditorFindBridge';

function createMessageId(): string {
    return Math.random().toString(36).slice(2);
}

export const CodeMirrorWebViewSurface = React.forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeMirrorWebViewSurface(
    props,
    ref,
) {
    const { theme } = useUnistyles();
    const uiFontScale = useLocalSetting('uiFontScale');
    const editorTheme = React.useMemo(
        () => resolveCodeEditorTheme(theme),
        [
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
    const pendingInitRef = React.useRef<null | { doc: string }>(null);
    const lastDocRef = React.useRef(props.value);
    const pendingDocRequestRef = React.useRef(new Map<string, { resolve: () => void; timeoutId: any }>());
    const latestLanguageRef = React.useRef(props.language);
    const latestReadOnlyRef = React.useRef(false);
    const focusedRef = React.useRef(false);
    const findOpenRef = React.useRef(false);
    const findRequestRef = React.useRef<CodeEditorFindSet | null>(null);
    const findSnapshotRef = React.useRef<CodeEditorFindSnapshot>({
        query: '', options: { matchCase: false, regex: false }, status: { kind: 'idle' },
    });
    const findListenersRef = React.useRef(new Set<() => void>());

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
            }),
        [
            changeDebounceMs,
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

    const flushPendingChange = React.useCallback(async (): Promise<void> => {
        if (!readyRef.current) return;
        const requestId = createMessageId();
        return await new Promise<void>((resolve) => {
            const timeoutId = setTimeout(() => {
                pendingDocRequestRef.current.delete(requestId);
                resolve();
            }, 1500);
            pendingDocRequestRef.current.set(requestId, { resolve, timeoutId });
            postEnvelope({
                v: 1,
                type: 'requestDoc',
                payload: { requestId },
            });
        });
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
        }),
        [find, flushPendingChange],
    );

    const sendInit = React.useCallback(() => {
        if (!readyRef.current) return;
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
            },
        });
        if (findRequestRef.current) postFind({ v: 1, type: 'find.set', payload: findRequestRef.current });
    }, [postEnvelope, postFind]);

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
    }, [props.language, readOnly, sendInit]);

    React.useEffect(() => {
        return () => {
            readyRef.current = false;
            focusedRef.current = false;
            for (const pending of pendingDocRequestRef.current.values()) {
                clearTimeout(pending.timeoutId);
                pending.resolve();
            }
            pendingDocRequestRef.current.clear();
        };
    }, [props.resetKey, html]);

    return (
        <View
            testID={props.testID}
            style={{ flex: 1, borderWidth: 1, borderColor: editorTheme.dividerColor, borderRadius: 10, overflow: 'hidden', backgroundColor: editorTheme.backgroundColor }}
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

                    if (decoded.type === 'ready') {
                        readyRef.current = true;
                        sendInit();
                        return;
                    }

                    if (decoded.type === 'editor.focus') {
                        const payload = decoded.payload;
                        if (payload && typeof payload === 'object' && 'focused' in payload) focusedRef.current = payload.focused === true;
                        return;
                    }
                    if (decoded.type === 'find.status') {
                        const status = readCodeMirrorFindStatus(decoded.payload, findSnapshotRef.current);
                        if (status && findOpenRef.current) publishFind({ ...findSnapshotRef.current, status });
                        return;
                    }
                    if (decoded.type === 'error') {
                        readyRef.current = false;
                        if (findOpenRef.current) publishFind({ ...findSnapshotRef.current, status: { kind: 'unavailable', reason: 'unsupportedEngine' } });
                        return;
                    }

                    if (decoded.type === 'docChanged') {
                        const payload: any = decoded.payload;
                        if (payload && typeof payload.doc === 'string') {
                            lastDocRef.current = payload.doc;
                            props.onChange(payload.doc);
                        }
                        return;
                    }

                    if (decoded.type === 'docSnapshot') {
                        const payload: any = decoded.payload;
                        const requestId = payload && typeof payload.requestId === 'string' ? payload.requestId : '';
                        const doc = payload && typeof payload.doc === 'string' ? payload.doc : null;
                        if (!requestId || doc === null) return;

                        lastDocRef.current = doc;
                        props.onChange(doc);

                        const pending = pendingDocRequestRef.current.get(requestId);
                        if (pending) {
                            pendingDocRequestRef.current.delete(requestId);
                            clearTimeout(pending.timeoutId);
                            pending.resolve();
                        }
                        return;
                    }
                }}
            />
        </View>
    );
});
