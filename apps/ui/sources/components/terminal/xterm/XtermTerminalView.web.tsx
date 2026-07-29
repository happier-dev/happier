import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import type { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';

import '@xterm/xterm/css/xterm.css';
import {
    createXtermFitAddon,
    loadXtermWebLinksAddon,
    tryLoadXtermWebglAddon,
} from './addons';
import {
    buildXtermWriteCompleteEvent,
    copyTerminalBytes,
    decodeTerminalBytesForPreview,
    estimateUtf8ByteLength,
    type XtermWriteBytesInput,
    type XtermWriteCompleteEvent,
} from './bytes';
import {
    createXtermWriteQueue,
    DEFAULT_XTERM_MAX_PENDING_WRITE_BYTES,
    type XtermRejectedWrite,
    type XtermWriteQueue,
} from './writeQueue';

export type XtermTerminalHandle = Readonly<{
    write: (data: string) => boolean;
    writeBytes: (input: XtermWriteBytesInput) => boolean;
    clear: () => void;
    focus: () => void;
    hasSelection: () => boolean;
    getSelectionText: () => string;
}>;

export type XtermTerminalViewProps = Readonly<{
    onInput: (data: string) => void;
    onPaste?: (data: string) => void | Promise<unknown>;
    onLink?: (url: string) => void;
    onResize: (cols: number, rows: number) => void;
    onReady: (cols: number, rows: number) => void;
    onWriteComplete?: (event: XtermWriteCompleteEvent) => void;
    onWriteRejected?: (event: XtermRejectedWrite) => void;
    maxPendingWriteBytes?: number;
    fontSize: number;
    testID?: string;
}>;

const DEFAULT_FONT_FAMILY =
    'Menlo, ui-monospace, SFMono-Regular, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

const OUTPUT_PREVIEW_MAX_CHARS = 4096;
const READY_FIT_RETRY_DELAY_MS = 25;
const READY_FIT_MAX_RETRIES = 40;
const DISPOSE_AFTER_UNMOUNT_DELAY_MS = 50;

type TerminalWithInternalRenderer = Terminal & Readonly<{
    _core?: Readonly<{
        _renderService?: Readonly<{
            _renderer?: Readonly<{
                value?: unknown;
            }>;
        }>;
    }>;
}>;

type TerminalWithInternalViewport = Terminal & {
    _core?: {
        viewport?: {
            syncScrollArea?: (...args: unknown[]) => void;
        };
    };
};

function isXtermRendererReady(term: Terminal | null): boolean {
    const renderer = (term as TerminalWithInternalRenderer | null)?._core?._renderService?._renderer?.value;
    return renderer != null;
}

function suppressQueuedXtermViewportSync(term: Terminal): void {
    const viewport = (term as TerminalWithInternalViewport)._core?.viewport;
    if (typeof viewport?.syncScrollArea !== 'function') {
        return;
    }
    viewport.syncScrollArea = () => {};
}

export const XtermTerminalView = React.forwardRef<XtermTerminalHandle, XtermTerminalViewProps>(function XtermTerminalView(
    props,
    ref,
) {
    const { theme } = useUnistyles();
    const containerRef = React.useRef<HTMLDivElement | null>(null);
    const terminalRef = React.useRef<Terminal | null>(null);
    const fitAddonRef = React.useRef<FitAddon | null>(null);
    const writeQueueRef = React.useRef<XtermWriteQueue | null>(null);
    const resizeTimeoutRef = React.useRef<number | null>(null);
    const readyFitRetryTimeoutRef = React.useRef<number | null>(null);
    const readyFitRetryCountRef = React.useRef(0);
    const didReportReadyRef = React.useRef(false);
    const lastReportedSizeRef = React.useRef<{ cols: number; rows: number } | null>(null);

    const onInputRef = React.useRef(props.onInput);
    const onPasteRef = React.useRef(props.onPaste);
    const onLinkRef = React.useRef(props.onLink);
    const onResizeRef = React.useRef(props.onResize);
    const onReadyRef = React.useRef(props.onReady);
    const onWriteCompleteRef = React.useRef(props.onWriteComplete);
    const onWriteRejectedRef = React.useRef(props.onWriteRejected);
    const maxPendingWriteBytesRef = React.useRef(props.maxPendingWriteBytes ?? DEFAULT_XTERM_MAX_PENDING_WRITE_BYTES);
    onInputRef.current = props.onInput;
    onPasteRef.current = props.onPaste;
    onLinkRef.current = props.onLink;
    onResizeRef.current = props.onResize;
    onReadyRef.current = props.onReady;
    onWriteCompleteRef.current = props.onWriteComplete;
    onWriteRejectedRef.current = props.onWriteRejected;
    maxPendingWriteBytesRef.current = props.maxPendingWriteBytes ?? DEFAULT_XTERM_MAX_PENDING_WRITE_BYTES;

    const writeRafRef = React.useRef<number | null>(null);

    const outputPreviewRef = React.useRef('');
    const outputPreviewDirtyRef = React.useRef(false);

    const resetWriteState = React.useCallback(() => {
        writeQueueRef.current?.clear();
        outputPreviewRef.current = '';
        outputPreviewDirtyRef.current = false;
        if (containerRef.current) {
            containerRef.current.removeAttribute('data-happier-terminal-text');
        }
        if (writeRafRef.current !== null && typeof window !== 'undefined') {
            window.cancelAnimationFrame(writeRafRef.current);
        }
        writeRafRef.current = null;
    }, []);

    const applyOutputPreviewAttribute = React.useCallback(() => {
        if (!outputPreviewDirtyRef.current) {
            return;
        }
        const container = containerRef.current;
        if (!container) {
            return;
        }
        outputPreviewDirtyRef.current = false;
        container.setAttribute('data-happier-terminal-text', outputPreviewRef.current);
    }, []);

    const flushWrites = React.useCallback(() => {
        writeQueueRef.current?.flush();
    }, [applyOutputPreviewAttribute]);

    const scheduleFlushWrites = React.useCallback(() => {
        if (writeRafRef.current !== null) {
            return;
        }
        if (typeof window !== 'undefined') {
            writeRafRef.current = window.requestAnimationFrame(() => {
                writeRafRef.current = null;
                applyOutputPreviewAttribute();
                flushWrites();
            });
        } else {
            applyOutputPreviewAttribute();
            flushWrites();
        }
    }, [applyOutputPreviewAttribute, flushWrites]);

    const ensureWriteQueue = React.useCallback(() => {
        if (writeQueueRef.current) {
            return writeQueueRef.current;
        }
        writeQueueRef.current = createXtermWriteQueue({
            canWrite: () => terminalRef.current !== null,
            write: (data, callback) => {
                terminalRef.current?.write(data, callback);
            },
            schedule: () => scheduleFlushWrites(),
            maxPendingBytes: maxPendingWriteBytesRef.current,
            onReject: (event) => onWriteRejectedRef.current?.(event),
        });
        return writeQueueRef.current;
    }, [scheduleFlushWrites]);

    const appendOutputPreview = React.useCallback((data: string | Uint8Array) => {
        const preview = typeof data === 'string' ? data : decodeTerminalBytesForPreview(data);
        if (!preview) {
            return;
        }
        const nextPreview = outputPreviewRef.current + preview;
        outputPreviewRef.current =
            nextPreview.length > OUTPUT_PREVIEW_MAX_CHARS
                ? nextPreview.slice(nextPreview.length - OUTPUT_PREVIEW_MAX_CHARS)
                : nextPreview;
        outputPreviewDirtyRef.current = true;
    }, []);

    const enqueueWrite = React.useCallback((data: string) => {
        if (!data) {
            return true;
        }
        const accepted = ensureWriteQueue().enqueue({
            data,
            byteLength: estimateUtf8ByteLength(data),
        });
        if (!accepted) {
            return false;
        }
        appendOutputPreview(data);
        return true;
    }, [appendOutputPreview, ensureWriteQueue]);

    const enqueueWriteBytes = React.useCallback((input: XtermWriteBytesInput) => {
        if (input.bytes.byteLength === 0) {
            return true;
        }
        const bytes = copyTerminalBytes(input.bytes);
        const completion = buildXtermWriteCompleteEvent({ ...input, bytes });
        const accepted = ensureWriteQueue().enqueue({
            data: bytes,
            byteLength: bytes.byteLength,
            onComplete: () => onWriteCompleteRef.current?.(completion),
        });
        if (!accepted) {
            return false;
        }
        appendOutputPreview(bytes);
        return true;
    }, [appendOutputPreview, ensureWriteQueue]);

    const reportSize = React.useCallback((cols: number, rows: number, _kind: 'ready' | 'resize') => {
        const previous = lastReportedSizeRef.current;
        if (!previous || previous.cols !== cols || previous.rows !== rows) {
            lastReportedSizeRef.current = { cols, rows };
            onResizeRef.current(cols, rows);
        }
        if (!didReportReadyRef.current) {
            didReportReadyRef.current = true;
            onReadyRef.current(cols, rows);
        }
    }, []);

    const fitTerminal = React.useCallback((kind: 'ready' | 'resize') => {
        const fitAddon = fitAddonRef.current;
        const term = terminalRef.current;
        const container = containerRef.current;
        if (!fitAddon || !term || !container) {
            return false;
        }
        if (!term.element || !term.element.isConnected) {
            return false;
        }

        const rect = container.getBoundingClientRect();
        if (rect.width < 24 || rect.height < 24) {
            return false;
        }
        if (!isXtermRendererReady(term)) {
            return false;
        }

        try {
            fitAddon.fit();
            reportSize(term.cols, term.rows, kind);
            return true;
        } catch {
            return false;
        }
    }, [reportSize]);

    React.useImperativeHandle(ref, () => ({
        write: enqueueWrite,
        writeBytes: enqueueWriteBytes,
        clear: () => {
            const term = terminalRef.current;
            if (!term) {
                resetWriteState();
                return;
            }
            resetWriteState();
            term.clear();
            term.write('\x1b[2J\x1b[H');
        },
        focus: () => terminalRef.current?.focus(),
        hasSelection: () => terminalRef.current?.hasSelection() ?? false,
        getSelectionText: () => terminalRef.current?.getSelection() ?? '',
    }), [enqueueWrite, enqueueWriteBytes, resetWriteState]);

    React.useEffect(() => {
        const container = containerRef.current;
        if (!container) {
            return;
        }

        const term = new Terminal({
            cursorBlink: true,
            fontFamily: DEFAULT_FONT_FAMILY,
            fontSize: Math.max(8, Math.round(props.fontSize)),
            scrollback: 5000,
            screenReaderMode: true,
            theme: {
                background: theme.colors.surface.base,
                foreground: theme.colors.text.primary,
                cursor: theme.colors.text.primary,
                selectionBackground: theme.colors.surface.selected,
            },
        });
        terminalRef.current = term;
        ensureWriteQueue();

        const fitAddon = createXtermFitAddon();
        fitAddonRef.current = fitAddon;
        term.loadAddon(fitAddon);
        loadXtermWebLinksAddon(term, (uri) => onLinkRef.current?.(uri));
        tryLoadXtermWebglAddon(term);

        term.open(container);

        term.attachCustomKeyEventHandler((event) => {
            if (event.type !== 'keydown') {
                return true;
            }

            const key = String((event as KeyboardEvent).key ?? '').toLowerCase();
            const isCopy = (event.ctrlKey || event.metaKey) && key === 'c';
            const isPaste = (event.ctrlKey || event.metaKey) && key === 'v';

            if (isCopy && term.hasSelection()) {
                event.preventDefault();
                event.stopPropagation();

                const selection = term.getSelection();
                if (selection && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
                    void navigator.clipboard.writeText(selection).catch(() => {});
                } else if (typeof document !== 'undefined') {
                    try {
                        document.execCommand('copy');
                    } catch {
                        // ignored
                    }
                }

                return false;
            }

            if (isPaste) {
                event.preventDefault();
                event.stopPropagation();

                if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
                    navigator.clipboard
                        .readText()
                        .then((text) => {
                            if (!text) {
                                return;
                            }
                            void onPasteRef.current?.(text);
                        })
                        .catch(() => {});
                }

                return false;
            }

            return true;
        });

        const dataDisposable = term.onData((data) => {
            onInputRef.current(data);
        });

        const scheduleReadyFitRetry = () => {
            if (didReportReadyRef.current || readyFitRetryTimeoutRef.current !== null) {
                return;
            }
            if (readyFitRetryCountRef.current >= READY_FIT_MAX_RETRIES) {
                return;
            }
            readyFitRetryCountRef.current += 1;
            readyFitRetryTimeoutRef.current = window.setTimeout(() => {
                readyFitRetryTimeoutRef.current = null;
                if (!fitTerminal('ready')) {
                    scheduleReadyFitRetry();
                }
            }, READY_FIT_RETRY_DELAY_MS);
        };

        const initTimer = typeof window !== 'undefined'
            ? window.setTimeout(() => {
                if (!fitTerminal('ready')) {
                    scheduleReadyFitRetry();
                }
                term.focus();
                scheduleFlushWrites();
            }, 20)
            : null;

        const resizeObserver = typeof ResizeObserver !== 'undefined'
            ? new ResizeObserver(() => {
                if (resizeTimeoutRef.current !== null && typeof window !== 'undefined') {
                    window.clearTimeout(resizeTimeoutRef.current);
                }
                resizeTimeoutRef.current = typeof window !== 'undefined'
                    ? window.setTimeout(() => {
                        resizeTimeoutRef.current = null;
                        fitTerminal('resize');
                    }, 80)
                    : null;
            })
            : null;

        resizeObserver?.observe(container);

        return () => {
            dataDisposable.dispose();

            if (initTimer !== null && typeof window !== 'undefined') {
                window.clearTimeout(initTimer);
            }
            if (resizeTimeoutRef.current !== null && typeof window !== 'undefined') {
                window.clearTimeout(resizeTimeoutRef.current);
                resizeTimeoutRef.current = null;
            }
            if (readyFitRetryTimeoutRef.current !== null && typeof window !== 'undefined') {
                window.clearTimeout(readyFitRetryTimeoutRef.current);
                readyFitRetryTimeoutRef.current = null;
            }

            resizeObserver?.disconnect();

            resetWriteState();
            suppressQueuedXtermViewportSync(term);
            // xterm queues internal viewport sync work during open(); suppress stale callbacks before renderer teardown.
            if (typeof window !== 'undefined') {
                window.setTimeout(() => {
                    term.dispose();
                }, DISPOSE_AFTER_UNMOUNT_DELAY_MS);
            } else {
                term.dispose();
            }
            terminalRef.current = null;
            writeQueueRef.current = null;
            fitAddonRef.current = null;
            didReportReadyRef.current = false;
            readyFitRetryCountRef.current = 0;
            lastReportedSizeRef.current = null;
        };
    }, [ensureWriteQueue, fitTerminal, props.fontSize, props.maxPendingWriteBytes, resetWriteState, scheduleFlushWrites, theme.colors.surface.base, theme.colors.surface.selected, theme.colors.text.primary]);

    React.useEffect(() => {
        const term = terminalRef.current;
        if (!term) {
            return;
        }

        try {
            term.options.fontSize = Math.max(8, Math.round(props.fontSize));
            term.options.theme = {
                background: theme.colors.surface.base,
                foreground: theme.colors.text.primary,
                cursor: theme.colors.text.primary,
                selectionBackground: theme.colors.surface.selected,
            };
        } catch {
            // ignored
        }

        fitTerminal('resize');
    }, [fitTerminal, props.fontSize, theme.colors.surface.base, theme.colors.surface.selected, theme.colors.text.primary]);

    return (
        <div
            ref={containerRef}
            data-testid={props.testID}
            onMouseDownCapture={(event) => {
                if (event.button !== 0) {
                    return;
                }
                terminalRef.current?.focus();
            }}
            style={{
                width: '100%',
                height: '100%',
                minHeight: 0,
                minWidth: 0,
                overflow: 'hidden',
            }}
        />
    );
});
