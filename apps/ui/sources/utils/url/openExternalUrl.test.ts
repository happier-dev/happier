import { describe, expect, it, vi } from 'vitest';

const openUrlSpy = vi.fn(async (_url: string) => {});

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
});
