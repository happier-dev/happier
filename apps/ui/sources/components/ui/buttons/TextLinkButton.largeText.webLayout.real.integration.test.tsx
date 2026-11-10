// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { View } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { Typography } from '@/constants/Typography';
import { measureWebLayout } from '@/dev/testkit/render/measureWebLayout';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
// The in-app text size is device-local storage, outside the link owner.
vi.mock('@/sync/store/hooks', () => ({ useLocalSetting: () => 1 }));

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

async function renderLinkAboveText() {
  const { TextLinkButton } = await import('./TextLinkButton');
  const { Text } = await import('@/components/ui/text/Text');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <View style={{ width: 360, alignItems: 'flex-start' }}>
        <TextLinkButton testID="link" label="Unarchive" onPress={() => {}} />
        <Text testID="below" style={Typography.variant('meta')}>
          Archived 3 days ago
        </Text>
      </View>,
    );
  });
  return host;
}

describe('an inline text link, as a browser lays it out', () => {
  it('is exactly one row-description line at the default text size', async () => {
    const layout = await measureWebLayout(await renderLinkAboveText(), {
      viewport: { width: 400, height: 200 },
    });
    expect(layout.rect('link').height).toBe(
      happierPageTextMetrics('rowDescription').lineHeight,
    );
  });

  it('keeps its whole label above the next line when the browser enlarges text', async () => {
    // Large text at Chrome's minimum font size 24 (DARK-1109-L1): a link sized to the small line let
    // its label run into the line below it.
    const layout = await measureWebLayout(await renderLinkAboveText(), {
      viewport: { width: 400, height: 200 },
      texts: ['Unarchive'],
      minimumFontSize: 24,
    });
    const label = layout.textRects('Unarchive')[0]!;
    expect(label.fontSize).toBeGreaterThanOrEqual(24);
    expect(
      layout.rect('below').top,
      'the next line starts below the label',
    ).toBeGreaterThanOrEqual(label.bottom - 0.5);
  });
});
