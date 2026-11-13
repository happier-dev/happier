import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const viewport = vi.hoisted(() => ({
  width: 390,
  height: 844,
  scale: 1,
  fontScale: 1,
}));

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({ useWindowDimensions: () => viewport });
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
// Radix owns the DOM boundary; modal custody and chrome stay real.
vi.mock('@/utils/web/radixCjs', async () => {
  const { createRadixCjsModuleMock } = await import('@/dev/testkit/mocks/radixCjs');
  return createRadixCjsModuleMock();
});

const { ModalProvider, useModal } = await import('@/modal/ModalProvider');
const { WorkflowSaveStatus } = await import('./WorkflowSaveStatus');

type ModalEntries = ReturnType<typeof useModal>['state']['modals'];

afterEach(async () => {
  await standardCleanup();
});

const draft = {
  draftId: 'local-draft',
  name: 'Review',
  version: 1 as const,
  defaults: {},
  inputs: [],
  blocks: [
    {
      kind: 'step' as const,
      id: 'review',
      document: {
        text: 'Review local changes',
        references: [],
        attachments: [],
      },
      input: [],
      result: { kind: 'text' as const },
    },
  ],
};

async function renderConflict() {
  let entries: ModalEntries = [];
  function ObserveModals() {
    entries = useModal().state.modals;
    return null;
  }
  const screen = await renderScreen(
    <ModalProvider>
      <ObserveModals />
      <WorkflowSaveStatus
        state={{
          kind: 'conflict',
          conflict: {
            currentDraft: { ...draft, draftId: 'current', name: 'Theirs' },
            currentRevision: { headerVersion: 2, bodyVersion: 3 },
          },
        }}
        localDraft={draft}
        onSaveAsCopy={() => {}}
        testIDPrefix="editor"
      />
    </ModalProvider>,
  );
  return {
    screen,
    visible: () =>
      entries.filter((entry) => 'visible' in entry && entry.visible === true),
  };
}

describe('WorkflowSaveStatus Compare width', () => {
  it('opens the comparison as a full-width bottom sheet on a phone instead of inside the status column', async () => {
    viewport.width = 390;
    const { screen, visible } = await renderConflict();
    await screen.pressByTestIdAsync('editor-compare');
    expect(screen.findByTestId('editor-comparison')).toBeNull();
    expect(visible()).toHaveLength(1);
    const [sheet] = visible();
    expect(sheet?.type === 'custom' ? sheet.chrome : null).toMatchObject({
      kind: 'card',
      phonePresentation: 'sheet',
    });
  });

  it('opens the comparison in the centred card on a wide layout, not in the header status column', async () => {
    viewport.width = 1440;
    const { screen, visible } = await renderConflict();
    await screen.pressByTestIdAsync('editor-compare');
    expect(screen.findByTestId('editor-comparison')).toBeNull();
    expect(visible()).toHaveLength(1);
    // Pressing Compare again takes the comparison down.
    await screen.pressByTestIdAsync('editor-compare');
    expect(visible()).toHaveLength(0);
  });
});
