// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { expect, it, vi } from 'vitest';

import { measureWebLayout } from '@/dev/testkit/render/measureWebLayout';
import type { MarkdownEditorController } from '@/components/ui/markdown/editor/markdownEditorTypes';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);

const { MarkdownEditorToolbar } = await import('./MarkdownEditorToolbar');

const CHIP_IDS = [
  'heading1',
  'heading2',
  'heading3',
  'bold',
  'italic',
  'strike',
  'code',
  'bulletList',
  'orderedList',
  'taskList',
  'blockquote',
  'codeBlock',
  'horizontalRule',
] as const;

// The toolbar's input contract: the editor surface publishes selection and takes commands.
const controller = {
  runCommand: () => {},
  subscribeSelection: () => () => {},
} as unknown as MarkdownEditorController;

it('keeps every formatting action reachable by scrolling when the inline toolbar is narrower than its keys', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    // A phone Doc header: the toolbar's flexible slot beside the Rich | Raw switch, as the field lays them out.
    await act(async () =>
      root.render(
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            width: 358,
            gap: 8,
          }}
        >
          <View
            testID="slot"
            style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}
          >
            <MarkdownEditorToolbar
              controller={controller}
              variant="inline"
              testID="tb"
            />
          </View>
          <View style={{ width: 101, height: 34, flexShrink: 0 }} />
        </View>,
      ),
    );
    const layout = await measureWebLayout(host, {
      viewport: { width: 390, height: 700 },
    });
    const slot = layout.rect('slot');
    const viewport = layout.rect('tb:scroll');
    // The scroll viewport is the slot, so nothing is cut off by the slot's edge…
    expect(viewport.right).toBeLessThanOrEqual(slot.right + 0.5);
    // …and the keys past its edge are scrolled to, not clipped away.
    const last = layout.rect(`tb:${CHIP_IDS[CHIP_IDS.length - 1]}`);
    expect(viewport.scrollWidth ?? 0).toBeGreaterThanOrEqual(
      Math.floor(last.right - viewport.left),
    );
    for (const id of CHIP_IDS) {
      const chip = layout.rect(`tb:${id}`);
      if (chip.right <= viewport.right) expect(chip.receivesPointer).toBe(true);
    }
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
