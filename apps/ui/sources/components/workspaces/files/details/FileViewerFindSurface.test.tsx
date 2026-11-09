// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';
import { FileViewerFindSurface } from './FileViewerFindSurface';
import { KeyboardShortcutProvider } from '@/keyboard/KeyboardShortcutProvider';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { CodeLinesViewCore } from '@/components/ui/code/view/CodeLinesViewCore';
import { buildCodeLinesFromFile } from '@/components/ui/code/model/buildCodeLinesFromFile';
import { storage } from '@/sync/domains/state/storage';
import type { FileFindSeed } from '@/components/appShell/panes/fileFindSeedHandoff';

// Real RNW elements are required to observe focused DOM and capture propagation.
vi.mock('react-native', async () => await import('react-native-web'));

const text = 'needle\n😀 needle';
const lines = buildCodeLinesFromFile({ text });

describe('mounted file Find surface', () => {
    it('opens from the sibling file toolbar, steps through the real line renderer, passes second Find and restores focus', async () => {
        Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
        const settings = storage.getState().settings;
        storage.setState({ settings: { ...settings, keyboardShortcutsV2Enabled: true,
            keyboardShortcutDisabledCommandIdsV1: [], keyboardShortcutOverridesV1: {} } });
        const container = document.createElement('div'); document.body.appendChild(container);
        const root = createRoot(container);
        function File() {
            const focusRootRef = React.useRef<View | null>(null);
            return <View ref={focusRootRef}>
                <button data-testid="file-toolbar">File</button>
                <FileViewerFindSurface surfaceId="file:test" active content={{ path: 'a.ts', mode: 'file', text }} focusRootRef={focusRootRef}>
                    {(find) => <CodeLinesViewCore lines={lines} virtualized={false} findRangesByLineId={find.lineRanges} scrollToLineId={find.lineTarget ?? undefined} />}
                </FileViewerFindSurface>
            </View>;
        }
        const key = async (target: Element, key: string, code: string, metaKey = false) => {
            const event = new KeyboardEvent('keydown', { key, code, metaKey, bubbles: true, cancelable: true });
            await act(async () => { target.dispatchEvent(event); }); return event;
        };
        try {
            await act(async () => { root.render(<KeyboardShortcutProvider handlers={{}}><PluginSurfaceFocusEligibilityProvider active><File /></PluginSurfaceFocusEligibilityProvider></KeyboardShortcutProvider>); });
            const origin = container.querySelector<HTMLButtonElement>('[data-testid="file-toolbar"]')!;
            await act(async () => { origin.focus(); });
            expect((await key(origin, 'f', 'KeyF', true)).defaultPrevented).toBe(true);
            const input = container.querySelector<HTMLInputElement>('[data-testid="file-viewer-find.input"]');
            expect(input).not.toBeNull();
            const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
            await act(async () => { inputSetter.call(input, 'needle'); input!.dispatchEvent(new Event('input', { bubbles: true })); });
            expect(container.querySelector('[data-testid="find-match-current"]')?.textContent).toBe('needle');
            await key(input!, 'g', 'KeyG', true);
            expect(container.querySelector('[data-testid="file-viewer-find.status"]')?.textContent).toContain('2');
            expect((await key(input!, 'f', 'KeyF', true)).defaultPrevented).toBe(false);
            await key(input!, 'Escape', 'Escape');
            expect(container.querySelector('[data-testid="file-viewer-find.input"]')).toBeNull();
            expect(document.activeElement).toBe(origin);
        } finally { await act(async () => { root.unmount(); }); container.remove(); storage.setState({ settings }); }
    });

    it('consumes a travelling query once and decorates its addressed line', async () => {
        const container = document.createElement('div'); document.body.appendChild(container);
        const root = createRoot(container);
        const consumed = vi.fn();
        const remember = vi.fn();
        const seed: FileFindSeed = { query: 'needle', options: { matchCase: false, regex: false },
            target: { kind: 'file', path: 'a.ts', anchor: { kind: 'fileLine', startLine: 2 } } };
        try {
            await act(async () => { root.render(<PluginSurfaceFocusEligibilityProvider active>
                <FileViewerFindSurface surfaceId="file:seed" active content={{ path: 'a.ts', mode: 'file', text }} findSeed={seed} onFindSeedConsumed={consumed} onRememberFind={remember}>
                    {(find) => <CodeLinesViewCore lines={lines} virtualized={false} findRangesByLineId={find.lineRanges} scrollToLineId={find.lineTarget ?? undefined} />}
                </FileViewerFindSurface>
            </PluginSurfaceFocusEligibilityProvider>); });
            expect(consumed).toHaveBeenCalledTimes(1);
            expect(container.querySelector('[data-testid="find-match-current"]')?.textContent).toBe('needle');
            expect(container.querySelector('[data-testid="file-viewer-find.status"]')?.textContent).toContain('2');
        } finally { await act(async () => { root.unmount(); }); container.remove(); }
        expect(remember).toHaveBeenLastCalledWith({ query: 'needle', open: true,
            options: { matchCase: false, regex: false }, line: 2 });
    });
    it('rebuilds with the bar and query its last page left open, and says what it leaves behind', async () => {
        const remember = vi.fn();
        const openChange = vi.fn();
        const container = document.createElement('div'); document.body.appendChild(container);
        let root = createRoot(container);
        const page = (initialFind?: { query: string; open: boolean }) => <PluginSurfaceFocusEligibilityProvider active>
            <FileViewerFindSurface surfaceId="file:memory" active content={{ path: 'a.ts', mode: 'file', text }}
                initialFind={initialFind} onRememberFind={remember} onOpenChange={openChange}>
                {(find) => <CodeLinesViewCore lines={lines} virtualized={false} findRangesByLineId={find.lineRanges} scrollToLineId={find.lineTarget ?? undefined} />}
            </FileViewerFindSurface>
        </PluginSurfaceFocusEligibilityProvider>;
        try {
            await act(async () => { root.render(page({ query: 'needle', open: true })); });
            expect(container.querySelector<HTMLInputElement>('[data-testid="file-viewer-find.input"]')?.value).toBe('needle');
            // The reader's place is kept: the matches show, none is current until they step.
            expect(container.querySelector('[data-testid="find-match-all"]')?.textContent).toBe('needle');
            expect(container.querySelector('[data-testid="find-match-current"]')).toBeNull();
            expect(openChange).toHaveBeenLastCalledWith(true);
            await act(async () => { root.unmount(); });
            // No match was current, so Edit would open its Find on the query without a line to land on.
            expect(remember).toHaveBeenLastCalledWith({ query: 'needle', open: true, options: { matchCase: false, regex: false }, line: null });
            expect(openChange).toHaveBeenLastCalledWith(false);

            root = createRoot(container);
            await act(async () => { root.render(page({ query: 'needle', open: false })); });
            expect(container.querySelector('[data-testid="file-viewer-find.input"]')).toBeNull();
            await act(async () => { root.unmount(); });
            expect(remember).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'needle', open: false }));
        } finally { container.remove(); }
    });
});
