/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTerminalStreamRuntime } from '@/sync/domains/terminal/stream/runtime';

import type { XtermTerminalHandle } from './XtermTerminalView.web';
// Collection loads the real owner graph outside the SDK interaction timeout.
import './XtermTerminalView.web';
import { EmbeddedTerminalPane } from '../embedded/EmbeddedTerminalPane.web';
import type { EmbeddedTerminalPaneController } from '../embedded/types';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const appearance = vi.hoisted(() => ({ light: false }));

const fitSpy = vi.fn();
const focusSpy = vi.fn();
const loadAddonSpy = vi.fn();
const openSpy = vi.fn();
const attachCustomKeyEventHandlerSpy = vi.fn();
const onDataSpy = vi.fn();
const disposeSpy = vi.fn();
const registerOscHandlerSpy = vi.fn<(
    id: number,
    callback: (data: string) => boolean,
) => Readonly<{ dispose: () => void }>>(() => ({ dispose: vi.fn() }));
const registerDcsHandlerSpy = vi.fn(() => ({ dispose: vi.fn() }));
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
    buffer = {
        active: {
            cursorY: 20, baseY: 0, viewportY: 0, length: 24, type: 'normal',
            getLine: (row: number) => ({ translateToString: () => this.printedRows[row] ?? '' }),
        },
        onBufferChange: (_callback: () => void) => ({ dispose: vi.fn() }),
    };
    cursorMoved: (() => void) | null = null;
    scrolled: (() => void) | null = null;
    writeParsed: (() => void) | null = null;
    dataHandler: ((data: string) => void) | null = null;
    printedRows: Record<number, string> = {};
    onCursorMove(callback: () => void) { this.cursorMoved = callback; return { dispose: () => { this.cursorMoved = null; } }; }
    onScroll(callback: () => void) { this.scrolled = callback; return { dispose: () => { this.scrolled = null; } }; }
    onResize(_callback: () => void) { return { dispose: vi.fn() }; }
    onSelectionChange(_callback: () => void) { return { dispose: vi.fn() }; }
    onWriteParsed(callback: () => void) { this.writeParsed = callback; return { dispose: () => { this.writeParsed = null; } }; }
    parser = {
        registerCsiHandler: vi.fn(() => ({ dispose: vi.fn() })),
        registerOscHandler: registerOscHandlerSpy,
        registerDcsHandler: registerDcsHandlerSpy,
    };
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
    blur = vi.fn();
    clear = vi.fn();
    hasSelection = vi.fn(() => false);
    getSelection = vi.fn(() => '');
    getSelectionPosition = vi.fn(() => undefined);
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
        this.dataHandler = callback;
        onDataSpy.mockImplementation(callback);
        return { dispose: vi.fn() };
    }
}

