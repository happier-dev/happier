// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { View } from 'react-native';
import { afterEach, expect, it, vi } from 'vitest';

import {
  installWebLayoutBridge,
  measureWebLayout,
} from '@/dev/testkit/render/measureWebLayout';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
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

/**
 * A card drawn with no number column (the Sentence view's Workflow options) on a phone's grid sits on its
 * host's edge, like the sentence above it. WF-REDESIGN 11-17: at 390 it ran full-bleed (x≈0).
 */
it("keeps a card with no number column on its host's edge on a phone grid", async () => {
  const { WorkflowCardGutterRow, WorkflowKindCard } =
    await import('./WorkflowKindCard');
  const { WorkflowDocumentGridContext } =
    await import('./workflowEditorStyles');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <View style={{ width: 390, paddingLeft: 18, paddingRight: 18 }}>
        <View testID="edge" style={{ height: 1 }} />
        <WorkflowDocumentGridContext.Provider value="compact">
          <WorkflowCardGutterRow icon={null}>
            <WorkflowKindCard testID="card" title="How and where it runs" />
          </WorkflowCardGutterRow>
        </WorkflowDocumentGridContext.Provider>
      </View>,
    ),
  );
  const layout = await measureWebLayout(host, {
    viewport: { width: 390, height: 600 },
    settle: (replay) => act(replay),
  });
  const edge = layout.rect('edge');
  const card = layout.rect('card');
  expect(Math.abs(card.left - edge.left)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(card.right - edge.right)).toBeLessThanOrEqual(0.5);
});

/**
 * The phone's first cards (WF-ACCEPT-1119 item 4): each card's mark stands in the number column on the page edge,
 * beside its card rather than under it, and the cards keep the steps' name edge.
 */
it('stands a first card beside its mark on the phone grid', async () => {
  const { WorkflowCardGutterRow, WorkflowKindCard } =
    await import('./WorkflowKindCard');
  const { WorkflowDocumentGridContext } =
    await import('./workflowEditorStyles');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <View style={{ width: 390, paddingLeft: 18, paddingRight: 18 }}>
        <View testID="edge" style={{ height: 1 }} />
        <WorkflowDocumentGridContext.Provider value="phone">
          <WorkflowCardGutterRow icon="clock" spineTo="card">
            <WorkflowKindCard testID="card" title="When it runs" />
          </WorkflowCardGutterRow>
        </WorkflowDocumentGridContext.Provider>
      </View>,
    ),
  );
  const layout = await measureWebLayout(host, {
    viewport: { width: 390, height: 600 },
    settle: (replay) => act(replay),
  });
  const edge = layout.rect('edge');
  const card = layout.rect('card');
  // The card starts one number column (22) and the header's mark gap in, leaving the mark its column (never
  // under the card, as the lone card's grid draws it), and ends on the page's edge.
  expect(card.left - edge.left).toBeGreaterThan(22);
  expect(card.left - edge.left).toBeLessThanOrEqual(34);
  expect(Math.abs(card.right - edge.right)).toBeLessThanOrEqual(0.5);
});
