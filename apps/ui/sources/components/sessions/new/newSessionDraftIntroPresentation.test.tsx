import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { withDraftIntroPresentation } from './newSessionDraftIntroPresentation';

type Panel = Readonly<{ composerTopContent?: React.ReactNode; other: number }>;

describe('withDraftIntroPresentation', () => {
    it('stacks a seeded draft\'s intro above the card\'s own top content, where the dock seats its frost', () => {
        const intro = <span key="intro">intro</span>;
        const panel: Panel = { composerTopContent: <span>header</span>, other: 1 };
        const next = withDraftIntroPresentation(panel, intro);
        expect(next).not.toBe(panel);
        expect(next.other).toBe(1);
        const children = React.Children.toArray((next.composerTopContent as React.ReactElement<{ children: React.ReactNode }>).props.children);
        expect(children).toHaveLength(2);
        expect((children[0] as React.ReactElement).key).toContain('intro');
    });

    it('leaves a draft without an intro exactly as it was', () => {
        const panel: Panel = { composerTopContent: <span>header</span>, other: 1 };
        expect(withDraftIntroPresentation(panel, null)).toBe(panel);
        expect(withDraftIntroPresentation(panel, undefined)).toBe(panel);
    });
});
