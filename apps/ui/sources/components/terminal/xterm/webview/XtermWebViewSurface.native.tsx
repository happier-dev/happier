import * as React from 'react';
import { View } from 'react-native';
import { WebView } from 'react-native-webview';
import { useUnistyles } from 'react-native-unistyles';

import { encodeChunkedEnvelope, decodeChunkedEnvelope } from '@/components/ui/webview/bridge/chunkedBridge';
import {
    buildXtermWriteCompleteEvent,
    copyTerminalBytes,
    type XtermWriteBytesInput,
    type XtermWriteCompleteEvent,
} from '@/components/terminal/xterm/bytes';

import { encodeTerminalBytesBase64 } from './bytes';
import {
    DEFAULT_XTERM_WEBVIEW_MAX_PENDING_WRITE_BYTES,
    estimateXtermWebViewTextWriteBytes,
} from './writeQueue';
import { buildXtermWebViewHtml } from './xtermWebViewHtml';

const XTERM_WEBVIEW_BOOT_RETRY_LIMIT = 1;
// Inline readiness retries finish in roughly 1.5 seconds; this only bounds a WebView that never boots.
const XTERM_WEBVIEW_BOOT_READY_TIMEOUT_MS = 10_000;
const XTERM_WEBVIEW_LOAD_ERROR_CODE = 'terminal_webview_load_error';
const XTERM_WEBVIEW_PROCESS_TERMINATED_CODE = 'terminal_webview_process_terminated';
const XTERM_WEBVIEW_READY_TIMEOUT_CODE = 'terminal_webview_ready_timeout';

function createMessageId(): string {
    return Math.random().toString(36).slice(2);
}

export type XtermWebViewSurfaceHandle = Readonly<{
    write: (data: string) => boolean;
    writeBytes: (input: XtermWriteBytesInput) => boolean | Readonly<{ status: 'queued' }>;
    clear: () => void;
    focus: () => void;
}>;

export type XtermWebViewRejectedWrite = Readonly<Pick<XtermWriteCompleteEvent,
    'terminalId' | 'seq' | 'byteOffset' | 'byteLength' | 'writeGeneration'
>>;

export type XtermWebViewRendererFailure = Readonly<{
    type: 'boot-retry-exhausted';
    code: string;
    rejectedWrites: readonly XtermWebViewRejectedWrite[];
}>;

export type XtermWebViewSurfaceProps = Readonly<{
    onInput: (data: string) => void;
    onPaste?: (data: string) => void | Promise<unknown>;
    onLink?: (url: string) => void;
    onResize: (cols: number, rows: number) => void;
    onReady: (cols: number, rows: number) => void;
    onWriteComplete?: (event: XtermWriteCompleteEvent) => void;
    onRendererFailure?: (failure: XtermWebViewRendererFailure) => void;
    fontSize: number;
    lineHeightPx: number;
    bridgeMaxChunkBytes?: number;
    maxPendingWriteBytes?: number;
    testID?: string;
}>;

type HostEnvelope = Readonly<{ v: 1; type: string; payload: unknown }>;
type TerminalSizePayload = Readonly<{ cols: number; rows: number }>;

function readTerminalSizePayload(value: unknown): TerminalSizePayload | null {
    if (!value || typeof value !== 'object') return null;
    const payload = value as Partial<TerminalSizePayload>;
    const cols = typeof payload.cols === 'number' ? payload.cols : NaN;
    const rows = typeof payload.rows === 'number' ? payload.rows : NaN;
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return null;
    return { cols, rows };
}

function readStringPayloadField(value: unknown, key: string): string | null {
    if (!value || typeof value !== 'object') return null;
    const field = (value as Record<string, unknown>)[key];
    return typeof field === 'string' && field.length > 0 ? field : null;
}

function readBootErrorCode(value: unknown): string {
    return readStringPayloadField(value, 'code') ?? 'terminal_boot_failed';
}

function readWriteCompleteEvent(value: unknown): XtermWriteCompleteEvent | null {
    if (!value || typeof value !== 'object') return null;
    const payload = value as Partial<XtermWriteCompleteEvent>;
    if (typeof payload.terminalId !== 'string' || payload.terminalId.length === 0) return null;
    if (typeof payload.seq !== 'number' || !Number.isFinite(payload.seq)) return null;
    if (typeof payload.byteOffset !== 'number' || !Number.isFinite(payload.byteOffset)) return null;
    if (typeof payload.byteLength !== 'number' || !Number.isFinite(payload.byteLength) || payload.byteLength < 0) return null;
    if (typeof payload.ackedByteOffset !== 'number' || !Number.isFinite(payload.ackedByteOffset)) return null;
    if (typeof payload.writeGeneration !== 'number' || !Number.isFinite(payload.writeGeneration)) return null;
    if (payload.ackedByteOffset !== payload.byteOffset + payload.byteLength) return null;
    return {
        terminalId: payload.terminalId,
        seq: payload.seq,
        byteOffset: payload.byteOffset,
        byteLength: payload.byteLength,
        ackedByteOffset: payload.ackedByteOffset,
        writeGeneration: payload.writeGeneration,
    };
}

