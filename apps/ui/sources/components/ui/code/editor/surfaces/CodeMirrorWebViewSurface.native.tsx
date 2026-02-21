import React from 'react';
import { PixelRatio, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { useUnistyles } from 'react-native-unistyles';

import { useLocalSetting } from '@/sync/store/hooks';
import type { CodeEditorProps } from '../codeEditorTypes';
import { encodeChunkedEnvelope, decodeChunkedEnvelope } from '../bridge/chunkedBridge';
import { buildCodeMirrorWebViewHtml } from '../bridge/codemirrorWebViewHtml';

function createMessageId(): string {
    return Math.random().toString(36).slice(2);
}

export function CodeMirrorWebViewSurface(props: CodeEditorProps) {
    const { theme } = useUnistyles();
    const uiFontScale = useLocalSetting('uiFontScale');
    const webViewRef = React.useRef<WebView>(null);
    const readyRef = React.useRef(false);
    const pendingInitRef = React.useRef<null | { doc: string }>(null);

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

    const sendInit = React.useCallback(() => {
        if (!readyRef.current) return;
        const doc = pendingInitRef.current?.doc ?? props.value;
        pendingInitRef.current = null;
        postEnvelope({
            v: 1,
            type: 'init',
            payload: {
                doc,
                language: props.language,
                readOnly,
            },
        });
    }, [postEnvelope, props.language, props.value, readOnly]);

    React.useEffect(() => {
        // When the controlled value changes externally, we only apply it on next mount/init.
        // This avoids a change feedback loop (docChanged -> setState -> setDoc -> docChanged).
        pendingInitRef.current = { doc: props.value };
    }, [props.value]);

    return (
        <View style={{ flex: 1, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 10, overflow: 'hidden' }}>
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
                            props.onChange(payload.doc);
                        }
                        return;
                    }
                }}
            />
        </View>
    );
}
