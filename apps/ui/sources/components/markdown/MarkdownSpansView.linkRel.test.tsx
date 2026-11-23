import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installMarkdownCommonModuleMocks } from './markdownTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installMarkdownCommonModuleMocks();

function mockPlatform(os: 'web' | 'ios') {
  vi.doMock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
      Platform: {
        OS: os,
      },
    });
  });
}

vi.mock('../ui/text/Text', () => ({
  Text: (props: any) => React.createElement('Text', props, props.children),
}));

describe('MarkdownSpansView (link rel hardening)', () => {
  it('adds rel="noopener noreferrer" for spans with url (web anchor attrs path)', async () => {
    mockPlatform('web');
    vi.resetModules();

    const { MarkdownSpansView } = await import('./MarkdownSpansView');

    const screen = await renderScreen(<MarkdownSpansView
          spans={[{ text: 'example', styles: [], url: 'https://example.com' }] as any}
        />);

    const link = screen.findByType('Link' as any);
    expect(link.props.href).toBe('https://example.com');
    expect(link.props.target).toBe('_blank');
    expect(link.props.rel).toBe('noopener noreferrer');
    // On web we intentionally avoid `asChild` so Expo Router can forward href attrs to an anchor-like element.
    expect(link.props.asChild).toBe(false);
  });

  it('renders link spans as selectable Text on native so long-press selection works', async () => {
    mockPlatform('ios');
    vi.resetModules();

    const { MarkdownSpansView } = await import('./MarkdownSpansView');

    const screen = await renderScreen(<MarkdownSpansView
          spans={[{ text: 'example', styles: [], url: 'https://example.com' }] as any}
        />);

    const link = screen.findByType('Link' as any);
    expect(link.props.asChild).toBe(true);
    const childText = screen.findByType('Text' as any);
    expect(childText.props.selectable).toBe(true);
  });
});

describe('MarkdownSpansView (streaming placeholder links)', () => {
  // Special blocks share the streaming repair source with prose, including placeholder destinations.
  it('renders a still-streaming link label as inert text with no destination', async () => {
    mockPlatform('web');
    vi.resetModules();

    const { MarkdownSpansView } = await import('./MarkdownSpansView');
    const onLinkPress = vi.fn();

    const screen = await renderScreen(<MarkdownSpansView
          onLinkPress={onLinkPress}
          spans={[{ text: 'zlink-006', styles: [], url: 'streamdown:incomplete-link' }] as any}
        />);

    expect(screen.findAllByType('Link' as any)).toHaveLength(0);
    const label = screen.findByType('Text' as any);
    expect(label.props.onPress).toBeUndefined();
    expect(String(JSON.stringify(label.props))).not.toContain('streamdown:incomplete-link');
  });
});
