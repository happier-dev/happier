import * as React from 'react';
import { act } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';

import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';

// The dialog is the platform boundary: the confirmation's words are what the person decides on.
const modal = vi.hoisted(() => ({
  confirm: null as unknown as ReturnType<typeof vi.fn>,
}));
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit');
  const mock = createModalModuleMock({ confirmResult: true });
  modal.confirm = mock.module.Modal.confirm as unknown as ReturnType<
    typeof vi.fn
  >;
  return mock.module;
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit');
  return createTextModuleMock();
});

import {
  DiscussionStorageView,
  type DiscussionStorageFile,
} from './DiscussionStorageView';
import {
  confirmRemoveDiscussionFile,
  confirmTrimOldVersions,
} from '../storageConfirmations';

afterEach(() => {
  vi.clearAllMocks();
});

const storage = (bytes: number) =>
  formatHappierDataBytes(bytes, { kind: 'storage' });
const AT = Date.UTC(2026, 10, 12, 14, 2);

// In the storage read owner's order (largest first); the view keeps it and never re-sorts a page.
const FILES: readonly DiscussionStorageFile[] = [
  {
    key: 'video',
    name: 'checkout-bug-repro.mov',
    author: 'Mika Tanaka',
    at: AT,
    bytes: 64_200_000,
    canRemove: false,
  },
  {
    key: 'trace',
    name: 'network-trace.har',
    author: 'You',
    at: AT,
    bytes: 9_800_000,
    canRemove: true,
  },
];

function textOf(node: ReactTestInstance | null): string {
  if (node === null) return '';
  return node.children
    .map((child) => (typeof child === 'string' ? child : textOf(child)))
    .join('');
}

/** Each row's "…" menu, by the ids it offers. */
function rowMenus(screen: Awaited<ReturnType<typeof renderScreen>>): string[][] {
  const isMenu = (node: ReactTestInstance) =>
    Array.isArray(node.props.items) && typeof node.props.onSelect === 'function' && node.props.triggerIcon === 'more';
  const insideAnother = (node: ReactTestInstance) => {
    for (let parent = node.parent; parent; parent = parent.parent) if (isMenu(parent)) return true;
    return false;
  };
  // A menu's wrapper and its control both carry the items: count the outermost one per row.
  return screen
    .findAll((node) => isMenu(node) && !insideAnother(node))
    .map((node) => (node.props.items as Array<{ id: string }>).map((item) => item.id));
}

describe('Storage scoped to one Discussion (storage-view lab scene 5 A, scene 3)', () => {
  it("says the Discussion's total and share of the Account, lists its files in the owner's order, and offers Remove only where admitted", async () => {
    const screen = await renderScreen(
      <DiscussionStorageView
        totalBytes={86_400_000}
        accountTotalBytes={1_840_000_000}
        files={FILES}
        presentation="pane"
        onShowInMessage={vi.fn()}
        onDownload={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    try {
      expect(
        textOf(screen.findHostByTestId('storage:discussion:say')),
      ).toContain(
        `artifacts.browser.storageView.discussion.say(size=${storage(86_400_000)},count=2)`,
      );
      expect(
        textOf(screen.findHostByTestId('storage:discussion:share-figure')),
      ).toContain(storage(86_400_000));
      await act(async () => {
        invokeTestInstanceHandler(
          screen.findHostByTestId('storage:discussion:files:stage'),
          'onLayout',
          {
            nativeEvent: { layout: { x: 0, y: 0, width: 340, height: 800 } },
          },
        );
      });
      await vi.waitFor(() =>
        expect(
          textOf(screen.findHostByTestId('storage:discussion:file:video:size')),
        ).toBe(storage(64_200_000)),
      );
      const order = [
        ...new Set(
          screen
            .findAll(
              (node) =>
                typeof node.type === 'string' &&
                /^storage:discussion:file:[^:]+$/.test(
                  String(node.props.testID ?? ''),
                ),
            )
            .map((node) => String(node.props.testID)),
        ),
      ];
      expect(order).toEqual([
        'storage:discussion:file:video',
        'storage:discussion:file:trace',
      ]);
      const menus = rowMenus(screen);
      expect(menus).toHaveLength(2);
      expect(menus.filter((ids) => ids.includes('remove'))).toEqual([
        ['show', 'download', 'remove'],
      ]);
    } finally {
      await screen.unmount();
    }
  });

  it("names the Discussion in the phone page's description, and keeps the general one while its title is unknown", async () => {
    for (const [discussionTitle, description] of [
      ['Checkout bug triage', 'artifacts.browser.storageView.discussion.descriptionNamed(title=Checkout bug triage)'],
      [null, 'artifacts.browser.storageView.discussion.description'],
    ] as const) {
      const screen = await renderScreen(
        <DiscussionStorageView totalBytes={86_400_000} accountTotalBytes={null} files={FILES} presentation="page"
          discussionTitle={discussionTitle} onRemove={vi.fn()} />,
      );
      try {
        const text = textOf(screen.findHostByTestId('storage:discussion'));
        expect(text).toContain(description);
        if (discussionTitle === null) expect(text).not.toContain('descriptionNamed');
      } finally {
        await screen.unmount();
      }
    }
  });

  it('confirms with what clearing frees, and for old versions what the Artifact limit becomes', async () => {
    await expect(
      confirmRemoveDiscussionFile({
        name: 'api-trace-export.har',
        discussionTitle: 'Release planning',
        own: true,
        freesBytes: 18_600_000,
      }),
    ).resolves.toBe(true);
    const [removeTitle, , removeOptions] = modal.confirm.mock.calls[0]!;
    expect(removeTitle).toBe(
      'artifacts.browser.storageView.confirm.removeTitle(name=api-trace-export.har)',
    );
    expect(removeOptions.destructive).toBe(true);
    // What clearing frees is one of the dialog's facts: a label and the producer's number.
    expect(removeOptions.facts).toEqual([
      { label: 'artifacts.browser.storageView.confirm.freesLabel', value: storage(18_600_000) },
    ]);

    await expect(
      confirmTrimOldVersions({
        title: 'Q4 launch plan',
        freesBytes: 186_000_000,
        limitAfter: { leftBytes: 3_566_000_000, limitBytes: 5_000_000_000 },
      }),
    ).resolves.toBe(true);
    const [, , trimOptions] = modal.confirm.mock.calls[1]!;
    // What the limit becomes is the producer's own number (the trim's preview); the dialog only says it.
    expect(trimOptions.facts).toEqual([
      { label: 'artifacts.browser.storageView.confirm.freesLabel', value: storage(186_000_000) },
      { label: 'artifacts.browser.storageView.confirm.limitAfterLabel',
        value: `artifacts.browser.storageView.confirm.limitAfterValue(left=${storage(3_566_000_000)},limit=${storage(5_000_000_000)})` },
    ]);
  });
});
