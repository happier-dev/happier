import * as React from 'react';
import { Platform } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { resolveFileViewerKind } from '@/scm/utils/filePresentation';

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit');
  return createTextModuleMock();
});

// react-test-renderer has no DOM portal container; keep the real shell and guest
// logic while representing only ReactDOM's cross-document mount boundary.
vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  createPortal: (children: React.ReactNode) => children,
}));

import { FileViewerBody } from './FileViewerBody';

const platform = Platform.OS;
afterEach(() => {
  Object.defineProperty(Platform, 'OS', {
    configurable: true,
    value: platform,
  });
  vi.unstubAllGlobals();
});

const html = '<h1>Agent report</h1><script>document.title = "ran"</script>';

async function renderHtmlBody(heldText: string | null) {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
  vi.stubGlobal('window', { location: { origin: 'https://app.example.test' } });
  return renderScreen(
    <FileViewerBody
      viewer={resolveFileViewerKind({ path: 'reports/index.html' })}
      title="index.html"
      source={{ kind: 'unavailable' } as never}
      heldText={heldText}
      isActive
      findSurfaceId="find"
      testID="file-viewer-body"
    />,
  );
}

describe('FileViewerBody HTML preview', () => {
  it('renders the held HTML in the same opaque, network-less sandbox Artifacts use', async () => {
    const screen = await renderHtmlBody(html);
    await flushHookEffects();
    const shell = screen.findHostByTestId(
      'file-viewer-body:htmlPreview-navigation-shell',
    );
    if (!shell) throw new Error('HTML navigation shell did not mount');
    await act(async () => {
      shell.props.onLoad({ currentTarget: { contentDocument: { body: {} } } });
    });
    const frame = screen.findHostByTestId('file-viewer-body:htmlPreview');
    if (!frame) throw new Error('HTML guest did not mount');
    // Scripts run, but in an opaque origin: no Happier storage, cookies or credentials.
    expect(frame.props).toMatchObject({
      sandbox: 'allow-scripts',
      referrerPolicy: 'no-referrer',
      title: 'index.html',
    });
    expect(frame.props.src).toBeUndefined();
    expect(frame.props.onMessage).toBeUndefined();
    expect(frame.props.srcDoc).toContain('<h1>Agent report</h1>');
    expect(frame.props.srcDoc).toContain('connect-src data:;');
  });

  it('shows the failure state, not an empty frame, when the guest fails', async () => {
    const screen = await renderHtmlBody(html);
    await flushHookEffects();
    const shell = screen.findHostByTestId(
      'file-viewer-body:htmlPreview-navigation-shell',
    );
    await act(async () => {
      shell!.props.onLoad({ currentTarget: { contentDocument: { body: {} } } });
    });
    await act(async () => {
      screen.findHostByTestId('file-viewer-body:htmlPreview')!.props.onError();
    });
    expect(
      screen.findByTestId('file-viewer-body:htmlPreviewFailed'),
    ).not.toBeNull();
    expect(screen.tree.root.findAllByType('iframe')).toHaveLength(0);
  });
});
