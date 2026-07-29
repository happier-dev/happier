import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { createOnShouldStartLoadWithRequest } from 'react-native-webview/src/WebViewShared';
import { renderScreen } from '@/dev/testkit';
import { installMarkdownCommonModuleMocks } from './markdownTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const clipboardMocks = vi.hoisted(() => ({
  setStringAsync: vi.fn(async () => {}),
}));
const modalMocks = vi.hoisted(() => ({
  alert: vi.fn(),
}));
const linkingMocks = vi.hoisted(() => ({
  canOpenURL: vi.fn(async () => true),
  openURL: vi.fn(async () => {}),
}));
vi.mock('expo-clipboard', () => clipboardMocks);

installMarkdownCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: modalMocks,
        }).module;
    },
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
            },
            Linking: linkingMocks,
        });
    },
    storage: async () =>
        await vi.importActual<typeof import('@/sync/domains/state/storage')>(
            '@/sync/domains/state/storage',
        ),
});

let lastWebViewHtml: string | null = null;
const webViewCapture = vi.hoisted((): { props: Record<string, unknown> | null } => ({ props: null }));
const getCapturedWebViewProps = (): Record<string, unknown> | null => webViewCapture.props;
vi.mock('react-native-webview', () => ({
  WebView: (props: any) => {
    lastWebViewHtml = props?.source?.html ?? null;
    webViewCapture.props = props;
    return null;
  },
}));

describe('MermaidRenderer', () => {
  it('copies raw Mermaid source to clipboard', async () => {
    const { MermaidRenderer } = await import('./MermaidRenderer');

    let tree: ReturnType<typeof renderer.create> | undefined;
    try {
      const screen = await renderScreen(<MermaidRenderer content={'graph TD\\nA-->B'} />);
      tree = screen.tree;

      expect(screen.findByTestId('mermaid-copy-button')).not.toBeNull();

      clipboardMocks.setStringAsync.mockClear();
      modalMocks.alert.mockClear();
      await screen.pressByTestIdAsync('mermaid-copy-button');

      expect(clipboardMocks.setStringAsync).toHaveBeenCalledWith('graph TD\\nA-->B');
      expect(modalMocks.alert).not.toHaveBeenCalledWith('common.success', 'markdown.codeCopied', expect.anything());
      expect(screen.findByTestId('mermaid-copy-feedback')).not.toBeNull();
    } finally {
      act(() => {
        tree?.unmount();
      });
    }
  });

  it('does not interpolate Mermaid source into native WebView HTML', async () => {
    const { MermaidRenderer } = await import('./MermaidRenderer');

    lastWebViewHtml = null;
    const payload = 'graph TD\\nA-->B\\n%% </div><img src=x onerror=alert(1)>\\n';

    let tree: ReturnType<typeof renderer.create> | undefined;
    try {
      tree = (await renderScreen(<MermaidRenderer content={payload} />)).tree;

      expect(typeof lastWebViewHtml).toBe('string');
      expect(lastWebViewHtml).toContain('<div id=\"mermaid-container\"></div>');
      // The source must not be placed as raw HTML content inside the container.
      expect(lastWebViewHtml).not.toContain(`<div id=\"mermaid-container\" class=\"mermaid\">`);
      expect(lastWebViewHtml).not.toContain(payload);
    } finally {
      act(() => {
        tree?.unmount();
      });
    }
  });

  it('uses only the local Mermaid runtime in a constrained native WebView', async () => {
    const { MermaidRenderer, shouldAllowMermaidWebViewNavigation } = await import('./MermaidRenderer');

    lastWebViewHtml = null;
    webViewCapture.props = null;
    await renderScreen(<MermaidRenderer content={'graph TD\\nA-->B'} />);

    expect(lastWebViewHtml).toContain('Content-Security-Policy');
    expect(lastWebViewHtml).not.toMatch(/https?:\/\//);
    const capturedProps = getCapturedWebViewProps();
    expect(capturedProps?.injectedJavaScriptBeforeContentLoaded).toContain('HAPPIER_MERMAID');
    expect(lastWebViewHtml).toContain('HAPPIER_MERMAID_REMOVE_NAVIGATION');
    expect(capturedProps?.allowFileAccess).toBe(false);
    expect(capturedProps?.mixedContentMode).toBe('never');
    expect(capturedProps?.originWhitelist).toEqual(['*']);
    expect(capturedProps?.javaScriptCanOpenWindowsAutomatically).toBe(false);
    expect(capturedProps?.setSupportMultipleWindows).toBe(false);
    expect(shouldAllowMermaidWebViewNavigation('about:blank')).toBe(true);
    expect(shouldAllowMermaidWebViewNavigation('https://attacker.example')).toBe(false);
  });

  it('routes every native navigation through the deny policy without invoking OS Linking', async () => {
    const { MermaidRenderer } = await import('./MermaidRenderer');

    linkingMocks.canOpenURL.mockClear();
    linkingMocks.openURL.mockClear();
    webViewCapture.props = null;
    let tree: ReturnType<typeof renderer.create> | undefined;
    try {
      tree = (await renderScreen(<MermaidRenderer content={'graph TD\\nA-->B'} />)).tree;
      const capturedProps = getCapturedWebViewProps();
      const loadRequest = vi.fn();
      const wrapperHandler = createOnShouldStartLoadWithRequest(
        loadRequest,
        capturedProps?.originWhitelist as readonly string[],
        capturedProps?.onShouldStartLoadWithRequest as (request: { url: string }) => boolean,
      );

      for (const [index, url] of [
        'https://attacker.example/path',
        'happier-test://open',
        '/relative-target',
        'about:blank',
      ].entries()) {
        wrapperHandler({
          nativeEvent: {
            url,
            lockIdentifier: index + 1,
          },
        } as never);
      }
      await Promise.resolve();
      await Promise.resolve();

      expect(loadRequest.mock.calls.map(([allowed, url]) => [allowed, url])).toEqual([
        [false, 'https://attacker.example/path'],
        [false, 'happier-test://open'],
        [false, '/relative-target'],
        [true, 'about:blank'],
      ]);
      expect(linkingMocks.canOpenURL).not.toHaveBeenCalled();
      expect(linkingMocks.openURL).not.toHaveBeenCalled();
    } finally {
      act(() => {
        tree?.unmount();
      });
    }
  });
});
