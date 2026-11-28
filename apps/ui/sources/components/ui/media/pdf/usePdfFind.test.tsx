// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { KeyboardShortcutProvider } from '@/keyboard/KeyboardShortcutProvider';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { storage } from '@/sync/domains/state/storage';
import { createPdfFindModel } from './pdfFindModel';
import { usePdfFind } from './usePdfFind';

// Real browser focus and keyboard dispatch require the platform's RNW boundary.
vi.mock('react-native', async () => await import('react-native-web'));

describe('mounted PDF shared Find registration', () => {
    it('opens and steps next/previous through the incumbent keyboard registry', async () => {
        Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
        const settings = storage.getState().settings;
        storage.setState({ settings: { ...settings,
            keyboardShortcutDisabledCommandIdsV1: [], keyboardShortcutOverridesV1: {} } });
        const revealed: number[] = [];
        const model = createPdfFindModel({ reveal: match => revealed.push(match.start) });
        model.setDocument({ numPages: 1, getPage: async () => ({ getTextContent: async () => ({ items: [{ str: 'retry retry retry' }] }) }) });
        const container = document.createElement('div'); document.body.appendChild(container);
        const root = createRoot(container);
        function Surface() {
            const origin = React.useRef<HTMLButtonElement | null>(null);
            usePdfFind({ surfaceId: 'pdf:test', active: true, document: null, controller: model,
                containsFocus: () => document.activeElement === origin.current, isInputFocused: () => false,
                focusInput: () => {}, reveal: () => {} });
            return <button ref={origin}>PDF</button>;
        }
        const key = async (key: string, code: string, shiftKey = false) => {
            const event = new KeyboardEvent('keydown', { key, code, metaKey: true, shiftKey, bubbles: true, cancelable: true });
            await act(async () => { container.querySelector('button')!.dispatchEvent(event); }); return event;
        };
        try {
            await act(async () => { root.render(<KeyboardShortcutProvider handlers={{}}><PluginSurfaceFocusEligibilityProvider active><Surface /></PluginSurfaceFocusEligibilityProvider></KeyboardShortcutProvider>); });
            await act(async () => { container.querySelector('button')!.focus(); });
            expect((await key('f', 'KeyF')).defaultPrevented).toBe(true);
            expect(model.getSnapshot().open).toBe(true);
            await act(async () => { model.setQuery('retry'); await model.whenSettled(); });
            await key('g', 'KeyG'); await key('g', 'KeyG', true);
            expect(model.status).toMatchObject({ current: 1, total: 3 });
            expect(revealed).toEqual([0, 6, 0]);
        } finally { await act(async () => { root.unmount(); }); container.remove(); storage.setState({ settings }); }
    });
});
