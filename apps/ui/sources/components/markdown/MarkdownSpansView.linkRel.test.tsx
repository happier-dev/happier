import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

function mockPlatform(os: 'web' | 'ios') {
  vi.doMock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
            Platform: {
                OS: os,
            },
        }
    );
});
}

vi.mock('../ui/text/Text', () => ({
  Text: (props: any) => React.createElement('Text', props, props.children),
}));

describe('MarkdownSpansView (link rel hardening)', () => {
  it('adds rel="noopener noreferrer" for spans with url (web anchor attrs path)', async () => {
    vi.resetModules();
    mockPlatform('web');

    const { MarkdownSpansView } = await import('./MarkdownSpansView');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<MarkdownSpansView
          linkStyle={{ color: 'red' }}
          spans={[{ text: 'example', styles: [], url: 'https://example.com' }] as any}
        />)).tree;

    const link = tree.root.findByType('Link' as any);
    expect(link.props.target).toBe('_blank');
    expect(link.props.rel).toBe('noopener noreferrer');
    // On web we intentionally avoid `asChild` so Expo Router can forward href attrs to an anchor-like element.
    expect(link.props.asChild).toBe(false);
    const style = link.props.style;
    expect(Array.isArray(style)).toBe(true);
    expect(style[0]).toEqual({ color: 'red' });
  });

  it('renders link spans as selectable Text on native so long-press selection works', async () => {
    vi.resetModules();
    mockPlatform('ios');

    const { MarkdownSpansView } = await import('./MarkdownSpansView');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<MarkdownSpansView
          spans={[{ text: 'example', styles: [], url: 'https://example.com' }] as any}
        />)).tree;

    const link = tree.root.findByType('Link' as any);
    expect(link.props.asChild).toBe(true);
    const childText = link.findByType('Text' as any);
    expect(childText.props.selectable).toBe(true);
  });
});
