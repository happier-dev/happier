import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installMarkdownCommonModuleMocks } from './markdownTestHelpers';

declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

installMarkdownCommonModuleMocks();

const openExternalUrl = vi.fn(async (_url: string) => undefined);
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: (url: string) => openExternalUrl(url) }));

describe('MarkdownView inline references', () => {
    it('draws a cited reference inline with the owner’s label and hands its press to the owner, never opening it', async () => {
        const { MarkdownView } = await import('./MarkdownView');
        const onPress = vi.fn();
        const references = {
            scheme: 'finding',
            resolve: (target: string) => (target === 'codex-run:f1'
                ? { label: 'High · Codex', foreground: '#c00', background: '#fee' }
                : null),
            onPress,
        };
        const screen = await renderScreen(
            <MarkdownView
                markdown={'It now calls the same hook, which leaves one case open [the sheet](finding:codex-run:f1); [gone](finding:other) stays text.'}
                inlineReferences={references}
            />,
        );

        const run = screen.findAllByType('EnrichedMarkdownText')[0]!;
        // The citation sits where the narrator put it, labelled by the owner; an unknown one is plain text.
        expect(run.props.markdown).toContain('open [● High · Codex](happier-ref:finding:codex-run:f1);');
        expect(run.props.markdown).toContain('; gone stays text.');

        await act(async () => { run.props.onLinkPress({ url: 'happier-ref:finding:codex-run:f1' }); });
        expect(onPress).toHaveBeenCalledWith('codex-run:f1');
        expect(openExternalUrl).not.toHaveBeenCalled();
    });

    it('leaves a reference link as plain text when nobody owns its scheme', async () => {
        const { MarkdownView } = await import('./MarkdownView');
        const screen = await renderScreen(<MarkdownView markdown={'See [the sheet](finding:codex-run:f1) here.'} />);
        expect(screen.findAllByType('EnrichedMarkdownText')[0]!.props.markdown).toBe('See the sheet here.');
    });
});
