import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-unistyles', () => {
  const theme = { colors: { textSecondary: '#999' } };
  return {
    useUnistyles: () => ({ theme }),
    StyleSheet: {
      create: (factory: any) => (typeof factory === 'function' ? {} : factory),
      absoluteFillObject: {},
    },
  };
});

vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

vi.mock('@/text', () => ({
  t: (key: string) => key,
}));

vi.mock('@/modal', () => ({
  Modal: {
    prompt: vi.fn(),
    alert: vi.fn(),
  },
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    decryptSecretValue: (value: any) => (value && typeof value.value === 'string' ? value.value : null),
  },
}));

vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
  DropdownMenu: (props: any) =>
    React.createElement(
      'DropdownMenu',
      props,
      typeof props.trigger === 'function'
        ? props.trigger({ open: false, toggle: () => {}, openMenu: () => {}, closeMenu: () => {} })
        : props.trigger ?? null,
    ),
}));

describe('GoogleGeminiSttSettings', () => {
  it('populates model dropdown from Google and updates settings on select', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'] },
        ],
      }),
    });
    (globalThis as any).fetch = fetchSpy;

    const setStt = vi.fn();
    const { googleGeminiSttProviderSpec } = await import('./googleGeminiSttProvider');

    let tree: any;
    await act(async () => {
      tree = renderer.create(
        React.createElement(googleGeminiSttProviderSpec.Settings, {
          cfgStt: {
            provider: 'google_gemini',
            openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
            googleGemini: { apiKey: { _isSecretValue: true, value: 'k' }, model: 'gemini-2.5-flash', language: null },
          },
          setStt,
          popoverBoundaryRef: null,
        }),
      );
      await Promise.resolve();
    });

    const modelDropdown = tree.root
      .findAllByType('DropdownMenu' as any)
      .find((d: any) => d.props?.searchPlaceholder === 'Search models');
    expect(modelDropdown).toBeTruthy();

    await act(async () => {
      modelDropdown.props.onSelect?.('gemini-2.5-flash');
    });

    expect(setStt).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'google_gemini',
        googleGemini: expect.objectContaining({ model: 'gemini-2.5-flash' }),
      }),
    );
  });
});
