import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import type { FitAddon } from '@xterm/addon-fit';
import type { EmbeddedTerminalRendererHandle, EmbeddedTerminalRendererResource, FindEngine, EmbeddedTerminalCursorRow, EmbeddedTerminalWriteOptions } from '../embedded/embeddedTerminalRendererHandle';
import { Terminal } from '@xterm/xterm';
import { XtermRetainedResource } from './retainedResource';

import '@xterm/xterm/css/xterm.css';
import { XTERM_READABILITY_OPTIONS } from './readability';
import { registerXtermReadOnlyCursorPolicy, resolveXtermCursorAppearance } from './cursorAppearance';
import { useGlassSurfaceColor } from '@/components/ui/glass/useGlassSurfaceColor';
import {
    buildTerminalRendererInteractionContract,
    readRendererSelection,
    resolveRendererCommittedInput,
    shouldConsumeTerminalControlSequence,
    shouldRendererCaptureKeyboard,
} from '@/components/terminal/interaction/rendererContract';
import {
    createXtermFitAddon,
    loadXtermSearchAddon,
    loadXtermWebLinksAddon,
    tryLoadXtermWebglAddon,
} from './addons';
import { resolveXtermFindColors } from './findColors';
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

export type XtermTerminalHandle = Pick<EmbeddedTerminalRendererHandle,
    'captureResource' | 'restoreResource' | 'hasRetainedOutput'> & Readonly<{
    find?: FindEngine;
    write: (data: string, options?: EmbeddedTerminalWriteOptions) => boolean;
    writeBytes: (input: XtermWriteBytesInput) => boolean | Readonly<{ status: 'queued' }>;
    clear: () => void;
    focus: () => void;
    hasSelection: () => boolean;
    getSelectionText: () => string;
    /** The user's selected buffer rows and the selection's on-screen box (window coordinates), or null (none, or a Find match). */
    getSelectionRange?: () => XtermSelectionRange | null;
}>;

export type XtermSelectionRange = Readonly<{
    startRow: number;
    endRow: number;
    rect: Readonly<{ x: number; y: number; width: number; height: number }>;
}>;

export type XtermTerminalViewProps = Readonly<{
    /** The controller's already-authorized parsed renderer, adopted before activation reports ready. */
    retainedResource?: EmbeddedTerminalRendererResource;
    onFindEngine?: (engine: FindEngine | null) => void;
    onInput: (data: string) => void;
    onPaste?: (data: string) => void | Promise<unknown>;
    onCopySelection?: (text: string) => void;
    onSelectionChange?: () => void;
    onLink?: (url: string) => void;
    onResize: (cols: number, rows: number) => void;
    onReady: (cols: number, rows: number) => void;
    onWriteComplete?: (event: XtermWriteCompleteEvent) => void;
    onWriteRejected?: (event: XtermRejectedWrite) => void;
    onCursorRowChange?: (row: EmbeddedTerminalCursorRow | null) => void;
    /** Height in px the retained output needs: down to its last non-empty line or the cursor row, whichever is lower. */
    onContentHeightChange?: (height: number) => void;
    maxPendingWriteBytes?: number;
    fontSize: number;
    readOnly?: boolean;
    lineHeight?: number;
    testID?: string;
}>;

const DEFAULT_FONT_FAMILY =
    'Menlo, ui-monospace, SFMono-Regular, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

const OUTPUT_PREVIEW_MAX_CHARS = 4096;
const READY_FIT_RETRY_DELAY_MS = 25;
const READY_FIT_MAX_RETRIES = 40;
const DISPOSE_AFTER_UNMOUNT_DELAY_MS = 50;
const XTERM_INTERACTION_CONTRACT = buildTerminalRendererInteractionContract('xterm-web');

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

const XTERM_TRANSPARENT_BACKGROUND = '#00000000';

