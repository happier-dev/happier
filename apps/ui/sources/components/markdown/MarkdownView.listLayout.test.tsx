import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { MarkdownView } from './MarkdownView';
import { renderScreen } from '@/dev/testkit';


declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./MermaidRenderer', () => ({
    MermaidRenderer: () => null,
}));

describe('MarkdownView (lists)', () => {
    it('routes unordered list prose to the enriched renderer for native range selection', async () => {
        const screen = await renderScreen(<MarkdownView
            markdown={[
                '- Parent',
                '  - Child',
            ].join('\n')}
        />);

        const enrichedRun = screen.findByType('EnrichedMarkdownText');
        expect(enrichedRun.props.markdown).toBe('- Parent\n  - Child');
        expect(screen.findAll((node) => node.props?.testID === 'markdown-list-item-row')).toHaveLength(0);
    }, 60_000);
});