vi.mock('@xterm/xterm', () => ({
    // Static owner imports happen before this file initializes the SDK fixture.
    Terminal: class {
        constructor(options: Record<string, unknown> = {}) {
            return new MockTerminal(options);
        }
    },
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

// The external renderer boundary has no parsed xterm cells. Matching remains
// in the real Find engine; this addon fixture only supplies the widget API.
vi.mock('@xterm/addon-search', () => ({
    SearchAddon: class {
        activate() {}
        onDidChangeResults() { return { dispose() {} }; }
        findNext() { return false; }
        findPrevious() { return false; }
        clearDecorations() {}
        dispose() {}
    },
}));

vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    // This is a DOM-composed test: RN's style arrays need its real web host
    // conversion when the Find bar becomes visible, not string host stubs.
    const web = await vi.importActual<typeof import('react-native')>('react-native-web');
    return createReactNativeWebMock({ View: web.View, Text: web.Text, TextInput: web.TextInput,
        Pressable: web.Pressable, ScrollView: web.ScrollView, Animated: web.Animated });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    const dark = await createUnistylesMock({
        theme: {
            colors: {
                surface: { base: '#000000', selected: '#333333' },
                text: { primary: '#ffffff' },
            },
        },
    });
    const light = await createUnistylesMock({ theme: { colors: {
        surface: { base: '#ffffff', selected: '#dddddd' }, text: { primary: '#000000' },
    } } });
    return { ...dark, useUnistyles: () => (appearance.light ? light : dark).useUnistyles() };
});

describe('XtermTerminalView.web', () => {
    let container: HTMLDivElement;
    let root: ReturnType<typeof createRoot>;
    let originalGetBoundingClientRect: typeof HTMLElement.prototype.getBoundingClientRect;

    beforeEach(() => {
        appearance.light = false;
        fitSpy.mockReset();
        focusSpy.mockReset();
        loadAddonSpy.mockReset();
        openSpy.mockReset();
        attachCustomKeyEventHandlerSpy.mockReset();
        onDataSpy.mockReset();
        disposeSpy.mockReset();
        registerOscHandlerSpy.mockClear();
        registerDcsHandlerSpy.mockClear();
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

    it('fits a visible terminal and submits retained replay without a readiness timer or animation frame', async () => {
        const ref = React.createRef<XtermTerminalHandle>();
        const { XtermTerminalView } = await import('./XtermTerminalView.web');
        let readyAtCommit = false;
        let replaySubmittedAtCommit = false;
        function ReturnedOutput() {
            React.useLayoutEffect(() => {
                readyAtCommit = terminalInstances.length === 1 && fitSpy.mock.calls.length > 0;
                requireTerminalHandle(ref).write('retained output', { intent: 'replay' });
                replaySubmittedAtCommit = terminalInstances[0]?.write.mock.calls.some(([data]) => data === 'retained output') ?? false;
            }, []);
            return <XtermTerminalView ref={ref} fontSize={14} onInput={() => {}} onResize={() => {}} onReady={() => {}} />;
        }
        await act(async () => { root.render(<ReturnedOutput />); });
        expect(readyAtCommit).toBe(true);
        expect(replaySubmittedAtCommit).toBe(true);
    });

    it('retains output, focus and its renderer handle across pane updates after loading', async () => {
        const ref = React.createRef<XtermTerminalHandle>();
        const onInput = vi.fn();
        const nextInput = vi.fn();
        const onReady = vi.fn();
        const controller: EmbeddedTerminalPaneController = {
            status: 'connected', error: null, detectedUrl: null,
            onInput, onPaste: () => {}, onResize: () => {}, onReady,
            onWriteComplete: () => {}, clearTerminal: () => {},
            requestRestart: () => {}, retryConnect: () => {}, dismissDetectedUrl: () => {},
        };
        await act(async () => {
            root.render(<EmbeddedTerminalPane title="shell" controller={controller} terminalRef={ref}
                chrome="none" showQuickKeys={false} focused testIdPrefix="loaded-terminal" />);
            await vi.dynamicImportSettled();
        });
        const handle = requireTerminalHandle(ref);
        const find = handle.find;
        expect(find).toBeDefined();
        const terminal = terminalInstances[0];
        focusSpy.mockImplementation(() => terminal.textarea?.focus());
        await act(async () => {
            handle.focus();
            handle.write('retained terminal output');
            find?.setQuery('retained query');
            await new Promise((resolve) => setTimeout(resolve, 40));
        });
        const surface = container.querySelector('[data-testid="loaded-terminal-xterm"]');
        expect(surface?.getAttribute('data-happier-terminal-text') ?? '').toContain('retained terminal output');
        expect(document.activeElement).toBe(terminal.textarea);
        expect(onReady).toHaveBeenCalledWith(80, 24);

        await act(async () => root.render(<EmbeddedTerminalPane title="renamed shell"
            controller={{ ...controller, status: 'exited', onInput: nextInput }} terminalRef={ref}
            chrome="none" showQuickKeys={false} focused testIdPrefix="loaded-terminal" />));
        expect(ref.current).toBe(handle);
        expect(container.querySelector('[data-testid="loaded-terminal-xterm"]')).toBe(surface);
        expect(surface?.getAttribute('data-happier-terminal-text')).toContain('retained terminal output');
        expect(document.activeElement).toBe(terminal.textarea);
        expect(terminal.disposed).toBe(false);
        expect(ref.current?.find).toBe(find);
        expect(find?.query).toBe('retained query');
        expect(terminal.options).toMatchObject({ cursorBlink: false, cursorStyle: 'bar', cursorInactiveStyle: 'none', disableStdin: true,
            theme: { cursor: '#00000000' } });
        // A finished Script has no more stream data to repaint a reset renderer after resize.
        await act(async () => root.render(<EmbeddedTerminalPane title="renamed shell"
            controller={{ ...controller, status: 'exited', readOnly: true, exitCode: 0 }} terminalRef={ref}
            chrome="none" showQuickKeys focused testIdPrefix="loaded-terminal" />));
        expect(ref.current).toBe(handle);
        expect(container.querySelector('[data-testid="loaded-terminal-xterm"]')).toBe(surface);
        expect(surface?.getAttribute('data-happier-terminal-text')).toContain('retained terminal output');
        expect(terminal.disposed).toBe(false);
        appearance.light = true;
        await act(async () => root.render(<EmbeddedTerminalPane title="renamed shell"
            controller={{ ...controller, status: 'exited', readOnly: true, exitCode: 0 }} terminalRef={ref}
            chrome="none" showQuickKeys focused testIdPrefix="loaded-terminal" />));
        expect(ref.current).toBe(handle);
        expect(surface?.getAttribute('data-happier-terminal-text') ?? '').toContain('retained terminal output');
        expect(ref.current?.find).toBe(find);
        expect(terminal.options.theme).toMatchObject({ foreground: '#000000' });
        expect(terminal.options).toMatchObject({ cursorBlink: false, cursorStyle: 'bar', cursorInactiveStyle: 'none',
            theme: { cursor: '#00000000' } });
        await act(async () => root.render(<EmbeddedTerminalPane title="renamed shell"
            controller={{ ...controller, status: 'connected', onInput: nextInput }} terminalRef={ref}
            chrome="none" showQuickKeys={false} focused testIdPrefix="loaded-terminal" />));
        expect(terminal.options).toMatchObject({ cursorBlink: true, cursorStyle: 'block', cursorInactiveStyle: 'outline', disableStdin: false,
            theme: { cursor: '#000000' } });
        // The external xterm SDK changes these options when an application emits DECSCUSR.
        terminal.options.cursorStyle = 'underline';
        terminal.options.cursorBlink = false;
        appearance.light = false;
        await act(async () => root.render(<EmbeddedTerminalPane title="renamed shell"
            controller={{ ...controller, status: 'connected', onInput: nextInput }} terminalRef={ref}
            chrome="none" showQuickKeys={false} focused testIdPrefix="loaded-terminal" />));
        expect(terminal.options).toMatchObject({ cursorStyle: 'underline', cursorBlink: false });
        onDataSpy('continued input');
        expect(nextInput).toHaveBeenCalledWith('continued input');
        expect(onInput).not.toHaveBeenCalled();
    });

    it.each([
        { status: 'connected', readOnly: true },
        { status: 'exited', readOnly: false },
    ] as const)('mounts a phone $status output without a focused or inactive cursor (readOnly=$readOnly)', async (state) => {
        const ref = React.createRef<XtermTerminalHandle>();
        const controller: EmbeddedTerminalPaneController = {
            ...state, error: null, detectedUrl: null,
            onInput: () => {}, onPaste: () => {}, onResize: () => {}, onReady: () => {},
            onWriteComplete: () => {}, clearTerminal: () => {}, requestRestart: () => {},
            retryConnect: () => {}, dismissDetectedUrl: () => {},
        };
        await act(async () => {
            root.render(<EmbeddedTerminalPane title="output" controller={controller} terminalRef={ref}
                chrome="none" showQuickKeys focused testIdPrefix="readonly-terminal" />);
            await vi.dynamicImportSettled();
        });
        expect(terminalInstances[0].options).toMatchObject({ cursorBlink: false, cursorStyle: 'bar', cursorInactiveStyle: 'none',
            disableStdin: true, theme: { cursor: '#00000000' } });
    });

    it('hands Find to the replacement phone renderer only for the same logical terminal surface', async () => {
        const ref = React.createRef<XtermTerminalHandle>();
        const controller: EmbeddedTerminalPaneController = {
            status: 'connected', error: null, detectedUrl: null,
            onInput: () => {}, onPaste: () => {}, onResize: () => {}, onReady: () => {},
            onWriteComplete: () => {}, clearTerminal: () => {}, requestRestart: () => {},
            retryConnect: () => {}, dismissDetectedUrl: () => {},
        };
        const pane = (mount: string, surface: string, phone: boolean) => <PluginSurfaceFocusEligibilityProvider active><EmbeddedTerminalPane key={mount}
            title="Shell" nativeSurfaceKey={surface} controller={controller} terminalRef={ref}
            chrome="none" showQuickKeys={phone} focused testIdPrefix="handoff-terminal" /></PluginSurfaceFocusEligibilityProvider>;
        await act(async () => {
            root.render(pane('classic', 'resize-terminal', false));
            await vi.dynamicImportSettled();
        });
        const oldEngine = requireTerminalHandle(ref).find;
        await act(async () => {
            oldEngine?.setQuery('amber orchard');
            oldEngine?.setOptions({ regex: false, matchCase: true });
            oldEngine?.open();
        });
        await act(async () => {
            root.render(pane('cockpit', 'resize-terminal', true));
            await vi.dynamicImportSettled();
        });
        const replacement = requireTerminalHandle(ref).find;
        expect(replacement).not.toBe(oldEngine);
        expect(replacement?.getSnapshot()).toMatchObject({ open: true, query: 'amber orchard',
            options: { regex: false, matchCase: true } });
        await act(async () => {
            replacement?.close();
            root.render(pane('classic-again', 'resize-terminal', false));
            await vi.dynamicImportSettled();
        });
        expect(requireTerminalHandle(ref).find?.getSnapshot()).toMatchObject({ open: false, query: 'amber orchard' });
        await act(async () => {
            root.render(pane('other', 'another-terminal', true));
            await vi.dynamicImportSettled();
        });
        expect(requireTerminalHandle(ref).find?.getSnapshot()).toMatchObject({ open: false, query: '' });
    });

    it('paints no background of its own, so the pane material shows through in glass and solid alike, without fading foreground text', async () => {
        const { XtermTerminalView } = await import('./XtermTerminalView.web');
        const { storage } = await import('@/sync/domains/state/storage');
        const { glassPresetMaterials } = await import('@/components/ui/glass/glassMaterial');
        const previous = storage.getState().settings;
        const materials = glassPresetMaterials('everywhere');
        try {
            await act(async () => {
                storage.setState({ settings: { ...previous, glassBlurEnabled: true, glassSurfaceMaterials: materials } });
                root.render(<XtermTerminalView onInput={() => {}} onResize={() => {}} onReady={() => {}} fontSize={12} />);
            });
            expect(terminalConstructorOptions[0]?.allowTransparency).toBe(true);
            expect(terminalConstructorOptions[0]?.theme).toEqual(expect.objectContaining({ background: '#00000000', foreground: '#ffffff', cursor: '#ffffff' }));
            const terminal = terminalInstances[0];
            await act(async () => {
                storage.setState({ settings: { ...previous, glassBlurEnabled: true, glassSurfaceMaterials: { ...materials, content: { blur: 'off', opacity: 1 } } } });
            });
            expect(terminalInstances).toHaveLength(1);
            expect(terminal.options.theme).toEqual(expect.objectContaining({ background: '#00000000', foreground: '#ffffff' }));
        } finally {
            await act(async () => { storage.setState({ settings: previous }); });
        }
    });

    it('keeps ANSI text readable and preserves bold without promoting it into pale bright colors', async () => {
        const { XtermTerminalView } = await import('./XtermTerminalView.web');
        await act(async () => { root.render(<XtermTerminalView fontSize={13} onInput={() => {}} onResize={() => {}} onReady={() => {}} />); });
        expect(terminalConstructorOptions[0]?.minimumContrastRatio).toBe(1);
        expect(terminalConstructorOptions[0]?.drawBoldTextInBrightColors).toBe(false);
        expect(terminalConstructorOptions[0]?.fontWeightBold).toBe('bold');
    });

    it('reports the visible cursor row and clears it when the viewport scrolls away', async () => {
        const { XtermTerminalView } = await import('./XtermTerminalView.web');
        const cursor = vi.fn();
        await act(async () => { root.render(<XtermTerminalView fontSize={14} onInput={() => {}} onResize={() => {}} onReady={() => {}} onCursorRowChange={cursor} />); });
        const terminal = terminalInstances[0]!;
        await act(async () => { terminal.cursorMoved?.(); });
        expect(cursor).toHaveBeenLastCalledWith({ top: 20 * 320 / 24, height: 320 / 24 });
        terminal.buffer.active.viewportY = 30;
        await act(async () => { terminal.scrolled?.(); });
        expect(cursor).toHaveBeenLastCalledWith(null);
    });

    it('reports the height its output needs: down to the last printed line or the cursor row, whichever is lower', async () => {
        const { XtermTerminalView } = await import('./XtermTerminalView.web');
        const content = vi.fn();
        await act(async () => { root.render(<XtermTerminalView fontSize={14} onInput={() => {}} onResize={() => {}} onReady={() => {}} onContentHeightChange={content} />); });
        const terminal = terminalInstances[0]!;
        const row = 320 / 24;
        // "QA_FAIL\n": one printed row and the cursor on the empty row below it.
        terminal.printedRows = { 0: 'QA_FAIL' };
        terminal.buffer.active.cursorY = 1;
        await act(async () => { terminal.writeParsed?.(); });
        expect(content).toHaveBeenLastCalledWith(2 * row);
        // Output that stops short of a cursor which moved back up still counts to its last printed row.
        terminal.printedRows = { 0: 'QA_FAIL', 5: 'later' };
        await act(async () => { terminal.writeParsed?.(); });
        expect(content).toHaveBeenLastCalledWith(6 * row);
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

    it('keeps the renderer canvases in their own stacking context so they never cover controls beside the terminal', async () => {
        const { XtermTerminalView } = await import('./XtermTerminalView.web');

        await act(async () => {
            root.render(<XtermTerminalView testID="terminal" fontSize={14} onInput={() => {}} onResize={() => {}} onReady={() => {}} />);
        });

        const terminalContainer = container.querySelector<HTMLElement>('[data-testid="terminal"]');
        expect(terminalContainer?.style.isolation).toBe('isolate');
        expect(terminalContainer?.style.overflow).toBe('hidden');
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
        expect(container.querySelector('[data-testid="terminal"]')?.getAttribute('data-happier-terminal-cols')).toBe('80');
        expect(container.querySelector('[data-testid="terminal"]')?.getAttribute('data-happier-terminal-rows')).toBe('24');
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
        expect(registerOscHandlerSpy).toHaveBeenCalledWith(52, expect.any(Function));
        expect(registerOscHandlerSpy).toHaveBeenCalledWith(1337, expect.any(Function));
        expect(registerDcsHandlerSpy).toHaveBeenCalledWith({ final: 'q' }, expect.any(Function));
        const clipboardHandler = registerOscHandlerSpy.mock.calls.find(([id]) => id === 52)?.[1];
        expect(clipboardHandler).toBeTypeOf('function');
        expect(clipboardHandler?.('clipboard')).toBe(true);
    });

    it('suppresses real parser replies during replay until completion and forwards live replies afterwards', async () => {
        // No browser renderer is opened; xterm can use its non-canvas color fallback.
        const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        const { Terminal } = await vi.importActual<typeof import('@xterm/xterm')>('@xterm/xterm');
        getContext.mockRestore();
        const terminal = new Terminal();
        const { XtermTerminalView } = await import('./XtermTerminalView.web');
        const ref = React.createRef<XtermTerminalHandle>();
        const onInput = vi.fn();
        await act(async () => root.render(
            <XtermTerminalView ref={ref} fontSize={14} onInput={onInput} onResize={() => {}} onReady={() => {}} />,
        ));
        const instance = terminalInstances[0];
        const parsed: Array<Promise<void>> = [];
        const completions: Array<() => void> = [];
        terminal.onData((data) => onDataSpy(data));
        instance.write.mockImplementation((data, callback) => {
            parsed.push(new Promise<void>((resolve) => terminal.write(data, () => {
                if (callback) completions.push(callback);
                resolve();
            })));
        });
        try {
            await act(async () => {
                requireTerminalHandle(ref).write('\u001b[c', { intent: 'replay' });
                await new Promise((resolve) => setTimeout(resolve, 40));
                await Promise.all(parsed);
            });
            expect(onInput).not.toHaveBeenCalled();
            terminal.input('during replay');
            expect(onInput).not.toHaveBeenCalled();
            completions.shift()?.();
            terminal.input('after replay');
            expect(onInput).toHaveBeenCalledWith('after replay');
            onInput.mockClear();
            await act(async () => {
                requireTerminalHandle(ref).writeBytes({ terminalId: 'live', seq: 1, byteOffset: 0, writeGeneration: 0, bytes: new TextEncoder().encode('\u001b[c') });
                await new Promise((resolve) => setTimeout(resolve, 40));
                await Promise.all(parsed);
            });
            expect(onInput).toHaveBeenCalledWith(expect.stringMatching(/^\u001b\[\?/));
            completions.shift()?.();
        } finally {
            terminal.dispose();
        }
    });

    it('moves the same parsed buffer beyond the preview cap and retains an unfinished UTF8 character', async () => {
        const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        const { Terminal } = await vi.importActual<typeof import('@xterm/xterm')>('@xterm/xterm');
        getContext.mockRestore();
        const parsed = new Terminal({ cols: 100, rows: 24, scrollback: 5000 });
        const { XtermTerminalView } = await import('./XtermTerminalView.web');
        const ref = React.createRef<XtermTerminalHandle>();
        const oldInput = vi.fn();
        const newInput = vi.fn();
        const oldCompletion = vi.fn();
        const newCompletion = vi.fn();
        await act(async () => root.render(<XtermTerminalView key="old" ref={ref} testID="old-host"
            fontSize={14} onInput={oldInput} onResize={() => {}} onReady={() => {}} onWriteComplete={oldCompletion} />));
        const original = terminalInstances[0];
        original.focus = vi.fn(() => original.textarea?.focus());
        original.blur = vi.fn(() => original.textarea?.blur());
        let holdCompletion = false;
        let finishPendingWrite: (() => void) | undefined;
        original.write.mockImplementation((data, callback) => parsed.write(data, () => {
            if (holdCompletion) finishPendingWrite = callback;
            else callback?.();
        }));
        const history = Array.from({ length: 4500 }, (_, index) => `history-${index}-retained-text\r\n`).join('');
        try {
            await act(async () => {
                requireTerminalHandle(ref).write(history, { intent: 'replay' });
                await new Promise<void>((resolve) => parsed.write('', resolve));
                holdCompletion = true;
                requireTerminalHandle(ref).writeBytes({ terminalId: 'history', seq: 0, byteOffset: history.length,
                    writeGeneration: 0, bytes: new Uint8Array([0xe2, 0x82]) });
                await new Promise<void>((resolve) => parsed.write('', resolve));
            });
            const resource = requireTerminalHandle(ref).captureResource?.();
            expect(resource, 'the renderer must hand off its parsed buffer').toBeDefined();
            if (!resource) return;
            const cache = await import('@/components/sessions/terminal/terminalSurfaceStateCache');
            cache.replaceTerminalSurfaceState('history-visible-owner', { ...cache.createEmptyTerminalSurfaceState(),
                terminalId: 'history', rendererResource: resource });
            for (let index = 0; index < 13; index += 1) {
                cache.replaceTerminalSurfaceState(`history-dormant-${index}`, cache.createEmptyTerminalSurfaceState());
            }
            expect(cache.readTerminalSurfaceState('history-visible-owner')?.rendererResource,
                'cycling dormant Shells must not evict an attached renderer').toBe(resource);
            let settled = false;
            const settling = resource.whenSettled().then(() => { settled = true; });
            await act(async () => root.render(null));
            expect(settled).toBe(false);
            expect(oldCompletion).not.toHaveBeenCalled();
            finishPendingWrite?.();
            await settling;
            expect(oldCompletion).toHaveBeenCalledWith(expect.objectContaining({ ackedByteOffset: history.length + 2 }));
            holdCompletion = false;
            await act(async () => root.render(<XtermTerminalView key="new" ref={ref} testID="new-host"
                fontSize={16} readOnly onInput={newInput} onResize={() => {}} onReady={() => {}} onWriteComplete={newCompletion} />));
            await act(async () => {
                expect(requireTerminalHandle(ref).restoreResource?.(resource)).toBe(true);
                expect(requireTerminalHandle(ref).restoreResource?.(resource)).toBe(true);
                expect(original.options.fontSize).toBe(16);
                expect(original.options.disableStdin).toBe(true);
                expect(document.activeElement).toBe(original.textarea);
                requireTerminalHandle(ref).writeBytes({ terminalId: 'history', seq: 1, byteOffset: history.length + 2,
                    writeGeneration: 1, bytes: new Uint8Array([0xac]) });
                await resource.whenSettled();
            });
            expect(original.disposed).toBe(false);
            expect(original.open).toHaveBeenCalledTimes(1);
            expect(container.querySelector('[data-testid="new-host"]')?.contains(original.textarea)).toBe(true);
            expect(container.querySelector('[data-testid="old-host"]')).toBeNull();
            expect(parsed.buffer.active.getLine(0)?.translateToString(true)).toBe('history-0-retained-text');
            expect(parsed.buffer.active.getLine(4499)?.translateToString(true)).toBe('history-4499-retained-text');
            expect(parsed.buffer.active.getLine(4500)?.translateToString(true)).toBe('€');
            expect(newCompletion).toHaveBeenCalledWith(expect.objectContaining({ ackedByteOffset: history.length + 3 }));
            await act(async () => root.render(<XtermTerminalView key="new" ref={ref} testID="new-host"
                fontSize={14} onInput={newInput} onResize={() => {}} onReady={() => {}} />));
            original.dataHandler?.('new owner input');
            expect(newInput).toHaveBeenCalledWith('new owner input');
            expect(oldInput).not.toHaveBeenCalled();
            await act(async () => root.render(<XtermTerminalView key="new" ref={ref} testID="new-host"
                fontSize={16} readOnly onInput={newInput} onResize={() => {}} onReady={() => {}} />));
            expect(original.options.fontSize).toBe(16);
            expect(original.options.disableStdin).toBe(true);
            expect(original.disposed).toBe(false);
            resource.dispose();
            expect(original.disposed).toBe(false);
            await act(async () => root.render(null));
            await act(async () => { await new Promise((resolve) => setTimeout(resolve, deferredDisposeDrainMs)); });
            expect(original.disposed).toBe(true);
            cache.replaceTerminalSurfaceState('history-visible-owner', cache.createEmptyTerminalSurfaceState());
        } finally {
            parsed.dispose();
        }
    });

    it('reattaches the retained renderer before activation reports ready, preserving textarea focus', async () => {
        const { XtermTerminalView } = await import('./XtermTerminalView.web');
        const ref = React.createRef<XtermTerminalHandle>();
        const props = { fontSize: 14, onInput: vi.fn(), onResize: vi.fn(), onReady: vi.fn() };
        await act(async () => root.render(<XtermTerminalView ref={ref} {...props} />));
        const original = terminalInstances[0];
        original.focus = vi.fn(() => original.textarea?.focus());
        original.blur = vi.fn(() => original.textarea?.blur());
        const retainedResource = requireTerminalHandle(ref).captureResource?.();
        await act(async () => root.render(null));
        const ready = vi.fn(() => expect(document.activeElement).toBe(original.textarea));
        await act(async () => root.render(<XtermTerminalView ref={ref} {...props} retainedResource={retainedResource} onReady={ready} />));
        expect(terminalInstances).toHaveLength(1);
        expect(document.activeElement).toBe(original.textarea);
        expect(ready).toHaveBeenCalled();
        retainedResource?.dispose();
    });

    it('releases replay suppression when a renderer is replaced before its callback', async () => {
        const { XtermTerminalView } = await import('./XtermTerminalView.web');
        const ref = React.createRef<XtermTerminalHandle>();
        const onInput = vi.fn();
        deferWriteCallbacks = true;
        await act(async () => root.render(
            <XtermTerminalView key="first" ref={ref} fontSize={14} onInput={onInput} onResize={() => {}} onReady={() => {}} />,
        ));
        await act(async () => {
            requireTerminalHandle(ref).write('\u001b[c', { intent: 'replay' });
            await new Promise((resolve) => setTimeout(resolve, 40));
        });
        expect(pendingWriteCallbacks).toHaveLength(1);
        await act(async () => root.render(
            <XtermTerminalView key="replacement" ref={ref} fontSize={14} onInput={onInput} onResize={() => {}} onReady={() => {}} />,
        ));
        onDataSpy('fresh renderer input');
        expect(onInput).toHaveBeenCalledWith('fresh renderer input');
        onInput.mockClear();
        await act(async () => {
            requireTerminalHandle(ref).write('\u001b[c', { intent: 'replay' });
            await new Promise((resolve) => setTimeout(resolve, 40));
        });
        pendingWriteCallbacks.shift()?.();
        onDataSpy('after stale completion');
        expect(onInput).not.toHaveBeenCalled();
        pendingWriteCallbacks.shift()?.();
        onDataSpy('new replay completed');
        expect(onInput).toHaveBeenCalledWith('new replay completed');
    });

    it('submits byte chunks to the parser without waiting for an animation frame or decoding high-bit bytes', async () => {
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
            expect(terminalInstances[0]?.write).toHaveBeenCalledWith(bytes, expect.any(Function));
        });
    });

    it('returns queued before reporting a synchronous real-parser completion after user input', async () => {
        const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        const { Terminal } = await vi.importActual<typeof import('@xterm/xterm')>('@xterm/xterm');
        getContext.mockRestore();
        const terminal = new Terminal();
        const { XtermTerminalView } = await import('./XtermTerminalView.web');
        const ref = React.createRef<XtermTerminalHandle>();
        const onWriteComplete = vi.fn();
        await act(async () => root.render(<XtermTerminalView ref={ref} fontSize={14}
            onInput={() => {}} onResize={() => {}} onReady={() => {}} onWriteComplete={onWriteComplete} />));
        terminalInstances[0].write.mockImplementation((data, callback) => terminal.write(data, callback));
        terminal.input('a');
        await act(async () => {
            expect(requireTerminalHandle(ref).writeBytes({ terminalId: 'burst', seq: 0, byteOffset: 0,
                bytes: new TextEncoder().encode('a'), writeGeneration: 7 })).toEqual({ status: 'queued' });
            // User-input echo can parse synchronously. The controller must receive its queued
            // receipt before the completion that releases that receipt's stream credit.
            expect(onWriteComplete).not.toHaveBeenCalled();
        });
        expect(onWriteComplete).toHaveBeenCalledWith(expect.objectContaining({
            terminalId: 'burst', ackedByteOffset: 1, writeGeneration: 7,
        }));
        terminal.dispose();
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
            expect(terminalInstances[0]?.write).toHaveBeenCalledTimes(2);
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

    it('never forwards a chord the keyboard provider already handled, but keeps an unhandled Ctrl+G for the PTY', async () => {
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

        const keyHandler = attachCustomKeyEventHandlerSpy.mock.calls.at(-1)?.[0] as ((event: KeyboardEvent) => boolean) | undefined;
        expect(typeof keyHandler).toBe('function');
        const handledFind = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, cancelable: true });
        handledFind.preventDefault();

        expect(keyHandler!(handledFind)).toBe(false);
        expect(keyHandler!(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true, cancelable: true }))).toBe(true);
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
