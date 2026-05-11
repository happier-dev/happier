import * as React from 'react';
import { View } from 'react-native';
import { WebView } from 'react-native-webview';
import { useUnistyles } from 'react-native-unistyles';

import { encodeChunkedEnvelope, decodeChunkedEnvelope } from '@/components/ui/webview/bridge/chunkedBridge';

import { buildXtermWebViewHtml } from './xtermWebViewHtml';

const XTERM_WEBVIEW_BOOT_RETRY_LIMIT = 1;

function createMessageId(): string {
    return Math.random().toString(36).slice(2);
}

export type XtermWebViewSurfaceHandle = Readonly<{
    write: (data: string) => void;
    clear: () => void;
    focus: () => void;
}>;

export type XtermWebViewSurfaceProps = Readonly<{
    onInput: (data: string) => void;
    onResize: (cols: number, rows: number) => void;
    onReady: (cols: number, rows: number) => void;
    fontSize: number;
    lineHeightPx: number;
    bridgeMaxChunkBytes?: number;
    testID?: string;
}>;

export const XtermWebViewSurface = React.forwardRef<XtermWebViewSurfaceHandle, XtermWebViewSurfaceProps>(
    function XtermWebViewSurface(props, ref) {
        const { theme } = useUnistyles();
        const webViewRef = React.useRef<WebView>(null);
        const readyRef = React.useRef(false);
        const pendingWriteRef = React.useRef('');
        const bootRetryCountRef = React.useRef(0);
        const [reloadNonce, setReloadNonce] = React.useState(0);
        const maxChunkBytes = typeof props.bridgeMaxChunkBytes === 'number' ? props.bridgeMaxChunkBytes : 64_000;

        const allowCdnFallback = typeof (__DEV__ as any) === 'boolean' ? (__DEV__ as any) : true;

        const html = React.useMemo(
            () =>
                buildXtermWebViewHtml({
                    theme: {
                        backgroundColor: theme.colors.surface.base,
                        textColor: theme.colors.text.primary,
                        cursorColor: theme.colors.text.primary,
                        selectionBackgroundColor: theme.colors.surface.selected,
                        isDark: Boolean(theme.dark),
                    },
                    fontSizePx: Math.max(8, Math.round(props.fontSize)),
                    lineHeightPx: Math.max(10, Math.round(props.lineHeightPx)),
                    maxChunkBytes,
                    allowCdnFallback,
                }),
            [
                allowCdnFallback,
                maxChunkBytes,
                props.fontSize,
                props.lineHeightPx,
                theme.colors.surface.base,
                theme.colors.surface.selected,
                theme.colors.text.primary,
                theme.dark,
            ],
        );

        React.useEffect(() => {
            readyRef.current = false;
            bootRetryCountRef.current = 0;
        }, [html]);

        const postEnvelope = React.useCallback(
            (envelope: { v: 1; type: string; payload: unknown }) => {
                const messages = encodeChunkedEnvelope({ envelope, maxChunkBytes, messageId: createMessageId() });
                for (const msg of messages) {
                    webViewRef.current?.postMessage(JSON.stringify(msg));
                }
            },
            [maxChunkBytes],
        );

        const flushPendingWrite = React.useCallback(() => {
            if (!readyRef.current) return;
            const pending = pendingWriteRef.current;
            if (!pending) return;
            pendingWriteRef.current = '';
            postEnvelope({ v: 1, type: 'write', payload: { data: pending } });
        }, [postEnvelope]);

        React.useImperativeHandle(
            ref,
            () => ({
                write: (data: string) => {
                    if (!data) return;
                    pendingWriteRef.current += data;
                    flushPendingWrite();
                },
                clear: () => {
                    pendingWriteRef.current = '';
                    if (!readyRef.current) return;
                    postEnvelope({ v: 1, type: 'clear', payload: {} });
                },
                focus: () => {
                    if (!readyRef.current) return;
                    postEnvelope({ v: 1, type: 'focus', payload: {} });
                },
            }),
            [flushPendingWrite, postEnvelope],
        );

        React.useEffect(() => {
            if (!readyRef.current) return;
            postEnvelope({
                v: 1,
                type: 'setTheme',
                payload: {
                    backgroundColor: theme.colors.surface.base,
                    textColor: theme.colors.text.primary,
                    cursorColor: theme.colors.text.primary,
                    selectionBackgroundColor: theme.colors.surface.selected,
                    isDark: Boolean(theme.dark),
                },
            });
            postEnvelope({
                v: 1,
                type: 'setFontSize',
                payload: {
                    fontSizePx: Math.max(8, Math.round(props.fontSize)),
                    lineHeight: Math.max(1, Math.min(2.5, props.lineHeightPx / Math.max(1, props.fontSize))),
                },
            });
        }, [
            postEnvelope,
            props.fontSize,
            props.lineHeightPx,
            theme.colors.surface.base,
            theme.colors.surface.selected,
            theme.colors.text.primary,
            theme.dark,
        ]);

        return (
            <View
                testID={props.testID}
                style={{ flex: 1, minHeight: 0, minWidth: 0, borderWidth: 1, borderColor: theme.colors.border.default, borderRadius: 10, overflow: 'hidden' }}
            >
                <WebView
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
                            const payload: any = decoded.payload;
                            const cols = payload && typeof payload.cols === 'number' ? payload.cols : NaN;
                            const rows = payload && typeof payload.rows === 'number' ? payload.rows : NaN;
                            if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return;
                            readyRef.current = true;
                            props.onReady(cols, rows);
                            postEnvelope({
                                v: 1,
                                type: 'setTheme',
                                payload: {
                                    backgroundColor: theme.colors.surface.base,
                                    textColor: theme.colors.text.primary,
                                    cursorColor: theme.colors.text.primary,
                                    selectionBackgroundColor: theme.colors.surface.selected,
                                    isDark: Boolean(theme.dark),
                                },
                            });
                            postEnvelope({
                                v: 1,
                                type: 'setFontSize',
                                payload: {
                                    fontSizePx: Math.max(8, Math.round(props.fontSize)),
                                    lineHeight: Math.max(1, Math.min(2.5, props.lineHeightPx / Math.max(1, props.fontSize))),
                                },
                            });
                            flushPendingWrite();
                            return;
                        }

                        if (decoded.type === 'resize') {
                            const payload: any = decoded.payload;
                            const cols = payload && typeof payload.cols === 'number' ? payload.cols : NaN;
                            const rows = payload && typeof payload.rows === 'number' ? payload.rows : NaN;
                            if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return;
                            props.onResize(cols, rows);
                            return;
                        }

                        if (decoded.type === 'input') {
                            const payload: any = decoded.payload;
                            const data = payload && typeof payload.data === 'string' ? payload.data : '';
                            if (!data) return;
                            props.onInput(data);
                            return;
                        }

                        if (decoded.type === 'bootError') {
                            readyRef.current = false;
                            if (bootRetryCountRef.current < XTERM_WEBVIEW_BOOT_RETRY_LIMIT) {
                                bootRetryCountRef.current += 1;
                                setReloadNonce((value) => value + 1);
                            }
                            return;
                        }
                    }}
                    key={`xterm-webview-${reloadNonce}`}
                />
            </View>
        );
    },
);
