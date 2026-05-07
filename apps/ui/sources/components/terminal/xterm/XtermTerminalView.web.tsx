import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';

import '@xterm/xterm/css/xterm.css';

export type XtermTerminalHandle = Readonly<{
    write: (data: string) => void;
    clear: () => void;
    focus: () => void;
    hasSelection: () => boolean;
    getSelectionText: () => string;
}>;

export type XtermTerminalViewProps = Readonly<{
    onInput: (data: string) => void;
    onResize: (cols: number, rows: number) => void;
    onReady: (cols: number, rows: number) => void;
    fontSize: number;
    testID?: string;
}>;

const DEFAULT_FONT_FAMILY =
    'Menlo, ui-monospace, SFMono-Regular, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

const OUTPUT_PREVIEW_MAX_CHARS = 4096;

export const XtermTerminalView = React.forwardRef<XtermTerminalHandle, XtermTerminalViewProps>(function XtermTerminalView(
    props,
    ref,
) {
    const { theme } = useUnistyles();
    const containerRef = React.useRef<HTMLDivElement | null>(null);
    const terminalRef = React.useRef<Terminal | null>(null);
    const fitAddonRef = React.useRef<FitAddon | null>(null);
    const resizeTimeoutRef = React.useRef<number | null>(null);
    const didReportReadyRef = React.useRef(false);
    const lastReportedSizeRef = React.useRef<{ cols: number; rows: number } | null>(null);

    const onInputRef = React.useRef(props.onInput);
    const onResizeRef = React.useRef(props.onResize);
    const onReadyRef = React.useRef(props.onReady);
    onInputRef.current = props.onInput;
    onResizeRef.current = props.onResize;
    onReadyRef.current = props.onReady;

    const pendingWriteRef = React.useRef('');
    const writeRafRef = React.useRef<number | null>(null);
    const isWritingRef = React.useRef(false);

    const outputPreviewRef = React.useRef('');
    const outputPreviewDirtyRef = React.useRef(false);

    const resetWriteState = React.useCallback(() => {
        pendingWriteRef.current = '';
        outputPreviewRef.current = '';
        outputPreviewDirtyRef.current = false;
        if (containerRef.current) {
            containerRef.current.removeAttribute('data-happier-terminal-text');
        }
        if (writeRafRef.current !== null && typeof window !== 'undefined') {
            window.cancelAnimationFrame(writeRafRef.current);
        }
        writeRafRef.current = null;
        isWritingRef.current = false;
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
        if (isWritingRef.current) {
            return;
        }
        const term = terminalRef.current;
        if (!term) {
            return;
        }
        if (!pendingWriteRef.current) {
            return;
        }

        const chunk = pendingWriteRef.current;
        pendingWriteRef.current = '';

        isWritingRef.current = true;
        term.write(chunk, () => {
            isWritingRef.current = false;
            if (!pendingWriteRef.current) {
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
        });
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

    const enqueueWrite = React.useCallback((data: string) => {
        if (!data) {
            return;
        }
        pendingWriteRef.current += data;
        const nextPreview = outputPreviewRef.current + data;
        outputPreviewRef.current =
            nextPreview.length > OUTPUT_PREVIEW_MAX_CHARS
                ? nextPreview.slice(nextPreview.length - OUTPUT_PREVIEW_MAX_CHARS)
                : nextPreview;
        outputPreviewDirtyRef.current = true;
        scheduleFlushWrites();
    }, [scheduleFlushWrites]);

    const reportSize = React.useCallback((cols: number, rows: number, kind: 'ready' | 'resize') => {
        const previous = lastReportedSizeRef.current;
        if (!previous || previous.cols !== cols || previous.rows !== rows) {
            lastReportedSizeRef.current = { cols, rows };
            onResizeRef.current(cols, rows);
        }
        if (kind === 'ready' && !didReportReadyRef.current) {
            didReportReadyRef.current = true;
            onReadyRef.current(cols, rows);
        }
    }, []);

    const fitTerminal = React.useCallback((kind: 'ready' | 'resize') => {
        const fitAddon = fitAddonRef.current;
        const term = terminalRef.current;
        const container = containerRef.current;
        if (!fitAddon || !term || !container) {
            return;
        }

        const rect = container.getBoundingClientRect();
        if (rect.width < 24 || rect.height < 24) {
            return;
        }

        try {
            fitAddon.fit();
            reportSize(term.cols, term.rows, kind);
        } catch {
            // ignored
        }
    }, [reportSize]);

    React.useImperativeHandle(ref, () => ({
        write: enqueueWrite,
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
    }), [enqueueWrite, resetWriteState]);

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
            screenReaderMode: false,
            theme: {
                background: theme.colors.surface,
                foreground: theme.colors.text,
                cursor: theme.colors.text,
                selectionBackground: theme.colors.surfaceSelected,
            },
        });
        terminalRef.current = term;

        const fitAddon = new FitAddon();
        fitAddonRef.current = fitAddon;
        term.loadAddon(fitAddon);
        term.loadAddon(new WebLinksAddon());
        try {
            term.loadAddon(new WebglAddon());
        } catch {
            // WebGL renderer unavailable; fall back to canvas.
        }

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
                            onInputRef.current(text);
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

        const initTimer = typeof window !== 'undefined'
            ? window.setTimeout(() => {
                fitTerminal('ready');
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

            resizeObserver?.disconnect();

            term.dispose();
            terminalRef.current = null;
            fitAddonRef.current = null;
            didReportReadyRef.current = false;
            lastReportedSizeRef.current = null;
            resetWriteState();
        };
    }, [fitTerminal, props.fontSize, resetWriteState, scheduleFlushWrites, theme.colors.surface, theme.colors.surfaceSelected, theme.colors.text]);

    React.useEffect(() => {
        const term = terminalRef.current;
        if (!term) {
            return;
        }

        try {
            term.options.fontSize = Math.max(8, Math.round(props.fontSize));
            term.options.theme = {
                background: theme.colors.surface,
                foreground: theme.colors.text,
                cursor: theme.colors.text,
                selectionBackground: theme.colors.surfaceSelected,
            };
        } catch {
            // ignored
        }

        fitTerminal('resize');
    }, [fitTerminal, props.fontSize, theme.colors.surface, theme.colors.surfaceSelected, theme.colors.text]);

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
