import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { createOnShouldStartLoadWithRequest } from 'react-native-webview/src/WebViewShared';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
beforeEach(async () => {
  await homes.reset();
  const serverId = await homes.addHome({ name: 'Mermaid copy', serverUrl: 'https://mermaid-copy.test', accountId: 'copy-owner' });
  await homes.selectHomes([serverId]);
});


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const clipboardMocks = vi.hoisted(() => ({
  setStringAsync: vi.fn(async () => true),
}));
const modalMocks = vi.hoisted(() => ({
  alert: vi.fn(),
}));
const linkingMocks = vi.hoisted(() => ({
  canOpenURL: vi.fn(async () => true),
  openURL: vi.fn(async () => {}),
}));
vi.mock('expo-clipboard', () => clipboardMocks);

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: modalMocks }).module;
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios' }, Linking: linkingMocks });
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
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

// Metro registers the packaged runtime asset and expo-asset resolves it: platform boundaries.
// The real generated runtime is read through the real asset owner.
const runtimeAsset = vi.hoisted(() => ({ reads: 0, failNext: false }));
vi.mock('./mermaidWebViewBundle.generated', () => ({
  requireMermaidWebViewBundleAsset: () => 'mermaid-runtime-asset', MERMAID_WEBVIEW_BUNDLE_BYTES: 0,
}));
vi.mock('expo-asset', () => ({
  Asset: {
    fromModule: (asset: string) => ({
      localUri: `file:///app/assets/${asset}`,
      downloadAsync: async () => {
        runtimeAsset.reads += 1;
        if (runtimeAsset.failNext) {
          runtimeAsset.failNext = false;
          throw new Error('asset unavailable');
        }
      },
    }),
  },
}));
// The runtime is served from the canonical native file-system boundary (vitestSetup's testkit mock).
beforeEach(async () => {
  // File identities belong to Node, not Vite's client asset URL transform.
  const { getVitestNodeBuiltin } = await import('@/dev/vitestNodeBuiltins');
  const fs = getVitestNodeBuiltin<typeof import('node:fs')>('node:fs');
  const path = getVitestNodeBuiltin<typeof import('node:path')>('node:path');
  const url = getVitestNodeBuiltin<typeof import('node:url')>('node:url');
  const { File } = await import('expo-file-system');
  const runtime = new File('file:///app/assets/mermaid-runtime-asset');
  if (runtime.exists) return;
  runtime.write(new Uint8Array(fs.readFileSync(path.join(path.dirname(url.fileURLToPath(import.meta.url)), 'mermaidWebViewBundle.generated.bundle'))));
});

// The runtime read settles after mount; its state update commits inside act.
async function waitForMountedWebView() {
  await vi.waitFor(async () => {
    await flushHookEffects();
    expect(getCapturedWebViewProps()).not.toBeNull();
  });
}

async function renderMountedMermaid(content: string) {
  const { MermaidRenderer } = await import('./MermaidRenderer');
  webViewCapture.props = null;
  const screen = await renderScreen(<MermaidRenderer content={content} />);
  await waitForMountedWebView();
  return screen;
}

describe('MermaidRenderer', () => {
  it('reads the packaged runtime when a diagram mounts, shares it with later diagrams and retries a failed read', async () => {
    // First in this file, so no diagram has read the runtime yet.
    runtimeAsset.reads = 0;
    runtimeAsset.failNext = true;
    const first = await renderMountedMermaid('graph TD\\nA-->B');
    // A failed read mounts without the runtime, so the page's own error path reports the diagram.
    expect(getCapturedWebViewProps()?.injectedJavaScriptBeforeContentLoaded).toBeUndefined();
    act(() => { first.tree.unmount(); });

    const second = await renderMountedMermaid('graph TD\\nB-->C');
    expect(getCapturedWebViewProps()?.injectedJavaScriptBeforeContentLoaded).toContain('HAPPIER_MERMAID_REMOVE_NAVIGATION=');
    const third = await renderMountedMermaid('graph TD\\nC-->D');
    expect(getCapturedWebViewProps()?.injectedJavaScriptBeforeContentLoaded).toContain('HAPPIER_MERMAID_REMOVE_NAVIGATION=');
    expect(runtimeAsset.reads).toBe(2);
    act(() => { second.tree.unmount(); third.tree.unmount(); });
  });

  it('copies raw Mermaid source to clipboard', async () => {
    const { MermaidRenderer } = await import('./MermaidRenderer');

    let tree: ReturnType<typeof renderer.create> | undefined;
    try {
      const screen = await renderScreen(<MermaidRenderer content={'graph TD\\nA-->B'} />);
      tree = screen.tree;
      await waitForMountedWebView();

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
    webViewCapture.props = null;
    const payload = 'graph TD\\nA-->B\\n%% </div><img src=x onerror=alert(1)>\\n';

    let tree: ReturnType<typeof renderer.create> | undefined;
    try {
      tree = (await renderScreen(<MermaidRenderer content={payload} />)).tree;
      await waitForMountedWebView();

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
    await waitForMountedWebView();

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
      await waitForMountedWebView();
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
