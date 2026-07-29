import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { BrowserViewFrame } from './BrowserViewFrame.web';

describe('BrowserViewFrame web', () => {
    it('renders a shared iframe engine with the supplied sandbox policy', async () => {
        const screen = await renderScreen(
            <BrowserViewFrame
                engine={{
                    kind: 'webIframe',
                    title: 'Preview',
                    url: 'https://preview.example.test/',
                    sandbox: 'allow-scripts',
                    testID: 'browser-frame',
                }}
            />,
        );

        const iframe = screen.findByType('iframe');
        expect(iframe.props.src).toBe('https://preview.example.test/');
        expect(iframe.props.sandbox).toBe('allow-scripts');
        expect(iframe.props.referrerPolicy).toBe('no-referrer');
        expect(iframe.props['data-testid']).toBe('browser-frame');
        expect(iframe.props.testID).toBeUndefined();
    });

    it('fails closed with a visible unavailable state for unsupported engines', async () => {
        const screen = await renderScreen(
            <BrowserViewFrame
                engine={{
                    kind: 'unavailable',
                    reasonCode: 'external_url_unavailable',
                    testID: 'browser-frame',
                }}
            />,
        );

        expect(screen.findByTestId('browser-frame-unavailable')).toBeTruthy();
    });

    it('renders frame errors as recoverable shared state cards with a reload CTA', async () => {
        const onReload = vi.fn();
        const screen = await renderScreen(
            <BrowserViewFrame
                engine={{
                    kind: 'error',
                    errorCode: 'webview_load_failed',
                    testID: 'browser-frame',
                    onReload,
                }}
            />,
        );

        expect(screen.findByTestId('browser-frame-error-card')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('webview_load_failed');

        await screen.pressByTestIdAsync('browser-frame-error-action');

        expect(onReload).toHaveBeenCalledTimes(1);
    });
});
