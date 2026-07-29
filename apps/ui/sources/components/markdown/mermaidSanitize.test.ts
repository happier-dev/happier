// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { sanitizeRenderedMermaidSvg } from './mermaidSanitize';

describe('sanitizeRenderedMermaidSvg', () => {
    it('removes script tags, inline event handlers, and javascript hrefs', () => {
        const input = `
            <svg onclick="alert(1)">
                <script>alert('xss')</script>
                <a href="javascript:alert(2)" onmouseover="alert(3)">link</a>
                <g onload='alert(4)'></g>
            </svg>
        `;

        const sanitized = sanitizeRenderedMermaidSvg(input);

        expect(sanitized).not.toContain('<script');
        expect(sanitized).not.toContain('onclick=');
        expect(sanitized).not.toContain('onmouseover=');
        expect(sanitized).not.toContain('onload=');
        expect(sanitized).not.toContain('javascript:');
        expect(sanitized).not.toContain('href=');
    });

    it('removes all Mermaid navigation surfaces while preserving label content', () => {
        const sanitized = sanitizeRenderedMermaidSvg(`
            <svg xmlns:xlink="http://www.w3.org/1999/xlink">
                <a href="https://attacker.example" target="_blank"><text>HTTP target</text></a>
                <a xlink:href="happier-test://open"><text>Custom target</text></a>
                <use href="/relative-target" />
            </svg>
        `);

        expect(sanitized).not.toContain('<a');
        expect(sanitized).not.toContain('href=');
        expect(sanitized).not.toContain('xlink:href=');
        expect(sanitized).not.toContain('target=');
        expect(sanitized).toContain('HTTP target');
        expect(sanitized).toContain('Custom target');
    });
});
