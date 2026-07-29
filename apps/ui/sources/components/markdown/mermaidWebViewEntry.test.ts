// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { removeMermaidNavigation } from './mermaidSanitize';

describe('native Mermaid WebView output policy', () => {
    it('removes every navigation-bearing SVG surface while preserving diagram content', () => {
        const host = document.createElement('div');
        host.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
                <a href="https://attacker.example" target="_blank">
                    <text>HTTP target</text>
                </a>
                <a xlink:href="happier-test://open">
                    <text>Custom target</text>
                </a>
                <use href="/relative-target" />
                <use xlink:href="about:blank" />
            </svg>
        `;

        removeMermaidNavigation(host);

        expect(host.querySelector('a')).toBeNull();
        expect(host.textContent).toContain('HTTP target');
        expect(host.textContent).toContain('Custom target');
        for (const element of host.querySelectorAll('*')) {
            expect(element.hasAttribute('href')).toBe(false);
            expect(element.hasAttribute('xlink:href')).toBe(false);
            expect(element.hasAttribute('target')).toBe(false);
        }
    });
});
