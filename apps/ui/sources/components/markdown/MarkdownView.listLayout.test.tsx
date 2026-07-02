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

vi.mock('./MarkdownCodeBlock', () => ({
    MarkdownCodeBlock: (props: Record<string, unknown>) =>
        React.createElement('MarkdownCodeBlock', props),
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

    it('normalizes loose ordered outline continuations before enriched rendering', async () => {
        const markdown = [
            '1. Provider cards as operational dashboards.',
            '',
            'The first description should stay inside the first item.',
            '',
            '2. Explicit switch mode vs additive mode.',
            '',
            'The second description should stay inside the second item.',
            '',
            '**Next Section**',
        ].join('\n');

        const screen = await renderScreen(<MarkdownView markdown={markdown} />);

        const enrichedRun = screen.findByType('EnrichedMarkdownText');
        expect(enrichedRun.props.markdown).toBe([
            '1. Provider cards as operational dashboards.',
            '',
            '   The first description should stay inside the first item.',
            '',
            '2. Explicit switch mode vs additive mode.',
            '',
            '   The second description should stay inside the second item.',
            '',
            '**Next Section**',
        ].join('\n'));
    }, 60_000);

    it('passes repaired multi-block ordered lists to the enriched renderer', async () => {
        const markdown = [
            '1. Add a “Provider Accounts” quick-switch screen.',
            '',
            'Build on existing connected services and account groups. Show:',
            '',
            '- Provider/agent.',
            '- Current connected profile.',
            '',
            'Use existing architecture:',
            '',
            '- `packages/agents/src/manifest.ts`',
            '- `apps/cli/src/backends/catalog.ts`',
            '',
            '2. Add compact provider/account cards.',
        ].join('\n');

        const screen = await renderScreen(<MarkdownView markdown={markdown} />);

        const enrichedRun = screen.findByType('EnrichedMarkdownText');
        expect(enrichedRun.props.markdown).toBe([
            '1. Add a “Provider Accounts” quick-switch screen.',
            '',
            '   Build on existing connected services and account groups. Show:',
            '',
            '   - Provider/agent.',
            '   - Current connected profile.',
            '',
            '   Use existing architecture:',
            '',
            '   - `packages/agents/src/manifest.ts`',
            '   - `apps/cli/src/backends/catalog.ts`',
            '',
            '2. Add compact provider/account cards.',
        ].join('\n'));
    }, 60_000);

    it('does not normalize loose ordered continuations inside fenced code', async () => {
        const markdown = [
            '```md',
            '1. **First idea**',
            '',
            'The first description is code.',
            '',
            '2. **Second idea**',
            '```',
        ].join('\n');

        const screen = await renderScreen(<MarkdownView markdown={markdown} />);

        expect(screen.findAllByType('EnrichedMarkdownText')).toHaveLength(0);
        const codeBlock = screen.findByType('MarkdownCodeBlock');
        expect(codeBlock.props.content).toBe([
            '1. **First idea**',
            '',
            'The first description is code.',
            '',
            '2. **Second idea**',
        ].join('\n'));
    }, 60_000);
});
