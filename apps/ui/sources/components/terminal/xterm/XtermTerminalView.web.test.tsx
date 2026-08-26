/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTerminalStreamRuntime } from '@/sync/domains/terminal/stream/runtime';

import type { XtermTerminalHandle } from './XtermTerminalView.web';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fitSpy = vi.fn();
const focusSpy = vi.fn();
const loadAddonSpy = vi.fn();
const openSpy = vi.fn();
const attachCustomKeyEventHandlerSpy = vi.fn();
const onDataSpy = vi.fn();
const disposeSpy = vi.fn();
let webLinksHandler: ((event: MouseEvent, uri: string) => void) | null = null;
let renderServiceRendererValue: unknown = {};
const terminalConstructorOptions: Record<string, unknown>[] = [];
const terminalInstances: MockTerminal[] = [];
let deferWriteCallbacks = false;
const pendingWriteCallbacks: Array<() => void> = [];
let scheduleInternalViewportSync = false;
let internalViewportSyncDelayMs = 0;
const delayedViewportSyncAfterDisposeSpy = vi.fn();
const deferredDisposeDrainMs = 80;

function requireTerminalHandle(ref: React.RefObject<XtermTerminalHandle | null>): XtermTerminalHandle {
    if (!ref.current) {
        throw new Error('terminal handle missing');
    }
    return ref.current;
}

function createClipboardPasteEvent(text: string): ClipboardEvent {
    const event = typeof ClipboardEvent === 'function'
        ? new ClipboardEvent('paste', { bubbles: true, cancelable: true })
        : new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', {
        configurable: true,
        value: {
            getData: (format: string) => format === 'text/plain' ? text : '',
        },
    });
    return event;
}

class MockTerminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    element: HTMLElement | null = null;
    textarea: HTMLTextAreaElement | null = null;
    disposed = false;
    _core = {
        viewport: {
            syncScrollArea: () => {
                if (this.disposed) {
                    delayedViewportSyncAfterDisposeSpy();
                }
            },
        },
        _renderService: {
            _renderer: {
                value: renderServiceRendererValue,
            },
        },
    };

    constructor(options: Record<string, unknown> = {}) {
        this.options = options;
        terminalConstructorOptions.push(options);
        terminalInstances.push(this);
    }

    loadAddon = loadAddonSpy;
    open = vi.fn((container: HTMLElement) => {
        this.element = container;
        this.textarea = document.createElement('textarea');
        // Match xterm's real plain-text paste boundary: its handler feeds paste through onData.
        this.textarea.addEventListener('paste', (event) => {
            event.stopPropagation();
            const text = event.clipboardData?.getData('text/plain') ?? '';
            if (text) {
                onDataSpy(text);
            }
        });
        container.appendChild(this.textarea);
        openSpy(container);
        if (scheduleInternalViewportSync) {
            window.setTimeout(() => {
                this._core.viewport.syncScrollArea();
            }, internalViewportSyncDelayMs);
        }
    });
    focus = focusSpy;
    clear = vi.fn();
    hasSelection = vi.fn(() => false);
    getSelection = vi.fn(() => '');
    attachCustomKeyEventHandler = attachCustomKeyEventHandlerSpy;
    write = vi.fn((_data: string | Uint8Array, callback?: () => void) => {
        if (!callback) {
            return;
        }
        if (deferWriteCallbacks) {
            pendingWriteCallbacks.push(callback);
            return;
        }
        callback();
    });
    dispose = vi.fn(() => {
        this.disposed = true;
        disposeSpy();
    });

    onData(callback: (data: string) => void) {
        onDataSpy.mockImplementation(callback);
        return { dispose: vi.fn() };
    }
}

vi.mock('@xterm/xterm', () => ({
    Terminal: MockTerminal,
}));

vi.mock('@xterm/addon-fit', () => ({
    FitAddon: class {
        fit = fitSpy;
    },
}));

vi.mock('@xterm/addon-web-links', () => ({
    WebLinksAddon: class {
        constructor(handler?: (event: MouseEvent, uri: string) => void) {
            webLinksHandler = handler ?? null;
        }
    },
}));

vi.mock('@xterm/addon-webgl', () => ({
    WebglAddon: class {},
}));

vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                surface: '#000000',
                surfaceSelected: '#333333',
                text: '#ffffff',
            },
        },
    });
});

describe('XtermTerminalView.web', () => {
    let container: HTMLDivElement;
    let root: ReturnType<typeof createRoot>;
    let originalGetBoundingClientRect: typeof HTMLElement.prototype.getBoundingClientRect;

    beforeEach(() => {
        fitSpy.mockReset();
        focusSpy.mockReset();
        loadAddonSpy.mockReset();
        openSpy.mockReset();
        attachCustomKeyEventHandlerSpy.mockReset();
        onDataSpy.mockReset();
        disposeSpy.mockReset();
        webLinksHandler = null;
        renderServiceRendererValue = {};
        terminalConstructorOptions.length = 0;
        terminalInstances.length = 0;
        pendingWriteCallbacks.length = 0;
        deferWriteCallbacks = false;
        scheduleInternalViewportSync = false;
        internalViewportSyncDelayMs = 0;
        delayedViewportSyncAfterDisposeSpy.mockReset();
        originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
        HTMLElement.prototype.getBoundingClientRect = vi.fn(() => ({
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            bottom: 320,
            right: 480,
            width: 480,
            height: 320,
            toJSON: () => ({}),
        })) as typeof HTMLElement.prototype.getBoundingClientRect;
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => {
            root.unmount();
            await new Promise((resolve) => setTimeout(resolve, deferredDisposeDrainMs));
        });
        HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
        container.remove();
    });

    it('refocuses the terminal when the web container receives mouse down', async () => {
        const { XtermTerminalView } = await import('./XtermTerminalView.web');

        await act(async () => {
            root.render(
                <XtermTerminalView
                    testID="terminal"
                    fontSize={14}
                    onInput={() => {}}
                    onResize={() => {}}
                    onReady={() => {}}
                />,
            );
        });

        await act(async () => {
            await new Promise((resolve) => {
                setTimeout(resolve, 40);
            });
        });

        const terminalContainer = container.querySelector('[data-testid="terminal"]');
        expect(terminalContainer).not.toBeNull();
        const initialFocusCalls = focusSpy.mock.calls.length;
        expect(initialFocusCalls).toBeGreaterThan(0);

        await act(async () => {
            terminalContainer!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        });

        expect(focusSpy.mock.calls.length).toBe(initialFocusCalls + 1);
    });

    it('skips fit while the xterm renderer is unavailable', async () => {
        renderServiceRendererValue = undefined;

        const { XtermTerminalView } = await import('./XtermTerminalView.web');

        await act(async () => {
            root.render(
                <XtermTerminalView
                    testID="terminal"
                    fontSize={14}
                    onInput={() => {}}
                    onResize={() => {}}
                    onReady={() => {}}
                />,
            );
        });

        await act(async () => {
            await new Promise((resolve) => {
                setTimeout(resolve, 40);
            });
        });

        expect(fitSpy).not.toHaveBeenCalled();
    });

    it('lets xterm queued viewport sync settle before disposing on quick unmount', async () => {
        scheduleInternalViewportSync = true;
        internalViewportSyncDelayMs = 70;

        const { XtermTerminalView } = await import('./XtermTerminalView.web');

        await act(async () => {
            root.render(
                <XtermTerminalView
                    testID="terminal"
                    fontSize={14}
                    onInput={() => {}}
                    onResize={() => {}}
                    onReady={() => {}}
                />,
            );
        });

        await act(async () => {
            root.unmount();
        });

        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, deferredDisposeDrainMs));
        });

        expect(delayedViewportSyncAfterDisposeSpy).not.toHaveBeenCalled();
        expect(disposeSpy).toHaveBeenCalledTimes(1);
    });

    it('reports ready after the xterm renderer becomes available after the init timer', async () => {
        renderServiceRendererValue = undefined;

        const { XtermTerminalView } = await import('./XtermTerminalView.web');
        const onReady = vi.fn();
        const onResize = vi.fn();

        await act(async () => {
            root.render(
                <XtermTerminalView
                    testID="terminal"
                    fontSize={14}
                    onInput={() => {}}
                    onResize={onResize}
                    onReady={onReady}
                />,
            );
        });

        await act(async () => {
            await new Promise((resolve) => {
                setTimeout(resolve, 40);
            });
        });

        expect(fitSpy).not.toHaveBeenCalled();
        expect(onReady).not.toHaveBeenCalled();

        terminalInstances[0]!._core._renderService._renderer.value = {};

        await act(async () => {
            await new Promise((resolve) => {
                setTimeout(resolve, 60);
            });
        });

        expect(fitSpy).toHaveBeenCalled();
        expect(onResize).toHaveBeenCalledWith(80, 24);
        expect(onReady).toHaveBeenCalledWith(80, 24);
    });

    it('enables xterm screen reader DOM mode in the web surface', async () => {
        const { XtermTerminalView } = await import('./XtermTerminalView.web');

        await act(async () => {
            root.render(
                <XtermTerminalView
                    testID="terminal"
                    fontSize={14}
                    onInput={() => {}}
                    onResize={() => {}}
                    onReady={() => {}}
                />,
            );
        });

        expect(terminalConstructorOptions[0]).toEqual(
            expect.objectContaining({ screenReaderMode: true }),
        );
    });

    it('writes byte chunks to xterm as Uint8Array without decoding high-bit bytes', async () => {
        const { XtermTerminalView } = await import('./XtermTerminalView.web');
        const ref = React.createRef<XtermTerminalHandle>();

        await act(async () => {
            root.render(
                <XtermTerminalView
                    ref={ref}
                    testID="terminal"
                    fontSize={14}
                    onInput={() => {}}
                    onResize={() => {}}
                    onReady={() => {}}
                />,
            );
        });

        const handle = requireTerminalHandle(ref);
        expect(typeof handle.writeBytes).toBe('function');
        const bytes = new Uint8Array([0xff, 0x00, 0x41, 0xc3, 0x28]);

        await act(async () => {
            handle.writeBytes({
                terminalId: 'terminal-1',
                seq: 7,
                byteOffset: 11,
                bytes,
                writeGeneration: 1,
            });
            await new Promise((resolve) => setTimeout(resolve, 40));
        });

        expect(terminalInstances[0]?.write).toHaveBeenCalledWith(bytes, expect.any(Function));
    });

    it('mirrors byte output into the deterministic terminal text attribute', async () => {
        const { XtermTerminalView } = await import('./XtermTerminalView.web');
        const ref = React.createRef<XtermTerminalHandle>();

        await act(async () => {
            root.render(
                <XtermTerminalView
                    ref={ref}
                    testID="terminal"
                    fontSize={14}
                    onInput={() => {}}
                    onResize={() => {}}
                    onReady={() => {}}
                />,
            );
        });

        await act(async () => {
            requireTerminalHandle(ref).writeBytes({
                terminalId: 'terminal-preview',
                seq: 1,
                byteOffset: 0,
                bytes: new Uint8Array([
                    0x64, 0x65, 0x74, 0x65, 0x72, 0x6d, 0x69, 0x6e, 0x69, 0x73, 0x74, 0x69, 0x63,
                    0x2d, 0x6d, 0x61, 0x72, 0x6b, 0x65, 0x72,
                ]),
                writeGeneration: 1,
            });
            await new Promise((resolve) => setTimeout(resolve, 40));
        });

        const terminalContainer = container.querySelector('[data-testid="terminal"]');
        expect(terminalContainer?.getAttribute('data-happier-terminal-text')).toContain('deterministic-marker');
    });

    it('reports byte write completion only after xterm invokes the parser callback', async () => {
        deferWriteCallbacks = true;
        const { XtermTerminalView } = await import('./XtermTerminalView.web');
        const onWriteComplete = vi.fn();
        const ref = React.createRef<XtermTerminalHandle>();

        await act(async () => {
            root.render(
                <XtermTerminalView
                    ref={ref}
                    testID="terminal"
                    fontSize={14}
                    onInput={() => {}}
                    onResize={() => {}}
                    onReady={() => {}}
                    onWriteComplete={onWriteComplete}
                />,
            );
        });

        await act(async () => {
            requireTerminalHandle(ref).writeBytes({
                terminalId: 'terminal-ack',
                seq: 2,
                byteOffset: 100,
                bytes: new Uint8Array([1, 2, 3, 4]),
                writeGeneration: 2,
            });
            await new Promise((resolve) => setTimeout(resolve, 40));
        });

        expect(onWriteComplete).not.toHaveBeenCalled();
        expect(pendingWriteCallbacks).toHaveLength(1);

        await act(async () => {
            pendingWriteCallbacks.shift()?.();
        });

        expect(onWriteComplete).toHaveBeenCalledWith({
            terminalId: 'terminal-ack',
            seq: 2,
            byteOffset: 100,
            byteLength: 4,
            ackedByteOffset: 104,
            writeGeneration: 2,
        });
    });

    it('does not report a byte write completion after the surface unmounts', async () => {
        deferWriteCallbacks = true;
        const { XtermTerminalView } = await import('./XtermTerminalView.web');
        const onWriteComplete = vi.fn();
        const ref = React.createRef<XtermTerminalHandle>();

        await act(async () => {
            root.render(
                <XtermTerminalView
                    ref={ref}
                    testID="terminal"
                    fontSize={14}
                    onInput={() => {}}
                    onResize={() => {}}
                    onReady={() => {}}
                    onWriteComplete={onWriteComplete}
                />,
            );
        });

        await act(async () => {
            requireTerminalHandle(ref).writeBytes({
                terminalId: 'terminal-unmounted',
                seq: 3,
                byteOffset: 200,
                bytes: new Uint8Array([5, 6]),
                writeGeneration: 3,
            });
            await new Promise((resolve) => setTimeout(resolve, 40));
        });

        expect(pendingWriteCallbacks).toHaveLength(1);

        await act(async () => {
            root.unmount();
        });

        pendingWriteCallbacks.shift()?.();

        expect(onWriteComplete).not.toHaveBeenCalled();
    });

    it('keeps byte replay queued and suppresses parser completion after unmount', async () => {
        deferWriteCallbacks = true;
        const { XtermTerminalView } = await import('./XtermTerminalView.web');
        const onWriteComplete = vi.fn();
        const ref = React.createRef<XtermTerminalHandle>();

        await act(async () => {
            root.render(
                <XtermTerminalView
                    ref={ref}
                    testID="terminal"
                    fontSize={14}
                    onInput={() => {}}
                    onResize={() => {}}
                    onReady={() => {}}
                    onWriteComplete={onWriteComplete}
                />,
            );
        });

        const runtime = createTerminalStreamRuntime({
            terminalId: 'terminal-replay',
            rendererId: 'xterm-web',
            renderer: requireTerminalHandle(ref),
            surfaceEpoch: 1,
        });
        let applied: ReturnType<typeof runtime.applyFrames> | null = null;

        await act(async () => {
            applied = runtime.applyFrames([{
                t: 'bytes',
                terminalId: 'terminal-replay',
                seq: 4,
                byteOffset: 12,
                byteLength: 2,
                bytes: new Uint8Array([0x41, 0x42]),
                source: 'byte-stream',
            }]);
            await new Promise((resolve) => setTimeout(resolve, 40));
        });

        expect(applied).toEqual({
            status: 'active',
            acceptedByteOffset: null,
            rejectedByteOffset: null,
            queuedWrite: {
                terminalId: 'terminal-replay',
                seq: 4,
                byteOffset: 12,
                byteLength: 2,
                ackedByteOffset: 14,
                writeGeneration: 1,
            },
            deferredFrames: [],
        });
        expect(pendingWriteCallbacks).toHaveLength(1);

        await act(async () => {
            root.unmount();
        });
        pendingWriteCallbacks.shift()?.();

        expect(onWriteComplete).not.toHaveBeenCalled();
    });

    it('keeps later byte writes queued until the active xterm write completes', async () => {
        deferWriteCallbacks = true;
        const { XtermTerminalView } = await import('./XtermTerminalView.web');
        const ref = React.createRef<XtermTerminalHandle>();

        await act(async () => {
            root.render(
                <XtermTerminalView
                    ref={ref}
                    testID="terminal"
                    fontSize={14}
                    onInput={() => {}}
                    onResize={() => {}}
                    onReady={() => {}}
                />,
            );
        });

        await act(async () => {
            const handle = requireTerminalHandle(ref);
            handle.writeBytes({
                terminalId: 'terminal-pressure',
                seq: 1,
                byteOffset: 0,
                bytes: new Uint8Array([1]),
                writeGeneration: 1,
            });
            handle.writeBytes({
                terminalId: 'terminal-pressure',
                seq: 2,
                byteOffset: 1,
                bytes: new Uint8Array([2]),
                writeGeneration: 1,
            });
            await new Promise((resolve) => setTimeout(resolve, 40));
        });

        expect(terminalInstances[0]?.write).toHaveBeenCalledTimes(1);

        await act(async () => {
            pendingWriteCallbacks.shift()?.();
            await new Promise((resolve) => setTimeout(resolve, 40));
        });

        expect(terminalInstances[0]?.write).toHaveBeenCalledTimes(2);
        expect(terminalInstances[0]?.write).toHaveBeenLastCalledWith(new Uint8Array([2]), expect.any(Function));
    });

    it('routes keyboard paste through the host paste policy instead of direct input', async () => {
        const { XtermTerminalView } = await import('./XtermTerminalView.web');
        const onInput = vi.fn();
        const onPaste = vi.fn();
        const readText = vi.fn(async () => 'clipboard text');
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { readText },
        });

        await act(async () => {
            root.render(
                <XtermTerminalView
                    testID="terminal"
                    fontSize={14}
                    onInput={onInput}
                    onPaste={onPaste}
                    onResize={() => {}}
                    onReady={() => {}}
                />,
            );
        });

        const keyHandler = attachCustomKeyEventHandlerSpy.mock.calls.at(-1)?.[0] as ((event: KeyboardEvent) => boolean) | undefined;
        expect(typeof keyHandler).toBe('function');
        const event = new KeyboardEvent('keydown', { key: 'v', metaKey: true });
        vi.spyOn(event, 'preventDefault');
        vi.spyOn(event, 'stopPropagation');

        const result = keyHandler!(event);
        await act(async () => {
            await Promise.resolve();
        });

        expect(result).toBe(false);
        expect(onPaste).toHaveBeenCalledWith('clipboard text');
        expect(onInput).not.toHaveBeenCalledWith('clipboard text');
    });

    it('captures real DOM ClipboardEvent paste before xterm turns it into ordinary input', async () => {
        const { XtermTerminalView } = await import('./XtermTerminalView.web');
        const onInput = vi.fn();
        const onPaste = vi.fn();

        await act(async () => {
            root.render(
                <XtermTerminalView
                    testID="terminal"
                    fontSize={14}
                    onInput={onInput}
                    onPaste={onPaste}
                    onResize={() => {}}
                    onReady={() => {}}
                />,
            );
        });

        const textarea = terminalInstances.at(-1)?.textarea;
        expect(textarea).not.toBeNull();
        const event = createClipboardPasteEvent('first line\nsecond line');

        await act(async () => {
            textarea!.dispatchEvent(event);
            await Promise.resolve();
        });

        expect(event.defaultPrevented).toBe(true);
        expect(onPaste).toHaveBeenCalledWith('first line\nsecond line');
        expect(onInput).not.toHaveBeenCalled();
    });

    it('routes detected web links through the host policy handler instead of xterm default opens', async () => {
        const { XtermTerminalView } = await import('./XtermTerminalView.web');
        const onLink = vi.fn();
        const open = vi.spyOn(window, 'open').mockImplementation(() => null);

        await act(async () => {
            root.render(
                <XtermTerminalView
                    testID="terminal"
                    fontSize={14}
                    onInput={() => {}}
                    onLink={onLink}
                    onResize={() => {}}
                    onReady={() => {}}
                />,
            );
        });

        expect(typeof webLinksHandler).toBe('function');
        const event = new MouseEvent('click');
        vi.spyOn(event, 'preventDefault');
        webLinksHandler?.(event, 'https://example.com/path');

        expect(onLink).toHaveBeenCalledWith('https://example.com/path');
        expect(open).not.toHaveBeenCalled();

        open.mockRestore();
    });

});
