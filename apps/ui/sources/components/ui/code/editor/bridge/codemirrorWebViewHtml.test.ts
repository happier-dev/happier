import { describe, expect, it } from 'vitest';

import { buildCodeMirrorWebViewHtml } from './codemirrorWebViewHtml';

describe('buildCodeMirrorWebViewHtml', () => {
    it('scales editor font metrics via uiFontScale', () => {
        const html = buildCodeMirrorWebViewHtml({
            theme: {
                backgroundColor: '#000',
                textColor: '#fff',
                dividerColor: '#333',
                isDark: true,
            },
            wrapLines: true,
            showLineNumbers: true,
            changeDebounceMs: 100,
            maxChunkBytes: 64_000,
            uiFontScale: 2,
        } as any);

        expect(html).toContain('font-size: 26px;');
        expect(html).toContain('line-height: 40px;');
    });
});

