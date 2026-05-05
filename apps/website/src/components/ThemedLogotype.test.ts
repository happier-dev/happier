import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ThemedLogotype } from './ThemedLogotype';

describe('ThemedLogotype', () => {
    it('maps the dark wordmark to light surfaces and the light wordmark to dark surfaces', () => {
        const markup = renderToStaticMarkup(createElement(ThemedLogotype));

        expect(markup).toMatch(
            /src="\/images\/logotype-dark\.png"[^>]*class="theme-logotype theme-logotype-on-light"/,
        );
        expect(markup).toMatch(
            /src="\/images\/logotype-light\.png"[^>]*class="theme-logotype theme-logotype-on-dark absolute inset-0"/,
        );
    });
});
