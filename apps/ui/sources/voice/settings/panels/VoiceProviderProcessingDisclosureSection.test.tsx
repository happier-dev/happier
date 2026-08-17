import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { OPENAI_REALTIME_DEFAULT_SETTINGS } from '../../../../../../packages/plugins/openai/src/protocol/voice/settings';

vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
  ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

describe('VoiceProviderProcessingDisclosureSection', () => {
  it('renders selected-provider processing disclosures without a subtitle line limit', async () => {
    const { VoiceProviderProcessingDisclosureSection } = await import('./VoiceProviderProcessingDisclosureSection');
    const screen = await renderScreen(React.createElement(VoiceProviderProcessingDisclosureSection, {
      voice: {
        providerId: 'happier.voice.openai/realtime-openai',
        providers: {
          'happier.voice.openai/realtime-openai': {
            schemaVersion: 1,
            config: OPENAI_REALTIME_DEFAULT_SETTINGS,
          },
        },
      },
    } as any));

    const disclosure = screen.findByTestId('settings.voice.provider.disclosure.happier.voice.openai%2Frealtime-openai');
    expect(disclosure).toBeTruthy();
    expect(disclosure?.props.subtitleLines).toBe(0);
  });
});
