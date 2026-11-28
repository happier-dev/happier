// @vitest-environment jsdom

import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

import { __resetThemeStoreForTests, useTheme } from './themeStore';

/**
 * The build-time renderer always paints the dark palette, and index.html's inline
 * script then sets `<html class="light">` before first paint for a visitor who
 * chose light. Islands that read the theme (the wordmark, the toggle, the CTA art)
 * must converge on that class after hydration. preact/compat's hydrate keeps the
 * server's attributes, so the store has to cause a real render after hydration
 * rather than answer the client value during it.
 */
function Probe() {
    const { theme } = useTheme();
    return <span data-theme={theme} />;
}

afterEach(() => {
    __resetThemeStoreForTests();
    document.documentElement.className = '';
    document.body.innerHTML = '';
});

describe('theme store hydration', () => {
    it('moves a hydrated island to the theme the inline script set', async () => {
        document.documentElement.className = 'dark';
        const serverHtml = renderToString(<Probe />);
        __resetThemeStoreForTests();

        document.documentElement.className = 'js light';
        const container = document.createElement('div');
        container.innerHTML = serverHtml;
        document.body.append(container);

        await act(async () => {
            hydrateRoot(container, <Probe />);
        });

        expect(container.querySelector('span')?.getAttribute('data-theme')).toBe('light');
    });
});