export const XtermWebViewSurface = React.forwardRef<XtermWebViewSurfaceHandle, XtermWebViewSurfaceProps>(
    function XtermWebViewSurface(props, ref) {
        const { theme } = useUnistyles();
        const webViewRef = React.useRef<WebView>(null);
        const readyRef = React.useRef(false);
        const pendingEnvelopeRef = React.useRef<HostEnvelope[]>([]);
        const pendingWriteBytesRef = React.useRef(0);
        const pendingByteWritesRef = React.useRef(new Map<string, XtermWriteCompleteEvent>());
        const bootRetryCountRef = React.useRef(0);
        const bootFailureReportedRef = React.useRef(false);
        const [reloadNonce, setReloadNonce] = React.useState(0);
        const activeWebViewGenerationRef = React.useRef(reloadNonce);
        const bootReadyTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
        const mountedRef = React.useRef(true);
        const maxChunkBytes = typeof props.bridgeMaxChunkBytes === 'number' ? props.bridgeMaxChunkBytes : 64_000;
        const maxPendingWriteBytes = props.maxPendingWriteBytes ?? DEFAULT_XTERM_WEBVIEW_MAX_PENDING_WRITE_BYTES;

        const allowCdnFallback = typeof __DEV__ === 'boolean' ? __DEV__ : true;

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

        const clearBootReadyTimeout = React.useCallback(() => {
            if (bootReadyTimeoutRef.current === null) return;
            clearTimeout(bootReadyTimeoutRef.current);
            bootReadyTimeoutRef.current = null;
        }, []);

        React.useEffect(() => {
            readyRef.current = false;
            bootRetryCountRef.current = 0;
            bootFailureReportedRef.current = false;
            clearBootReadyTimeout();
        }, [clearBootReadyTimeout, html]);

        React.useLayoutEffect(() => {
            activeWebViewGenerationRef.current = reloadNonce;
        }, [reloadNonce]);

        React.useEffect(() => {
            mountedRef.current = true;
            return () => {
                mountedRef.current = false;
            };
        }, []);

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
            const pending = pendingEnvelopeRef.current;
            if (pending.length === 0) return;
            pendingEnvelopeRef.current = [];
            pendingWriteBytesRef.current = 0;
            for (const envelope of pending) {
                postEnvelope(envelope);
            }
        }, [postEnvelope]);

        const requestNativeFocus = React.useCallback(() => {
            try {
                webViewRef.current?.requestFocus();
            } catch {
                // Ignore focus command failures; xterm focus is still attempted inside the WebView.
            }
        }, []);

        const enqueueEnvelope = React.useCallback((envelope: HostEnvelope, byteLength: number) => {
            if (bootFailureReportedRef.current) {
                return false;
            }
            if (readyRef.current) {
                postEnvelope(envelope);
                return true;
            }
            if (pendingWriteBytesRef.current + byteLength > maxPendingWriteBytes) {
                return false;
            }
            pendingEnvelopeRef.current = [...pendingEnvelopeRef.current, envelope];
            pendingWriteBytesRef.current += byteLength;
            return true;
        }, [maxPendingWriteBytes, postEnvelope]);

        const rejectPendingWritesAfterBootFailure = React.useCallback((code: string) => {
            if (bootFailureReportedRef.current) {
                return;
            }
            bootFailureReportedRef.current = true;
            const rejectedWrites = Array.from(pendingByteWritesRef.current.values(), (write) => ({
                terminalId: write.terminalId,
                seq: write.seq,
                byteOffset: write.byteOffset,
                byteLength: write.byteLength,
                writeGeneration: write.writeGeneration,
            }));
            pendingByteWritesRef.current.clear();
            pendingEnvelopeRef.current = [];
            pendingWriteBytesRef.current = 0;
            props.onRendererFailure?.({
                type: 'boot-retry-exhausted',
                code,
                rejectedWrites,
            });
        }, [props.onRendererFailure]);

        const handleWebViewBootFailure = React.useCallback((webViewGeneration: number, code: string) => {
            if (!mountedRef.current || webViewGeneration !== activeWebViewGenerationRef.current || bootFailureReportedRef.current) {
                return;
            }
            readyRef.current = false;
            clearBootReadyTimeout();
            if (bootRetryCountRef.current < XTERM_WEBVIEW_BOOT_RETRY_LIMIT) {
                bootRetryCountRef.current += 1;
                setReloadNonce((value) => value + 1);
                return;
            }
            rejectPendingWritesAfterBootFailure(code);
        }, [clearBootReadyTimeout, rejectPendingWritesAfterBootFailure]);

        React.useEffect(() => {
            const timeout = setTimeout(() => {
                handleWebViewBootFailure(reloadNonce, XTERM_WEBVIEW_READY_TIMEOUT_CODE);
            }, XTERM_WEBVIEW_BOOT_READY_TIMEOUT_MS);
            bootReadyTimeoutRef.current = timeout;
            return () => {
                if (bootReadyTimeoutRef.current !== timeout) return;
                clearTimeout(timeout);
                bootReadyTimeoutRef.current = null;
            };
        }, [handleWebViewBootFailure, html, reloadNonce]);

        React.useImperativeHandle(
            ref,
            () => ({
                write: (data: string) => {
                    if (!data) return true;
                    return enqueueEnvelope(
                        { v: 1, type: 'write', payload: { data } },
                        estimateXtermWebViewTextWriteBytes(data),
                    );
                },
                writeBytes: (input: XtermWriteBytesInput) => {
                    if (input.bytes.byteLength === 0) return true;
                    const bytes = copyTerminalBytes(input.bytes);
                    const completion = buildXtermWriteCompleteEvent({ ...input, bytes });
                    const writeKey = getWriteKey(completion);
                    const accepted = enqueueEnvelope({
                        v: 1,
                        type: 'writeBytes',
                        payload: {
                            terminalId: completion.terminalId,
                            seq: completion.seq,
                            byteOffset: completion.byteOffset,
                            byteLength: completion.byteLength,
                            writeGeneration: completion.writeGeneration,
                            dataBase64: encodeTerminalBytesBase64(bytes),
                        },
                    }, bytes.byteLength);
                    if (!accepted) return false;
                    pendingByteWritesRef.current.set(writeKey, completion);
                    return { status: 'queued' } as const;
                },
                clear: () => {
                    pendingEnvelopeRef.current = [];
                    pendingWriteBytesRef.current = 0;
                    pendingByteWritesRef.current.clear();
                    if (!readyRef.current) return;
                    postEnvelope({ v: 1, type: 'clear', payload: {} });
                },
                focus: () => {
                    requestNativeFocus();
                    if (!readyRef.current) return;
                    postEnvelope({ v: 1, type: 'focus', payload: {} });
                },
            }),
            [enqueueEnvelope, postEnvelope, requestNativeFocus],
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
                    keyboardDisplayRequiresUserAction={false}
                    onMessage={(event) => {
                        if (!mountedRef.current || reloadNonce !== activeWebViewGenerationRef.current) return;
                        const raw = event.nativeEvent.data;
                        let parsed: unknown = null;
                        try {
                            parsed = JSON.parse(raw);
                        } catch {
                            return;
                        }
                        const decoded = decodeChunkedEnvelope({ message: parsed });
                        if (!decoded) return;

                        if (decoded.type === 'ready') {
                            if (bootFailureReportedRef.current) return;
                            const payload = readTerminalSizePayload(decoded.payload);
                            if (!payload) return;
                            clearBootReadyTimeout();
                            readyRef.current = true;
                            requestNativeFocus();
                            props.onReady(payload.cols, payload.rows);
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
                            const payload = readTerminalSizePayload(decoded.payload);
                            if (!payload) return;
                            props.onResize(payload.cols, payload.rows);
                            return;
                        }

                        if (decoded.type === 'input') {
                            const data = readStringPayloadField(decoded.payload, 'data');
                            if (!data) return;
                            props.onInput(data);
                            return;
                        }

                        if (decoded.type === 'paste') {
                            const data = readStringPayloadField(decoded.payload, 'text');
                            if (!data) return;
                            void props.onPaste?.(data);
                            return;
                        }

                        if (decoded.type === 'link') {
                            const url = readStringPayloadField(decoded.payload, 'url');
                            if (!url) return;
                            props.onLink?.(url);
                            return;
                        }

                        if (decoded.type === 'writeComplete') {
                            const event = readWriteCompleteEvent(decoded.payload);
                            if (!event) return;
                            const writeKey = getWriteKey(event);
                            if (!pendingByteWritesRef.current.delete(writeKey)) return;
                            props.onWriteComplete?.(event);
                            return;
                        }

                        if (decoded.type === 'bootError') {
                            handleWebViewBootFailure(reloadNonce, readBootErrorCode(decoded.payload));
                            return;
                        }
                    }}
                    onError={() => {
                        handleWebViewBootFailure(reloadNonce, XTERM_WEBVIEW_LOAD_ERROR_CODE);
                    }}
                    onContentProcessDidTerminate={() => {
                        handleWebViewBootFailure(reloadNonce, XTERM_WEBVIEW_PROCESS_TERMINATED_CODE);
                    }}
                    onRenderProcessGone={() => {
                        handleWebViewBootFailure(reloadNonce, XTERM_WEBVIEW_PROCESS_TERMINATED_CODE);
                    }}
                    key={`xterm-webview-${reloadNonce}`}
                />
            </View>
        );
    },
);

function getWriteKey(event: XtermWriteCompleteEvent): string {
    return `${event.terminalId}:${event.seq}:${event.byteOffset}:${event.byteLength}:${event.ackedByteOffset}:${event.writeGeneration}`;
}