export const XtermTerminalView = React.forwardRef<XtermTerminalHandle, XtermTerminalViewProps>(function XtermTerminalView(
    props,
    ref,
) {
    const { theme } = useUnistyles();
    // The pane frame already paints the content material (glass or solid) behind the terminal, so the
    // terminal paints none of its own. xterm resolves the CSS keyword `transparent` to opaque black (its
    // viewport and WebGL clear), which hides the foreground ink on a light page; an explicit zero-alpha
    // colour stays transparent.
    const backgroundColor = XTERM_TRANSPARENT_BACKGROUND;
    const selectionBackgroundColor = useGlassSurfaceColor(theme.colors.surface.selected, 'content', false);
    const backgroundColorRef = React.useRef(backgroundColor);
    backgroundColorRef.current = backgroundColor;
    const selectionBackgroundColorRef = React.useRef(selectionBackgroundColor);
    selectionBackgroundColorRef.current = selectionBackgroundColor;
    const containerRef = React.useRef<HTMLDivElement | null>(null);
    const terminalRef = React.useRef<Terminal | null>(null);
    const resourceRef = React.useRef<XtermRetainedResource | null>(null);
    const activeHostRef = React.useRef<HTMLDivElement | null>(null);
    const currentPropsRef = React.useRef(props);
    currentPropsRef.current = props;
    const pendingWritesRef = React.useRef(0);
    const settledWaitersRef = React.useRef<Array<() => void>>([]);
    const completePendingWrite = React.useCallback(() => {
        pendingWritesRef.current = Math.max(0, pendingWritesRef.current - 1);
        if (pendingWritesRef.current === 0) {
            for (const resolve of settledWaitersRef.current.splice(0)) resolve();
        }
    }, []);
    const readOnlyRef = React.useRef(props.readOnly === true);
    readOnlyRef.current = props.readOnly === true;
    const findRef = React.useRef<ReturnType<typeof loadXtermSearchAddon> | null>(null);
    const onFindEngineRef = React.useRef(props.onFindEngine);
    onFindEngineRef.current = props.onFindEngine;
    const fitAddonRef = React.useRef<FitAddon | null>(null);
    const writeQueueRef = React.useRef<XtermWriteQueue | null>(null);
    const replayWritesInFlightRef = React.useRef(0);
    const resizeTimeoutRef = React.useRef<number | null>(null);
    const readyFitRetryTimeoutRef = React.useRef<number | null>(null);
    const readyFitRetryCountRef = React.useRef(0);
    const didReportReadyRef = React.useRef(false);
    const lastReportedSizeRef = React.useRef<{ cols: number; rows: number } | null>(null);

    const onInputRef = React.useRef(props.onInput);
    const onPasteRef = React.useRef(props.onPaste);
    const onCopySelectionRef = React.useRef(props.onCopySelection);
    const onSelectionChangeRef = React.useRef(props.onSelectionChange);
    onSelectionChangeRef.current = props.onSelectionChange;
    const onLinkRef = React.useRef(props.onLink);
    const onResizeRef = React.useRef(props.onResize);
    const onReadyRef = React.useRef(props.onReady);
    const onWriteCompleteRef = React.useRef(props.onWriteComplete);
    const onWriteRejectedRef = React.useRef(props.onWriteRejected);
    const onCursorRowChangeRef = React.useRef(props.onCursorRowChange);
    onCursorRowChangeRef.current = props.onCursorRowChange;
    const onContentHeightChangeRef = React.useRef(props.onContentHeightChange);
    onContentHeightChangeRef.current = props.onContentHeightChange;
    const maxPendingWriteBytesRef = React.useRef(props.maxPendingWriteBytes ?? DEFAULT_XTERM_MAX_PENDING_WRITE_BYTES);
    onInputRef.current = props.onInput;
    onPasteRef.current = props.onPaste;
    onCopySelectionRef.current = props.onCopySelection;
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
        pendingWritesRef.current = 0;
        for (const resolve of settledWaitersRef.current.splice(0)) resolve();
        outputPreviewRef.current = '';
        outputPreviewDirtyRef.current = false;
        if (containerRef.current) {
            containerRef.current.removeAttribute('data-happier-terminal-text');
        }
        activeHostRef.current?.removeAttribute('data-happier-terminal-text');
        if (writeRafRef.current !== null && typeof window !== 'undefined') {
            window.cancelAnimationFrame(writeRafRef.current);
        }
        writeRafRef.current = null;
    }, []);

    const applyOutputPreviewAttribute = React.useCallback(() => {
        if (!outputPreviewDirtyRef.current) {
            return;
        }
        const container = activeHostRef.current ?? containerRef.current;
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
            write: (data, callback, options) => {
                const term = terminalRef.current;
                if (!term) return;
                const replay = options?.intent === 'replay';
                if (replay) replayWritesInFlightRef.current += 1;
                term.write(data, () => {
                    if (replay && terminalRef.current === term) replayWritesInFlightRef.current -= 1;
                    callback();
                });
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

    const enqueueWrite = React.useCallback((data: string, options?: EmbeddedTerminalWriteOptions) => {
        if (!data) {
            return true;
        }
        pendingWritesRef.current += 1;
        const accepted = ensureWriteQueue().enqueue({
            data,
            byteLength: estimateUtf8ByteLength(data),
            options,
            onComplete: completePendingWrite,
        });
        if (!accepted) {
            completePendingWrite();
            return false;
        }
        appendOutputPreview(data);
        // Retained hydration is already available. Submit it now rather than waiting
        // for the live-output batching frame before xterm's own asynchronous parser.
        if (options?.intent === 'replay') {
            applyOutputPreviewAttribute();
            ensureWriteQueue().flush();
        }
        return true;
    }, [appendOutputPreview, applyOutputPreviewAttribute, completePendingWrite, ensureWriteQueue]);

    const enqueueWriteBytes = React.useCallback((input: XtermWriteBytesInput) => {
        if (input.bytes.byteLength === 0) {
            return true;
        }
        const bytes = copyTerminalBytes(input.bytes);
        const completion = buildXtermWriteCompleteEvent({ ...input, bytes });
        pendingWritesRef.current += 1;
        const accepted = ensureWriteQueue().enqueue({
            data: bytes,
            byteLength: bytes.byteLength,
            onComplete: () => {
                onWriteCompleteRef.current?.(completion);
                completePendingWrite();
            },
        });
        if (!accepted) {
            completePendingWrite();
            return false;
        }
        appendOutputPreview(bytes);
        // The stream already waits for this parser completion before sending
        // the next frame. A separate animation-frame wait paces retained replay.
        ensureWriteQueue().flush();
        return { status: 'queued' } as const;
    }, [appendOutputPreview, completePendingWrite, ensureWriteQueue]);

    const reportSize = React.useCallback((cols: number, rows: number, _kind: 'ready' | 'resize') => {
        const host = activeHostRef.current ?? containerRef.current;
        host?.setAttribute('data-happier-terminal-cols', String(cols));
        host?.setAttribute('data-happier-terminal-rows', String(rows));
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

    const applyAppearanceRef = React.useRef<() => void>(() => {});
    applyAppearanceRef.current = () => {
        const term = terminalRef.current;
        if (!term) return;
        try {
            const cursor = resolveXtermCursorAppearance(props.readOnly === true, theme.colors.text.primary);
            // Application cursor commands remain authoritative while writable. Only a change
            // in host input eligibility replaces them with the hidden/default cursor options.
            if (term.options.disableStdin !== (props.readOnly === true)) {
                Object.assign(term.options, cursor.options);
            }
            term.options.fontSize = Math.max(8, Math.round(props.fontSize));
            term.options.lineHeight = props.lineHeight ?? 1.35;
            term.options.theme = {
                background: backgroundColor,
                foreground: theme.colors.text.primary,
                cursor: cursor.color,
                selectionBackground: selectionBackgroundColor,
            };
            findRef.current?.setColors(resolveXtermFindColors(theme.colors.find, theme.colors.surface.base));
        } catch {
            // ignored
        }
        fitTerminal('resize');
    };

    const localHandle = React.useMemo<XtermTerminalHandle>(() => ({
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
        get find() { return findRef.current ?? undefined; },
        hasSelection: () => terminalRef.current?.hasSelection() ?? false,
        getSelectionText: () => terminalRef.current?.getSelection() ?? '',
        getSelectionRange: () => {
            const term = terminalRef.current;
            // A Find step marks its match by selecting it; that is not text the user chose to act on.
            if (findRef.current?.ownsSelection()) return null;
            const position = term?.hasSelection() ? term.getSelectionPosition() : undefined;
            const screen = term?.element?.querySelector('.xterm-screen');
            if (!term || !position || !screen) return null;
            const box = screen.getBoundingClientRect();
            const rowHeight = box.height / term.rows;
            const cellWidth = box.width / term.cols;
            const top = position.start.y - term.buffer.active.viewportY;
            const left = Math.min(position.start.x, position.end.x);
            return {
                startRow: position.start.y + 1,
                endRow: position.end.y + 1,
                rect: {
                    x: box.left + left * cellWidth,
                    y: box.top + Math.max(0, top) * rowHeight,
                    width: Math.max(cellWidth, Math.abs(position.end.x - position.start.x) * cellWidth),
                    height: rowHeight * (position.end.y - position.start.y + 1),
                },
            };
        },
    }), [enqueueWrite, enqueueWriteBytes, resetWriteState]);

    React.useImperativeHandle(ref, () => ({
        write: (...args) => (resourceRef.current?.runtime.handle ?? localHandle).write(...args),
        writeBytes: (...args) => (resourceRef.current?.runtime.handle ?? localHandle).writeBytes(...args),
        clear: () => (resourceRef.current?.runtime.handle ?? localHandle).clear(),
        focus: () => (resourceRef.current?.runtime.handle ?? localHandle).focus(),
        hasSelection: () => (resourceRef.current?.runtime.handle ?? localHandle).hasSelection(),
        getSelectionText: () => (resourceRef.current?.runtime.handle ?? localHandle).getSelectionText(),
        getSelectionRange: () => (resourceRef.current?.runtime.handle ?? localHandle).getSelectionRange?.() ?? null,
        get find() { return resourceRef.current?.runtime.find ?? localHandle.find; },
        captureResource: () => {
            const resource = resourceRef.current;
            if (!resource) throw new Error('Terminal renderer is not mounted');
            return resource.capture();
        },
        restoreResource: (resource) => {
            if (resourceRef.current === resource) return true;
            if (!(resource instanceof XtermRetainedResource) || !resource.canAttach()) return false;
            const host = containerRef.current;
            if (!host) return false;
            const current = resourceRef.current;
            current?.detach();
            if (!resource.attach(host, currentPropsRef.current)) return false;
            resourceRef.current = resource;
            terminalRef.current = resource.runtime.terminal;
            fitAddonRef.current = resource.runtime.fitAddon;
            findRef.current = resource.runtime.find;
            applyAppearanceRef.current();
            return true;
        },
        hasRetainedOutput: () => resourceRef.current?.retained === true,
    }), [localHandle]);

    React.useLayoutEffect(() => {
        const container = containerRef.current;
        if (!container) {
            return;
        }
        activeHostRef.current = container;

        const retained = props.retainedResource;
        if (retained instanceof XtermRetainedResource && retained.canAttach()) {
            resourceRef.current = retained;
            terminalRef.current = retained.runtime.terminal;
            fitAddonRef.current = retained.runtime.fitAddon;
            findRef.current = retained.runtime.find;
            retained.attach(container, props);
            applyAppearanceRef.current();
            return () => {
                retained.detach();
                resourceRef.current = null;
            };
        }

        const cursor = resolveXtermCursorAppearance(props.readOnly === true, theme.colors.text.primary);
        const term = new Terminal({
            allowProposedApi: true,
            allowTransparency: true,
            ...cursor.options,
            fontFamily: DEFAULT_FONT_FAMILY,
            fontSize: Math.max(8, Math.round(props.fontSize)),
            lineHeight: props.lineHeight ?? 1.35,
            ...XTERM_READABILITY_OPTIONS,
            scrollback: 5000,
            screenReaderMode: XTERM_INTERACTION_CONTRACT.screenReaderMode,
            theme: {
                background: backgroundColorRef.current,
                foreground: theme.colors.text.primary,
                cursor: cursor.color,
                selectionBackground: selectionBackgroundColorRef.current,
            },
        });
        terminalRef.current = term;
        ensureWriteQueue();

        const fitAddon = createXtermFitAddon();
        fitAddonRef.current = fitAddon;
        term.loadAddon(fitAddon);
        loadXtermWebLinksAddon(term, (uri) => onLinkRef.current?.(uri));
        tryLoadXtermWebglAddon(term);

        replayWritesInFlightRef.current = 0;
        term.open(container);
        const cursorPolicy = registerXtermReadOnlyCursorPolicy(term, () => readOnlyRef.current);
        const find = loadXtermSearchAddon(term, resolveXtermFindColors(theme.colors.find, theme.colors.surface.base));
        findRef.current = find;
        onFindEngineRef.current?.(find);

        const reportCursorRow = () => {
            if (!onCursorRowChangeRef.current) return;
            const buffer = term.buffer.active;
            const row = buffer.baseY + buffer.cursorY - buffer.viewportY;
            const screen = term.element?.querySelector('.xterm-screen') ?? container;
            const rect = screen.getBoundingClientRect();
            const height = rect.height / term.rows;
            onCursorRowChangeRef.current(row >= 0 && row < term.rows && height > 0
                ? { top: rect.top - container.getBoundingClientRect().top + row * height, height }
                : null);
        };
        const reportContentHeight = () => {
            if (!onContentHeightChangeRef.current) return;
            const buffer = term.buffer.active;
            let lastRow = buffer.baseY + buffer.cursorY;
            for (let row = buffer.length - 1; row > lastRow; row -= 1) {
                if (buffer.getLine(row)?.translateToString(true)) {
                    lastRow = row;
                    break;
                }
            }
            const screen = term.element?.querySelector('.xterm-screen') ?? container;
            const rowHeight = screen.getBoundingClientRect().height / term.rows;
            if (rowHeight > 0) onContentHeightChangeRef.current((lastRow + 1) * rowHeight);
        };
        const writeParsedDisposable = term.onWriteParsed(reportContentHeight);
        const cursorDisposable = term.onCursorMove(reportCursorRow);
        const selectionDisposable = term.onSelectionChange(() => onSelectionChangeRef.current?.());
        const scrollDisposable = term.onScroll(reportCursorRow);
        const sizeDisposable = term.onResize(reportCursorRow);

        const osc52Disposable = term.parser.registerOscHandler(52, () => (
            shouldConsumeTerminalControlSequence(XTERM_INTERACTION_CONTRACT, 'osc52')
        ));
        const itermImageDisposable = term.parser.registerOscHandler(1337, () => (
            shouldConsumeTerminalControlSequence(XTERM_INTERACTION_CONTRACT, 'iterm2-images')
        ));
        const sixelDisposable = term.parser.registerDcsHandler({ final: 'q' }, () => (
            shouldConsumeTerminalControlSequence(XTERM_INTERACTION_CONTRACT, 'sixel')
        ));

        const focusFromPointer = () => {
            if (XTERM_INTERACTION_CONTRACT.mouseCaptureEnabled) {
                term.focus();
            }
        };
        container.addEventListener('pointerdown', focusFromPointer, true);

        const handlePaste = (event: ClipboardEvent) => {
            const text = event.clipboardData?.getData('text/plain') ?? '';
            if (!text) return;
            event.preventDefault();
            event.stopPropagation();
            void onPasteRef.current?.(text);
        };
        container.addEventListener('paste', handlePaste, true);

        term.attachCustomKeyEventHandler((event) => {
            if (event.defaultPrevented) return false;
            if (event.type !== 'keydown') {
                return true;
            }

            const key = String((event as KeyboardEvent).key ?? '').toLowerCase();
            const isCopy = (event.ctrlKey || event.metaKey) && key === 'c';
            const isPaste = (event.ctrlKey || event.metaKey) && key === 'v';
            const modifiers = [
                ...(event.shiftKey ? ['shift' as const] : []),
                ...(event.ctrlKey ? ['ctrl' as const] : []),
                ...(event.altKey ? ['alt' as const] : []),
                ...(event.metaKey ? ['meta' as const] : []),
            ];

            const selection = readRendererSelection({
                hasSelection: () => term.hasSelection(),
                getSelectionText: () => term.getSelection(),
            });
            if (!shouldRendererCaptureKeyboard({ key, modifiers }) && isCopy && selection.hasSelection) {
                event.preventDefault();
                event.stopPropagation();

                if (selection.text && onCopySelectionRef.current) {
                    onCopySelectionRef.current(selection.text);
                } else if (selection.text && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
                    void navigator.clipboard.writeText(selection.text).catch(() => {});
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
            if (replayWritesInFlightRef.current > 0) return;
            const committed = resolveRendererCommittedInput(data);
            if (committed) {
                onInputRef.current(committed);
            }
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

        if (!fitTerminal('ready')) scheduleReadyFitRetry();
        term.focus();
        scheduleFlushWrites();

        const resizeObserver = typeof ResizeObserver !== 'undefined'
            ? new ResizeObserver(() => {
                if (resizeTimeoutRef.current !== null && typeof window !== 'undefined') {
                    window.clearTimeout(resizeTimeoutRef.current);
                }
                resizeTimeoutRef.current = typeof window !== 'undefined'
                    ? window.setTimeout(() => {
                        resizeTimeoutRef.current = null;
                        fitTerminal('resize');
                        reportCursorRow();
                    }, 80)
                    : null;
            })
            : null;

        resizeObserver?.observe(container);

        const destroy = () => {
            onFindEngineRef.current?.(null);
            find.dispose();
            findRef.current = null;
            dataDisposable.dispose();
            cursorDisposable.dispose();
            writeParsedDisposable.dispose();
            selectionDisposable.dispose();
            scrollDisposable.dispose();
            sizeDisposable.dispose();
            osc52Disposable.dispose();
            itermImageDisposable.dispose();
            sixelDisposable.dispose();
            cursorPolicy.dispose();
            container.removeEventListener('paste', handlePaste, true);
            container.removeEventListener('pointerdown', focusFromPointer, true);

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
        const resource = new XtermRetainedResource({
            container,
            terminal: term,
            fitAddon,
            find,
            handle: localHandle,
            whenSettled: () => {
                writeQueueRef.current?.flush();
                return pendingWritesRef.current === 0 ? Promise.resolve()
                    : new Promise<void>((resolve) => settledWaitersRef.current.push(resolve));
            },
            bind: (next) => {
                onInputRef.current = next.onInput;
                onPasteRef.current = next.onPaste;
                onCopySelectionRef.current = next.onCopySelection;
                onSelectionChangeRef.current = next.onSelectionChange;
                onLinkRef.current = next.onLink;
                onResizeRef.current = next.onResize;
                onReadyRef.current = next.onReady;
                onWriteCompleteRef.current = next.onWriteComplete;
                onWriteRejectedRef.current = next.onWriteRejected;
                onCursorRowChangeRef.current = next.onCursorRowChange;
                onContentHeightChangeRef.current = next.onContentHeightChange;
                onFindEngineRef.current = next.onFindEngine;
                readOnlyRef.current = next.readOnly === true;
            },
            attach: (host) => {
                containerRef.current = container;
                activeHostRef.current = host;
                didReportReadyRef.current = false;
                lastReportedSizeRef.current = null;
                outputPreviewDirtyRef.current = true;
                applyOutputPreviewAttribute();
                container.addEventListener('paste', handlePaste, true);
                container.addEventListener('pointerdown', focusFromPointer, true);
                resizeObserver?.observe(container);
                onFindEngineRef.current?.(find);
                term.focus();
                fitTerminal('ready');
                reportContentHeight();
                reportCursorRow();
            },
            detach: () => {
                term.blur();
                container.removeEventListener('paste', handlePaste, true);
                container.removeEventListener('pointerdown', focusFromPointer, true);
                resizeObserver?.disconnect();
                if (resizeTimeoutRef.current !== null) window.clearTimeout(resizeTimeoutRef.current);
                if (readyFitRetryTimeoutRef.current !== null) window.clearTimeout(readyFitRetryTimeoutRef.current);
                resizeTimeoutRef.current = null;
                readyFitRetryTimeoutRef.current = null;
                onFindEngineRef.current?.(null);
                onInputRef.current = () => {};
                onPasteRef.current = undefined;
                onCopySelectionRef.current = undefined;
                onLinkRef.current = undefined;
                onSelectionChangeRef.current = undefined;
                onResizeRef.current = () => {};
                onReadyRef.current = () => {};
                onCursorRowChangeRef.current = undefined;
                onContentHeightChangeRef.current = undefined;
                activeHostRef.current = null;
                // Pending parser callbacks still publish their exact applied cursor before handoff.
                writeQueueRef.current?.flush();
            },
            destroy,
        });
        resourceRef.current = resource;
        return () => {
            resourceRef.current?.detach();
            resourceRef.current = null;
        };
    // Appearance updates below change the existing terminal's options. Recreating it here
    // discards retained output behind the same renderer handle, so the controller cannot
    // distinguish the empty replacement from the renderer it has already hydrated.
    }, [applyOutputPreviewAttribute, ensureWriteQueue, fitTerminal, localHandle, props.maxPendingWriteBytes, resetWriteState, scheduleFlushWrites]);

    React.useLayoutEffect(() => {
        resourceRef.current?.bind(props);
    });

    React.useEffect(() => {
        applyAppearanceRef.current();
    }, [backgroundColor, selectionBackgroundColor, fitTerminal, props.fontSize, props.lineHeight, props.readOnly, theme.colors.text.primary, theme.colors.find, theme.colors.surface.base]);

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
                // xterm's canvases carry their own z-index; keeping them in this stacking context stops
                // the link layer from sitting over controls that overlap the terminal (the phone tab bar).
                isolation: 'isolate',
            }}
        />
    );
});
