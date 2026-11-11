/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { measureWebLayout } from '@/dev/testkit/render/measureWebLayout';

// RNW supplies the real web implementations of the React Native host contract.
vi.mock('react-native', async () => vi.importActual('react-native-web'));

it('starting a selection leaves the transcript where it was: the bar floats above the composer (owner 06)', async () => {
  const { View } = await import('react-native');
  const { TranscriptSelectionToolbarSeat } =
    await import('./TranscriptSelectionToolbarSeat');
  // The pane column: the transcript fills what the composer stack leaves, and the stack spaces its children.
  const pane = (selecting: boolean) => (
    <View testID="pane" style={{ height: 600, width: 390 }}>
      <View testID="transcript" style={{ flex: 1 }} />
      <View testID="composer-stack" style={{ gap: 8 }}>
        {selecting ? (
          <TranscriptSelectionToolbarSeat>
            <View
              testID="selection-bar"
              style={{ height: 44, width: 300, alignSelf: 'center' }}
            />
          </TranscriptSelectionToolbarSeat>
        ) : null}
        <View testID="composer" style={{ height: 96 }} />
      </View>
    </View>
  );
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(pane(false)));
    const before = await measureWebLayout(host, {
      viewport: { width: 390, height: 844 },
    });
    await act(async () => root.render(pane(true)));
    const during = await measureWebLayout(host, {
      viewport: { width: 390, height: 844 },
    });
    expect(during.rect('transcript').height).toBe(
      before.rect('transcript').height,
    );
    expect(during.rect('composer').top).toBe(before.rect('composer').top);
    // The bar stands just above the composer, over the end of the transcript.
    const bar = during.rect('selection-bar');
    expect(bar.bottom).toBeLessThanOrEqual(during.rect('composer').top);
    expect(bar.bottom).toBeGreaterThan(during.rect('composer').top - 16);
    expect(bar.receivesPointer).toBe(true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
