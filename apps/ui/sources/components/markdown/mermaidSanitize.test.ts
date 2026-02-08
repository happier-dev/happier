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
        expect(sanitized).toContain('href="#"');
    });
});
