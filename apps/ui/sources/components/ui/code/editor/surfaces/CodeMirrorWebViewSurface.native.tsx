import React from 'react';
import { PixelRatio, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { useUnistyles } from 'react-native-unistyles';

import { useLocalSetting } from '@/sync/store/hooks';
import type { CodeEditorHandle, CodeEditorProps } from '../codeEditorTypes';
import { encodeChunkedEnvelope, decodeChunkedEnvelope } from '@/components/ui/webview/bridge/chunkedBridge';
import { buildCodeMirrorWebViewHtml } from '../bridge/codemirrorWebViewHtml';
import { resolveCodeMirrorWebViewLanguageSpec } from '../bridge/resolveCodeMirrorWebViewLanguageSpec';

function createMessageId(): string {
    return Math.random().toString(36).slice(2);
}

export const CodeMirrorWebViewSurface = React.forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeMirrorWebViewSurface(
    props,
    ref,
) {
    const { theme } = useUnistyles();
    const uiFontScale = useLocalSetting('uiFontScale');
    const webViewRef = React.useRef<WebView>(null);
    const readyRef = React.useRef(false);
    const pendingInitRef = React.useRef<null | { doc: string }>(null);
    const lastDocRef = React.useRef(props.value);
    const pendingDocRequestRef = React.useRef(new Map<string, { resolve: () => void; timeoutId: any }>());

    const wrapLines = props.wrapLines ?? true;
    const showLineNumbers = props.showLineNumbers ?? true;
    const readOnly = props.readOnly ?? false;
    const changeDebounceMs = typeof props.changeDebounceMs === 'number' ? props.changeDebounceMs : 250;
    const maxChunkBytes = typeof props.bridgeMaxChunkBytes === 'number' ? props.bridgeMaxChunkBytes : 64_000;

    const html = React.useMemo(
        () =>
            buildCodeMirrorWebViewHtml({
                theme: {
                    backgroundColor: theme.colors.surfaceHighest,
                    textColor: theme.colors.text,
                    dividerColor: theme.colors.divider,
                    isDark: Boolean(theme.dark),
                },
                wrapLines,
                showLineNumbers,
                changeDebounceMs,
                maxChunkBytes,
                uiFontScale,
                osFontScale: typeof PixelRatio.getFontScale === 'function' ? PixelRatio.getFontScale() : 1,
            }),
        [
            changeDebounceMs,
            maxChunkBytes,
            showLineNumbers,
            uiFontScale,
            theme.colors.divider,
            theme.colors.surfaceHighest,
            theme.colors.text,
            theme.dark,
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
        }),
        [flushPendingChange],
    );

    const sendInit = React.useCallback(() => {
        if (!readyRef.current) return;
        const doc = pendingInitRef.current?.doc ?? props.value;
        pendingInitRef.current = null;
        lastDocRef.current = doc;
        postEnvelope({
            v: 1,
            type: 'init',
            payload: {
                doc,
                language: resolveCodeMirrorWebViewLanguageSpec(props.language),
                readOnly,
            },
        });
    }, [postEnvelope, props.language, props.value, readOnly]);

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

    return (
        <View
            testID={props.testID}
            style={{ flex: 1, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 10, overflow: 'hidden' }}
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
