// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Text, View } from 'react-native';
import { afterEach, expect, it, vi } from 'vitest';

import {
  installWebLayoutBridge,
  measureWebLayout,
} from '@/dev/testkit/render/measureWebLayout';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

installWebLayoutBridge();

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

async function renderLine(widthPx: number) {
  const { HappierSurfaceState } =
    await import('@happier-dev/plugin-ui/presentation');
  const bindings = {
    renderText: (input: { role: string; children: React.ReactNode }) => (
      <Text
        testID={input.role === 'line' ? 'sentence' : undefined}
        style={{ fontSize: 12.5, lineHeight: 17 }}
      >
        {input.children}
      </Text>
    ),
    renderButton: () => null,
    renderSpinner: () => null,
    renderTile: () => null,
    renderDetailsCaret: () => null,
    detailsLabel: 'Details',
    pressedFill: 'transparent',
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <View testID="page" style={{ width: widthPx }}>
        <HappierSurfaceState
          testID="notice"
          kind="unavailable"
          size="line"
          bindings={bindings as never}
          glyph={<View testID="glyph" style={{ width: 14, height: 14 }} />}
          lineText="Couldn’t reach 4 sources · Their items are hidden for now; everything else is here."
          action={{ label: 'Retry', onPress: () => {}, testID: 'retry' }}
          secondaryAction={{
            label: 'Details',
            onPress: () => {},
            testID: 'details',
          }}
        />
      </View>,
    ),
  );
  return measureWebLayout(host, {
    viewport: { width: Math.max(widthPx, 400), height: 600 },
    texts: ['Retry'],
    settle: (replay) => act(replay),
  });
}

/**
 * OWNER-UI-1115B A2: the Store's "Couldn't reach N sources" notice stood inset from the page's titles, dropped
 * Retry and Details to a second line and spread them apart. Loose on a page (no list, sheet, menu or body
 * edge around it) the one inline notice stands on the page text edge (18 px, where the page's titles start),
 * keeps its recoveries on its own line where they fit, and under the sentence they start on its words.
 */
it('stands a loose page notice on the text edge with its recoveries inline beside the sentence', async () => {
  const layout = await renderLine(1000);
  const page = layout.rect('page');
  expect(layout.rect('glyph').left).toBeCloseTo(page.left + 18, 0);
  const sentence = layout.rect('sentence');
  const retry = layout.rect('retry');
  const details = layout.rect('details');
  expect(retry.top).toBeLessThan(sentence.bottom);
  expect(details.top).toBeLessThan(sentence.bottom);
  // The two recoveries read as one pair, not two spread-out buttons.
  expect(details.left - retry.right).toBeLessThanOrEqual(4);
});

it('moves the recoveries under the sentence in a narrow column, aligned with its words', async () => {
  const layout = await renderLine(300);
  const sentence = layout.rect('sentence');
  const retryLabel = layout.textRects('Retry')[0]!;
  expect(layout.rect('retry').top).toBeGreaterThanOrEqual(
    sentence.bottom - 0.5,
  );
  expect(retryLabel.left).toBeCloseTo(sentence.left, 0);
});
