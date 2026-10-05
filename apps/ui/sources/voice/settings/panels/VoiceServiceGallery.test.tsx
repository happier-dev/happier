import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { VoiceServiceGallery, type VoiceServiceTile } from './VoiceServiceGallery';

// Icons are a native rendering boundary; the gallery, tiles and rows stay real.
vi.mock('@expo/vector-icons', async () => {
  const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
  return createExpoVectorIconsMock();
});

const TILES: VoiceServiceTile[] = [
  { id: 'local_conversation', title: 'Local voice', status: { tone: 'needs_you', text: 'Speak needs its voice model' }, selected: true, disabled: false, testID: 'settings.voice.provider.local.default' },
  { id: 'elevenlabs', title: 'ElevenLabs', status: { tone: 'ready', text: 'Ready' }, selected: false, disabled: false, testID: 'settings.voice.provider.elevenlabs.default' },
];

async function layoutAt(screen: Awaited<ReturnType<typeof renderScreen>>, width: number) {
  const host = screen.root.findAll((node) => typeof node.props.onLayout === 'function' && typeof node.type === 'string')[0];
  await act(async () => {
    host!.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height: 200 } } });
  });
}

describe('VoiceServiceGallery', () => {
  it('on a narrow page names the service in use and pushes the service list instead of squeezing tiles', async () => {
    const onOpenServiceList = vi.fn();
    const screen = await renderScreen(
      <VoiceServiceGallery tiles={TILES} offSelected={false} onSelect={vi.fn()} onSelectOff={vi.fn()} onOpenServiceList={onOpenServiceList} />,
    );

    await layoutAt(screen, 1200);
    expect(screen.root.findAll((node) => node.props.testID === 'settings.voice.service.current')).toHaveLength(0);

    await layoutAt(screen, 390);
    const current = screen.root.findAll((node) => node.props.testID === 'settings.voice.service.current'
      && typeof node.props.onPress === 'function')[0];
    expect(current?.props.title).toBe('Local voice');
    expect(current?.props.subtitle).toBe('Speak needs its voice model');
    await act(async () => { current!.props.onPress(); });
    expect(onOpenServiceList).toHaveBeenCalledTimes(1);
  });
});
