import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installLocalSttProviderCommonModuleMocks } from '../localSttProviderTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installLocalSttProviderCommonModuleMocks();

vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
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
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'] },
        ],
      }),
    });
    (globalThis as any).fetch = fetchSpy;

    try {
      const setStt = vi.fn();
      const { googleGeminiSttProviderSpec } = await import('./googleGeminiSttProvider');

      let tree: any;
      tree = (await renderScreen(React.createElement(googleGeminiSttProviderSpec.Settings, {
          cfgStt: {
            provider: 'google_gemini',
            openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
            googleGemini: { apiKey: { _isSecretValue: true, value: 'k' }, model: 'gemini-2.5-flash', language: null },
          },
          setStt,
          popoverBoundaryRef: null,
        }))).tree;

      const modelDropdown = tree.root
        .findAllByType('DropdownMenu' as any)
        .find((d: any) => d.props?.searchPlaceholder === 'settingsVoice.local.googleGeminiStt.model.searchPlaceholder');
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
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
