// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { expect, it, vi } from 'vitest';

import {
  installWebLayoutBridge,
  measureWebLayout,
} from '@/dev/testkit/render/measureWebLayout';
import { CollectionConditionTokens } from './CollectionConditionTokens';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);

installWebLayoutBridge();

const TOKENS = [
  { id: 'coordinators', label: 'Kind', valueLabel: 'Coordinators' },
  { id: 'statuses', label: 'Status', valueLabel: 'Failed' },
] as const;

async function measureLine(width: number) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <View testID="column" style={{ width }}>
        <CollectionConditionTokens
          testIDPrefix="line"
          tokens={TOKENS}
          onRemove={() => {}}
          onSave={() => {}}
        />
      </View>,
    ),
  );
  const layout = await measureWebLayout(host, {
    viewport: { width: 1200, height: 900 },
    settle: async (replay) => {
      await act(replay);
    },
  });
  return {
    layout,
    dispose: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

it('keeps every condition in sight in a narrow sidebar column: tokens wrap and Save shrinks to its icon', async () => {
  // A 272 px sidebar column leaves 236 px for the line (Coordination visual acceptance 11-07: "Failed" scrolled away).
  const { layout, dispose } = await measureLine(236);
  try {
    const row = layout.rect('line-chips');
    const save = layout.rect('line-tokens-save');
    for (const id of TOKENS.map((token) => `line-token:${token.id}`)) {
      const token = layout.rect(id);
      // In sight: inside the row, under nothing (a token scrolled under Save takes no pointer), never under Save.
      expect(token.receivesPointer).toBe(true);
      expect(token.left).toBeGreaterThanOrEqual(row.left - 0.5);
      expect(token.right).toBeLessThanOrEqual(row.right + 0.5);
      const overlapsSave = token.left < save.right && token.right > save.left && token.top < save.bottom && token.bottom > save.top;
      expect(overlapsSave).toBe(false);
    }
    expect(save.right).toBeLessThanOrEqual(row.right + 0.5);
    // The words give way to the icon; the control keeps its name.
    const saveNode = document.querySelector('[data-testid="line-tokens-save"]');
    expect(saveNode?.textContent).toBe('');
    expect(saveNode?.getAttribute('aria-label')).toBe('Save as space…');
  } finally {
    await dispose();
  }
});

it('keeps one line with Save in words where every condition fits', async () => {
  const { layout, dispose } = await measureLine(600);
  try {
    const first = layout.rect('line-token:coordinators');
    const second = layout.rect('line-token:statuses');
    expect(Math.abs(first.top - second.top)).toBeLessThanOrEqual(1);
    expect(document.querySelector('[data-testid="line-tokens-save"]')?.textContent).toBe('Save as space');
  } finally {
    await dispose();
  }
});
