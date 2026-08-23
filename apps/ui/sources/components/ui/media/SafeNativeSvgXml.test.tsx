import { describe, expect, it } from 'vitest';

import { parseSafeNativeSvgXml } from './SafeNativeSvgXml';

describe('parseSafeNativeSvgXml', () => {
    it.each([
        {
            name: 'malformed XML',
            xml: '<svg><path></svg>',
        },
        {
            name: 'a non-svg root',
            xml: '<image href="data:image/png;base64,iVBORw0KGgo="/>',
        },
        {
            name: 'an external image URL',
            xml: '<svg><image href="https://example.com/pixel.png"/></svg>',
        },
        {
            name: 'an external feImage URL',
            xml: '<svg><filter><feImage href="https://example.com/filter.png"/></filter></svg>',
        },
        {
            name: 'a file URL in xlinkHref',
            xml: '<svg><image xlink:href="file:///tmp/private.png"/></svg>',
        },
        {
            name: 'a protocol-relative URL',
            xml: '<svg><image href="//example.com/pixel.png"/></svg>',
        },
        {
            name: 'an SVG data URI',
            xml: '<svg><image href="data:image/svg+xml;base64,PHN2Zy8+"/></svg>',
        },
        {
            name: 'an external CSS URL',
            xml: '<svg><rect fill="url(https://example.com/paint.svg#gradient)"/></svg>',
        },
        {
            name: 'a file URL in a style property',
            xml: '<svg><rect style="fill:url(file:///tmp/paint.svg#gradient)"/></svg>',
        },
        {
            name: 'an event-like property',
            xml: '<svg onload="fetch(\'https://example.com/\')"><path d="M0 0"/></svg>',
        },
        {
            name: 'foreignObject content',
            xml: '<svg><foreignObject><image href="#local"/></foreignObject></svg>',
        },
    ])('does not produce an AST for $name', ({ xml }) => {
        expect(parseSafeNativeSvgXml(xml)).toBeNull();
    });

    it.each([
        ['drawing elements', '<svg><path d="M0 0h16v16H0z"/></svg>'],
        ['text content', '<svg><text x="1" y="8">safe</text></svg>'],
        ['local paint fragments', '<svg><defs><linearGradient id="paint"/></defs><rect fill="url(\'#paint\')"/></svg>'],
        ['local use fragments', '<svg><path id="shape"/><use href="#shape"/></svg>'],
        ['narrow raster data URIs', '<svg><image href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/></svg>'],
    ])('keeps safe %s', (_name, svg) => {
        expect(parseSafeNativeSvgXml(svg)).not.toBeNull();
    });

    it('keeps ordinary SVG drawing, text, local fragments, and narrow raster data URIs', () => {
        const svg = [
            '<svg viewBox="0 0 16 16">',
            '<defs>',
            '<linearGradient id="paint"><stop offset="0" stop-color="#fff"/></linearGradient>',
            '<path id="shape" d="M0 0h16v16H0z"/>',
            '</defs>',
            '<rect width="16" height="16" fill="url(\'#paint\')"/>',
            '<use href="#shape"/>',
            '<text x="1" y="8">safe</text>',
            '<image href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/>',
            '</svg>',
        ].join('');

        expect(parseSafeNativeSvgXml(svg)).not.toBeNull();
    });
});
