import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Nav } from './Nav';

describe('Nav', () => {
    it('renders both theme-safe logotype variants so the header follows data-theme without remounting', () => {
        const markup = renderToStaticMarkup(createElement(Nav));

        expect(markup).toContain('/images/logotype-dark.png');
        expect(markup).toContain('/images/logotype-light.png');
        expect(markup).toContain('data-theme-logotype');
    });

    it('keeps compact mobile-only controls alongside the desktop actions', () => {
        const markup = renderToStaticMarkup(createElement(Nav));

        expect(markup).toContain('aria-label="GitHub"');
        expect(markup).toContain('sm:hidden');
        expect(markup).toContain('sm:inline-flex');
    });
});
