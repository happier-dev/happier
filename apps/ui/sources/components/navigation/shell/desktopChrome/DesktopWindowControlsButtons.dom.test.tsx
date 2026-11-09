/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { installPopoverCommonModuleMocks } from '@/components/ui/popover/popoverTestHelpers';

installPopoverCommonModuleMocks({ reactNative: async () => await vi.importActual('react-native-web') });

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { DesktopWindowControlsButtons } = await import('./DesktopWindowControlsButtons');
const { preloadTranslationsForSettings, setPreferredLanguageFromSettings } = await import('@/text');
await import('@/components/ui/overlays/AnchoredTooltip');

describe('DesktopWindowControlsButtons discovery', () => {
    it('reveals localized actions on hover and keyboard focus, including the current restore action', async () => {
        await preloadTranslationsForSettings('fr');
        setPreferredLanguageFromSettings('fr');
        vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1024);
        vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(768);
        window.dispatchEvent(new Event('resize'));
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0));
        vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
        // jsdom has no layout engine; supply measurements at the browser boundary.
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 20, 120, 28));
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        try {
            await act(async () => root.render(<DesktopWindowControlsButtons />));
            expect(document.querySelector('[role="tooltip"]')).toBeNull();

            for (const [action, label] of [
                ['minimize', 'Réduire la fenêtre'],
                ['toggle-maximize', 'Agrandir la fenêtre'],
                ['close', 'Fermer la fenêtre'],
            ]) {
                const trigger = container.querySelector<HTMLElement>(`[data-testid="desktop-window-controls-${action}"]`);
                if (!trigger) throw new Error(`Missing ${action} control`);
                await act(async () => trigger.dispatchEvent(new MouseEvent(window.PointerEvent != null ? 'pointerenter' : 'mouseenter', { bubbles: true })));
                await vi.waitFor(() => expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(label));
                await act(async () => trigger.dispatchEvent(new MouseEvent(window.PointerEvent != null ? 'pointerleave' : 'mouseleave', { bubbles: true })));
                await vi.waitFor(() => expect(document.querySelector('[role="tooltip"]')).toBeNull());
            }

            await act(async () => root.render(<DesktopWindowControlsButtons isMaximized layout="column" />));
            const restore = container.querySelector<HTMLElement>('[data-testid="desktop-window-controls-toggle-maximize"]');
            if (!restore) throw new Error('Missing restore control');
            await act(async () => {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
                restore.focus();
            });
            await vi.waitFor(() => expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Restaurer la fenêtre'));
            expect(document.activeElement).toBe(restore);
            await act(async () => restore.blur());
            await vi.waitFor(() => expect(document.querySelector('[role="tooltip"]')).toBeNull());
        } finally {
            await act(async () => root.unmount());
            container.remove();
            setPreferredLanguageFromSettings(null);
            vi.restoreAllMocks();
            vi.unstubAllGlobals();
        }
    });
});
