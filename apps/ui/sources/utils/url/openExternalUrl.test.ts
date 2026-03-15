import { describe, expect, it, vi } from 'vitest';

const openUrlSpy = vi.fn(async (_url: string) => {});

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Linking: { openURL: openUrlSpy },
}));

describe('openExternalUrl', () => {
  it('uses Linking.openURL on native', async () => {
    openUrlSpy.mockClear();
    const { openExternalUrl } = await import('./openExternalUrl');
    await openExternalUrl('https://example.com');
    expect(openUrlSpy).toHaveBeenCalledWith('https://example.com');
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
});
