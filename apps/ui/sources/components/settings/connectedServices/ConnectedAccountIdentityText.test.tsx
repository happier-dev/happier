import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const platform = vi.hoisted(() => ({ os: 'web' as 'web' | 'ios' }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            get OS() { return platform.os; },
            select: (options: Record<string, unknown>) => options[platform.os] ?? options.default,
        },
    });
});

import { ConnectedAccountIdentityText } from './ConnectedAccountIdentityText';

function blurredRuns(screen: Awaited<ReturnType<typeof renderScreen>>) {
    return screen.findAll((node) => {
        const styles = [node.props?.style].flat(Infinity) as Array<Record<string, unknown> | undefined>;
        return typeof node.type === 'string' && styles.some((style) => typeof style?.filter === 'string' && String(style.filter).includes('blur'));
    });
}

describe('ConnectedAccountIdentityText (lab csvc PV: a partial blur that still tells accounts apart)', () => {
    it('blurs only the hidden runs on the web, keeping the readable letters sharp and never drawing the mask glyphs', async () => {
        platform.os = 'web';
        const screen = await renderScreen(<ConnectedAccountIdentityText value="ke•••@g•••.com" />);

        expect(blurredRuns(screen)).toHaveLength(2);
        const text = screen.getTextContent();
        expect(text).toContain('ke');
        expect(text).toContain('.com');
        expect(text).not.toContain('•••');
    });

    it('falls back to the mask text where a blur is not available', async () => {
        platform.os = 'ios';
        const screen = await renderScreen(<ConnectedAccountIdentityText value="ke•••@g•••.com" />);

        expect(blurredRuns(screen)).toHaveLength(0);
        expect(screen.getTextContent()).toContain('ke•••@g•••.com');
    });

    it('draws a visible identity as it is', async () => {
        platform.os = 'web';
        const screen = await renderScreen(<ConnectedAccountIdentityText value="kevin@gmail.com" />);

        expect(blurredRuns(screen)).toHaveLength(0);
        expect(screen.getTextContent().replace(/\s/g, '')).toContain('kevin@gmail.com');
    });

    it('keeps an address one string whose domain is one atomic run, so a narrow column wraps it after the @ and never mid-word', async () => {
        platform.os = 'web';
        const screen = await renderScreen(<ConnectedAccountIdentityText value="ai1@happier.dev" />);
        // (The test renderer joins adjacent runs with a space; the DOM text stays "ai1@happier.dev".)
        expect(screen.getTextContent().replace(/\s/g, '')).toBe('ai1@happier.dev');
        const atomic = screen.findAll((node) => typeof node.type === 'string'
            && [node.props?.style].flat(Infinity).some((style: { display?: string } | undefined) => style?.display === 'inline-block'));
        expect(atomic.map((node) => node.children.join(''))).toEqual(['happier.dev']);
        const plain = await renderScreen(<ConnectedAccountIdentityText value="ChatGPT account 2" />);
        expect(plain.getTextContent()).toBe('ChatGPT account 2');
    });

    it('keeps a one-line address one plain run, so the line is cut in its domain and the local part stays whole (acceptance 11-21 #4)', async () => {
        platform.os = 'web';
        const screen = await renderScreen(<ConnectedAccountIdentityText value="leeroy.brun@gmail.com" numberOfLines={1} />);
        const atomic = screen.findAll((node) => typeof node.type === 'string'
            && [node.props?.style].flat(Infinity).some((style: { display?: string } | undefined) => style?.display === 'inline-block'));
        expect(atomic).toHaveLength(0);
        expect(screen.getTextContent()).toBe('leeroy.brun@gmail.com');
    });
});
