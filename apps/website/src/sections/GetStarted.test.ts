/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copy } from '@/theme/copy';
import { GetStarted } from './GetStarted';

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;

describe('GetStarted', () => {
    afterEach(() => {
        document.body.innerHTML = '';
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('uses the committed badge asset paths and renders non-interactive badges when store links are unavailable', () => {
        const markup = renderToStaticMarkup(createElement(GetStarted));

        expect(markup).toContain('/images/badges/app-store.svg');
        expect(markup).toContain('/images/badges/google-play.svg');
        expect(markup).not.toContain('src="/badges/app-store.svg"');
        expect(markup).not.toContain('src="/badges/google-play.svg"');
        expect(markup).not.toContain('<a href=');
        expect(markup).toContain('data-store-badge-state="inactive"');
        expect(markup).toContain('cursor-default');
    });

    it('announces clipboard success through a live region', async () => {
        vi.useFakeTimers();

        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(window.navigator, 'clipboard', {
            configurable: true,
            value: { writeText },
        });

        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);

        act(() => {
            root.render(createElement(GetStarted));
        });

        const button = host.querySelector('button');
        const liveRegion = host.querySelector('[role="status"]');

        expect(button).not.toBeNull();
        expect(liveRegion?.getAttribute('aria-live')).toBe('polite');
        expect(liveRegion?.textContent ?? '').toBe('');

        await act(async () => {
            button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });

        expect(writeText).toHaveBeenCalledWith(copy.getStarted.install);
        expect((liveRegion?.textContent ?? '').toLowerCase()).toContain('clipboard');

        act(() => {
            vi.runAllTimers();
            root.unmount();
        });
    });
});
