import { describe, expect, it, vi } from 'vitest';

const openUrlSpy = vi.fn(async (_url: string) => {});
const tauriInvokeSpy = vi.fn(async (_command: string, _args?: Record<string, unknown>) => {});
const tauriState = vi.hoisted(() => ({ isDesktop: false }));

vi.mock('@/utils/platform/tauri', () => ({
  isTauriDesktop: () => tauriState.isDesktop,
  invokeTauri: (...args: [string, Record<string, unknown>?]) => tauriInvokeSpy(...args),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    Platform: {
                        OS: 'ios',
                    },
                    Linking: {
                        openURL: openUrlSpy,
                    },
                }
    );
});

describe('openExternalUrl', () => {
  it('opens web links with the system browser on Tauri desktop', async () => {
    tauriState.isDesktop = true;
    tauriInvokeSpy.mockClear();
    const { openExternalUrl } = await import('./openExternalUrl');
    try {
      await expect(openExternalUrl('https://example.com', { platformOS: 'web' })).resolves.toBe(true);
      expect(tauriInvokeSpy).toHaveBeenCalledWith('plugin:opener|open_url', { url: 'https://example.com' });
    } finally {
      tauriState.isDesktop = false;
    }
  });

  it('reports a desktop opener failure instead of falling back to the webview', async () => {
    tauriState.isDesktop = true;
    tauriInvokeSpy.mockImplementationOnce(async () => { throw new Error('opener unavailable'); });
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { openExternalUrl } = await import('./openExternalUrl');
    try {
      await expect(openExternalUrl('https://example.com', { platformOS: 'web' })).resolves.toBe(false);
      expect(report).toHaveBeenCalledOnce();
    } finally {
      report.mockRestore();
      tauriState.isDesktop = false;
    }
  });
  it('uses Linking.openURL on native', async () => {
    openUrlSpy.mockClear();
    const { openExternalUrl } = await import('./openExternalUrl');
    await openExternalUrl('https://example.com');
    expect(openUrlSpy).toHaveBeenCalledWith('https://example.com');
  });

  it('allows mailto links through the shared external-url flow', async () => {
    openUrlSpy.mockClear();
    const { openExternalUrl } = await import('./openExternalUrl');

    await openExternalUrl('mailto:person@example.com');

    expect(openUrlSpy).toHaveBeenCalledWith('mailto:person@example.com');
  });

  it('uses window.open on web when available', async () => {
    openUrlSpy.mockClear();
    const { openExternalUrl } = await import('./openExternalUrl');
    const prev = (globalThis as any).open;
    const openSpy = vi.fn();
    (globalThis as any).open = openSpy;
    try {
      await openExternalUrl('https://example.com', { platformOS: 'web' });
      expect(openSpy).toHaveBeenCalled();
      expect(openUrlSpy).not.toHaveBeenCalled();
    } finally {
      (globalThis as any).open = prev;
    }
  });

  it('rejects unsafe schemes', async () => {
    openUrlSpy.mockClear();
    const { openExternalUrl } = await import('./openExternalUrl');

    await expect(openExternalUrl('javascript:alert(1)')).resolves.toBe(false);
    expect(openUrlSpy).not.toHaveBeenCalled();
  });

  it('opens download handoffs in the current browser context without requiring a popup', async () => {
    const { openExternalUrl } = await import('./openExternalUrl');
    const open = vi.fn();
    vi.stubGlobal('open', open);
    try {
      await expect(openExternalUrl('https://files.example.ts.net/file', { platformOS: 'web', webTarget: '_self' })).resolves.toBe(true);
      expect(open).toHaveBeenCalledWith('https://files.example.ts.net/file', '_self', 'noopener,noreferrer');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
