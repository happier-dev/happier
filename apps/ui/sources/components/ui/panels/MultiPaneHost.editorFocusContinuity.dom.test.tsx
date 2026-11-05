/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FocusReturnTarget } from '@/keyboard/focusReturn';

vi.mock('react-native', async () => vi.importActual<typeof import('react-native-web')>('react-native-web'));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

// Keep the cold real graph outside each DOM journey's render/focus budget.
await import('@/sync/syncEngine');
const { MultiPaneHost } = await import('./MultiPaneHost');
const { MultiPaneHostWithBottom } = await import('./MultiPaneHostWithBottom');
const { focusPaneRegion } = await import('@/components/appShell/panes/paneRegion');

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.unstubAllGlobals(); });

describe('retained editor DOM focus', () => {
    it('cycles through the main page and companion while retained hidden pages stay out of the cycle', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        cleanups.push(async () => { await act(async () => root.unmount()); container.remove(); });
        await act(async () => root.render(<MultiPaneHost
            main={<button data-testid="cycle-composer">Send</button>}
            rightPane={<span>Sidebar token</span>}
            rightSurfaces={[
                { id: 'info', placement: 'main', content: <button data-testid="cycle-page">Page</button> },
                { id: 'files', placement: 'side', content: <button data-testid="cycle-companion">Files</button> },
                { id: 'preview', placement: 'hidden', content: <button>Retained preview</button> },
            ]}
            detailsPane={<button data-testid="cycle-editor">Editor</button>}
            mirrored
            layout={{ main: 'docked', kind: 'threePane', right: 'docked', details: 'docked' }}
            rightDockWidthPx={340} detailsDockWidthPx={600}
            onCloseRight={() => {}} onCloseDetails={() => {}}
            onCommitRightDockWidthPx={() => {}} onCommitDetailsDockWidthPx={() => {}}
        />));
        const page = container.querySelector<HTMLButtonElement>('[data-testid="cycle-page"]')!;
        const companion = container.querySelector<HTMLButtonElement>('[data-testid="cycle-companion"]')!;
        const editor = container.querySelector<HTMLButtonElement>('[data-testid="cycle-editor"]')!;
        editor.focus();
        expect(focusPaneRegion('next')).toBe(true);
        expect(document.activeElement?.contains(page)).toBe(true);
        expect(focusPaneRegion('next')).toBe(true);
        expect(document.activeElement?.contains(companion)).toBe(true);
        container.querySelector<HTMLButtonElement>('[data-testid="cycle-composer"]')!.focus();
        expect(focusPaneRegion('previous')).toBe(true);
        expect(document.activeElement?.contains(editor)).toBe(true);
    });
    it('contains the main page and composer together when the main drawer opens', async () => {
        vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)', addEventListener() {}, removeEventListener() {} }));
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        cleanups.push(async () => { await act(async () => root.unmount()); container.remove(); });
        await act(async () => root.render(<MultiPaneHost
            main={<button data-testid="composer-action">Send</button>}
            rightPane={null}
            rightSurfaces={[{ id: 'info', placement: 'main', content: <button data-testid="main-page-action">Page action</button> }]}
            detailsPane={<button data-testid="editor-action">Editor action</button>}
            mirrored mainDrawerOpen
            layout={{ main: 'overlay', kind: 'twoPane', right: 'hidden', details: 'docked' }}
            rightDockWidthPx={340} detailsDockWidthPx={600}
            onCloseRight={() => {}} onCloseDetails={() => {}}
            onCommitRightDockWidthPx={() => {}} onCommitDetailsDockWidthPx={() => {}}
        />));
        const composer = container.querySelector<HTMLButtonElement>('[data-testid="composer-action"]')!;
        const page = container.querySelector<HTMLButtonElement>('[data-testid="main-page-action"]')!;
        const editor = container.querySelector<HTMLButtonElement>('[data-testid="editor-action"]')!;
        expect(page.closest('[inert]')).toBeNull();
        expect(editor.closest('[inert]')).not.toBeNull();
        expect(page.closest('[aria-modal="true"]')).not.toBeNull();
        expect(page.closest('[aria-modal="true"]')).toBe(composer.closest('[aria-modal="true"]'));
        page.focus();
        const previous = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
        await act(async () => { page.dispatchEvent(previous); });
        // The page is inside the same focus scope as the preceding composer: allow native backward Tab.
        expect(previous.defaultPrevented).toBe(false);
        expect(document.activeElement).toBe(page);
    });
    it.each([
        { direction: 'next', region: 'main' },
        { direction: 'previous', region: 'bottom' },
    ] as const)('cycles into the actual $region root on its first visit', async ({ direction, region }) => {
        vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)', addEventListener() {}, removeEventListener() {} }));
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        cleanups.push(async () => { await act(async () => root.unmount()); container.remove(); });
        await act(async () => root.render(<MultiPaneHostWithBottom
            main={<input data-testid="unvisited-main-input" />}
            rightPane={null} detailsPane={null}
            layout={{ main: 'docked', kind: 'single', right: 'hidden', details: 'hidden' }}
            rightDockWidthPx={340} detailsDockWidthPx={600}
            onCloseRight={() => {}} onCloseDetails={() => {}}
            onCommitRightDockWidthPx={() => {}} onCommitDetailsDockWidthPx={() => {}}
            bottomPane={<input data-testid="unvisited-bottom-input" />}
            bottomPresentation="docked" bottomDockHeightPx={240}
            bottomDockMinHeightPx={120} bottomDockMaxHeightPx={500}
            onCloseBottom={() => {}} onCommitBottomDockHeightPx={() => {}}
        />));
        const target = region === 'main'
            ? container.querySelector('[data-testid="multi-pane-main-column"]')
            : container.querySelector('[data-testid="multi-pane-bottom-dock"]')?.closest('[role="region"]');
        expect(target).toBeTruthy();
        expect(focusPaneRegion(direction)).toBe(true);
        expect(document.activeElement).toBe(target);
    });
    it('keeps main and editor nodes, caret and iframe through arrangement and hide/show', async () => {
        vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)', addEventListener() {}, removeEventListener() {} }));
        const container = document.createElement('div'); document.body.appendChild(container);
        const root = createRoot(container);
        cleanups.push(async () => { await act(async () => root.unmount()); container.remove(); });
        let mounts = 0;
        const mainReturn: React.MutableRefObject<FocusReturnTarget> = { current: null };
        function Main() { React.useEffect(() => { mounts += 1; }, []); return <input data-testid="main-draft" defaultValue="Draft" />; }
        const render = async (mirrored: boolean, hideMain = false, drawer = false) => {
            await act(async () => root.render(<MultiPaneHost main={<Main />} hideMain={hideMain} mirrored={mirrored}
                rightPane={null} detailsPane={<><input data-testid="editor-draft" defaultValue="Code" /><iframe data-testid="hosted-page" src="about:blank" /></>}
                layout={{ main: drawer ? 'overlay' : 'docked', kind: 'twoPane', right: 'hidden', details: 'docked' }} detailsClosable={!mirrored}
                mainDrawerOpen={drawer} mainOverlayFocusReturnRef={mainReturn}
                rightDockWidthPx={340} detailsDockWidthPx={600} mainDockWidthPx={440}
                onCloseRight={() => {}} onCloseDetails={() => {}} onCommitRightDockWidthPx={() => {}} onCommitDetailsDockWidthPx={() => {}} />));
        };
        await render(false);
        const main = container.querySelector<HTMLInputElement>('[data-testid="main-draft"]')!;
        const editor = container.querySelector<HTMLInputElement>('[data-testid="editor-draft"]')!;
        const iframe = container.querySelector('[data-testid="hosted-page"]');
        editor.focus(); editor.setSelectionRange(1, 3);
        for (const mirrored of [true, false]) {
            await render(mirrored);
            expect(container.querySelector('[data-testid="editor-draft"]')).toBe(editor);
            expect(document.activeElement).toBe(editor);
            expect([editor.selectionStart, editor.selectionEnd]).toEqual([1, 3]);
            expect(container.querySelector('[data-testid="hosted-page"]')).toBe(iframe);
        }
        await render(true, true);
        expect(container.querySelector('[data-testid="main-draft"]')).toBe(main);
        expect(main.closest('[inert]')).not.toBeNull();
        await render(true);
        expect(container.querySelector('[data-testid="main-draft"]')).toBe(main);
        expect(main.value).toBe('Draft'); expect(mounts).toBe(1);
        editor.focus(); mainReturn.current = editor;
        await render(true, false, true);
        expect(container.querySelector('[data-testid="main-draft"]')).toBe(main);
        await render(true, true);
        expect(document.activeElement).toBe(editor);
    });
    it.each(['details', 'right'] as const)('retains the %s caret through dock, overlay, and dock but restores the opener on real close', async (kind) => {
        // The OS reduced-motion preference is a browser boundary; pane motion/resizing remain real.
        vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)', addEventListener() {}, removeEventListener() {} }));
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        cleanups.push(async () => { await act(async () => root.unmount()); container.remove(); });
        const openerRef: React.MutableRefObject<FocusReturnTarget> = { current: null };
        let mounts = 0;
        function Editor() {
            React.useEffect(() => { mounts += 1; }, []);
            return <input data-testid="draft" defaultValue="Unsubmitted work" />;
        }
        const render = async (presentation: 'docked' | 'overlay', open = true) => {
            await act(async () => root.render(<MultiPaneHost
                main={<button data-testid="opener">Open</button>}
                detailsPane={kind === 'details' && open ? <Editor /> : null}
                rightPane={kind === 'right' && open ? <Editor /> : null}
                layout={{ main: 'docked', kind: presentation === 'overlay' ? 'overlayStack' : 'twoPane', details: kind === 'details' ? presentation : 'hidden', right: kind === 'right' ? presentation : 'hidden' }}
                detailsDockWidthPx={390}
                rightDockWidthPx={390}
                onCloseDetails={() => {}}
                onCloseRight={() => {}}
                onCommitDetailsDockWidthPx={() => {}}
                onCommitRightDockWidthPx={() => {}}
                detailsOverlayFocusReturnRef={openerRef}
                rightOverlayFocusReturnRef={openerRef}
            />));
        };
        await render('docked');
        const input = container.querySelector<HTMLInputElement>('[data-testid="draft"]')!;
        const opener = container.querySelector<HTMLButtonElement>('[data-testid="opener"]')!;
        input.focus();
        input.setSelectionRange(3, 8);
        for (const presentation of ['overlay', 'docked'] as const) {
            await render(presentation);
            expect(container.querySelector('[data-testid="draft"]')).toBe(input);
            expect(document.activeElement).toBe(input);
            expect([input.selectionStart, input.selectionEnd]).toEqual([3, 8]);
            expect(input.value).toBe('Unsubmitted work');
            expect(mounts).toBe(1);
        }
        openerRef.current = opener;
        await render('overlay');
        await render('overlay', false);
        expect(document.activeElement).toBe(opener);
    });
});
