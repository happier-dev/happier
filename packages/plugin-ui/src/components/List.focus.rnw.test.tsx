import * as React from 'react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

const VIRTUALIZED_WINDOW_SIZE = vi.hoisted(() => 12);

/**
 * An ASYNCHRONOUS virtualizer boundary.
 *
 * The sibling `List.virtualization.rnw.test.tsx` mock re-anchors its window
 * inside the imperative scroll call, so the revealed row is already mounted by
 * the time the collection owner's next commit runs. A real native virtualizer
 * does not: `scrollToIndex` schedules layout, and the target cell mounts one or
 * more frames later. Any owner that drops its pending focus request at the next
 * commit passes the synchronous mock and loses the focus move on device, so the
 * asynchronous timing is modelled here on purpose.
 */
const asyncVirtualizer = vi.hoisted(() => ({
  reveals: [] as Array<Readonly<{ method: string; index?: number; offset?: number }>>,
  /** Resolve every scheduled window move; nothing mounts until this runs. */
  settleReveals: [] as Array<() => void>,
}));

vi.mock('react-native', async () => {
  const native = await vi.importActual<typeof import('react-native')>('react-native');
  return {
    ...native,
    FlatList: function DeferredCapturingFlatList(props: Readonly<{
      data: readonly unknown[];
      keyExtractor(item: unknown, index: number): string;
      renderItem(input: Readonly<{ item: unknown; index: number }>): React.ReactNode;
      ListHeaderComponent?: React.ReactNode;
      ListEmptyComponent?: React.ReactNode;
      ListFooterComponent?: React.ReactNode;
      role?: 'list' | 'listbox';
      ref?: React.Ref<unknown>;
    }>) {
      const [windowStart, setWindowStart] = React.useState(0);
      const maximumWindowStart = Math.max(0, props.data.length - VIRTUALIZED_WINDOW_SIZE);
      const boundedWindowStart = Math.min(windowStart, maximumWindowStart);
      // The scheduled move is stored rather than applied: the test decides when
      // the revealed cell mounts, exactly as native layout timing decides it.
      const scheduleWindow = React.useCallback((index: number) => {
        asyncVirtualizer.settleReveals.push(() => {
          setWindowStart((current) => {
            const maximum = Math.max(0, props.data.length - VIRTUALIZED_WINDOW_SIZE);
            const start = Math.min(current, maximum);
            if (index >= start && index < start + VIRTUALIZED_WINDOW_SIZE) return current;
            // The owner reveals with `viewPosition: 0.5`, so the platform centres
            // the target rather than putting it at the window edge. Modelling that
            // is what lets a row stay mounted across a nearby reveal, which is the
            // only way to observe where focus actually LANDS after one.
            const centred = index - Math.floor(VIRTUALIZED_WINDOW_SIZE / 2);
            return Math.max(0, Math.min(centred, maximum));
          });
        });
      }, [props.data.length]);
      React.useImperativeHandle(props.ref, () => ({
        scrollToIndex(input: Readonly<{ index: number }>) {
          asyncVirtualizer.reveals.push({ method: 'scrollToIndex', index: input.index });
          scheduleWindow(input.index);
        },
        scrollToOffset(input: Readonly<{ offset: number }>) {
          asyncVirtualizer.reveals.push({ method: 'scrollToOffset', offset: input.offset });
          if (input.offset === 0) scheduleWindow(0);
        },
        scrollToEnd() {
          asyncVirtualizer.reveals.push({ method: 'scrollToEnd' });
          scheduleWindow(props.data.length - 1);
        },
      }), [props.data.length, scheduleWindow]);
      const windowItems = props.data.slice(
        boundedWindowStart,
        boundedWindowStart + VIRTUALIZED_WINDOW_SIZE,
      );
      return (
        <div role={props.role}>
          {props.ListHeaderComponent}
          {props.data.length === 0
            ? props.ListEmptyComponent
            : windowItems.map((item, offset) => {
                const index = boundedWindowStart + offset;
                return (
                  <React.Fragment key={props.keyExtractor(item, index)}>
                    {props.renderItem({ item, index })}
                  </React.Fragment>
                );
              })}
          {props.ListFooterComponent}
        </div>
      );
    },
  };
});

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { List } from './List.js';
import { PluginUiProvider } from './PluginUiProvider.js';

function mountList(children: React.ReactNode) {
  const context = createSurfaceContext();
  return mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      {children}
    </PluginUiProvider>,
  );
}

const reviews = Array.from({ length: 40 }, (_, index) => {
  const paddedIndex = String(index).padStart(2, '0');
  return { id: 'row-' + paddedIndex, label: 'Review ' + paddedIndex, blocked: index === 2 || index === 3 };
});
type Review = (typeof reviews)[number];

const optionsIn = (mount: Readonly<{ container: HTMLElement }>) => (
  Array.from(mount.container.querySelectorAll<HTMLElement>('[role="option"]'))
);
const optionNamed = (mount: Readonly<{ container: HTMLElement }>, label: string) => (
  optionsIn(mount).find((option) => option.textContent?.includes(label))
);
const tabStopIn = (mount: Readonly<{ container: HTMLElement }>) => (
  optionsIn(mount).find((option) => option.getAttribute('tabindex') === '0')
);

async function pressKey(target: HTMLElement | undefined, key: string): Promise<void> {
  await act(async () => {
    target?.focus();
    target?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

/** Mount everything the last reveal scheduled, the way a later native frame would. */
async function settleReveals(): Promise<void> {
  const pending = asyncVirtualizer.settleReveals.splice(0, asyncVirtualizer.settleReveals.length);
  await act(async () => {
    for (const settle of pending) settle();
  });
}

function renderReviewList(selectedKeys: string[], defaultSelectedKey = 'row-01') {
  return mountList(
    <List
      accessibilityLabel="Reviews"
      items={reviews}
      keyForItem={(item: Review) => item.id}
      renderItem={(item: Review) => <List.Item title={item.label} />}
      selection={{
        defaultSelectedKey,
        isItemDisabled: (item: Review) => item.blocked,
        onSelectedKeyChange: (key) => selectedKeys.push(key),
      }}
    />,
  );
}

describe('virtualized List focus and selection are independent', () => {
  it('moves logical focus with the arrow keys without changing the selected row', async () => {
    const selectedKeys: string[] = [];
    const mount = renderReviewList(selectedKeys);

    expect(optionNamed(mount, 'Review 01')?.getAttribute('aria-selected')).toBe('true');

    await pressKey(optionNamed(mount, 'Review 01'), 'ArrowDown');
    await settleReveals();

    // Rows 02/03 are author-disabled, so one ArrowDown lands on Review 04.
    expect(document.activeElement).toBe(optionNamed(mount, 'Review 04'));
    expect(tabStopIn(mount)).toBe(optionNamed(mount, 'Review 04'));
    expect(selectedKeys).toEqual([]);
    expect(optionNamed(mount, 'Review 01')?.getAttribute('aria-selected')).toBe('true');
    expect(optionNamed(mount, 'Review 04')?.getAttribute('aria-selected')).toBe('false');
    mount.unmount();
  });

  it('accepts the j and k list idiom for the same focus-only movement', async () => {
    const selectedKeys: string[] = [];
    const mount = renderReviewList(selectedKeys);

    await pressKey(optionNamed(mount, 'Review 01'), 'j');
    await settleReveals();
    expect(document.activeElement).toBe(optionNamed(mount, 'Review 04'));

    await pressKey(optionNamed(mount, 'Review 04'), 'k');
    await settleReveals();
    expect(document.activeElement).toBe(optionNamed(mount, 'Review 01'));

    expect(selectedKeys).toEqual([]);
    expect(optionNamed(mount, 'Review 01')?.getAttribute('aria-selected')).toBe('true');
    mount.unmount();
  });

  it('selects the focused row only when Enter activates it', async () => {
    const selectedKeys: string[] = [];
    const mount = renderReviewList(selectedKeys);

    await pressKey(optionNamed(mount, 'Review 01'), 'ArrowDown');
    await settleReveals();
    expect(selectedKeys).toEqual([]);

    const focused = optionNamed(mount, 'Review 04');
    await act(async () => {
      focused?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      focused?.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }));
    });

    expect(selectedKeys).toEqual(['row-04']);
    expect(optionNamed(mount, 'Review 04')?.getAttribute('aria-selected')).toBe('true');
    mount.unmount();
  });

  it('keeps a pending focus request until the revealed row actually registers', async () => {
    const selectedKeys: string[] = [];
    asyncVirtualizer.reveals.length = 0;
    const mount = renderReviewList(selectedKeys);

    await pressKey(optionNamed(mount, 'Review 01'), 'End');

    // The reveal has been asked for, but the target cell has not mounted yet —
    // exactly the native window in which a commit-scoped pending key is lost.
    expect(asyncVirtualizer.reveals.at(-1)?.method).toBe('scrollToEnd');
    expect(optionNamed(mount, 'Review 39')).toBeUndefined();

    await settleReveals();

    expect(document.activeElement).toBe(optionNamed(mount, 'Review 39'));
    expect(tabStopIn(mount)).toBe(optionNamed(mount, 'Review 39'));
    expect(selectedKeys).toEqual([]);
    mount.unmount();
  });

  it('lets a newer focus request supersede one whose row has not mounted yet', async () => {
    const selectedKeys: string[] = [];
    asyncVirtualizer.reveals.length = 0;
    const mount = renderReviewList(selectedKeys);

    await pressKey(optionNamed(mount, 'Review 01'), 'End');
    // The End target is still unmounted when Home is requested. Focus must land
    // on the newest request only, without a generation counter.
    await pressKey(tabStopIn(mount) ?? optionNamed(mount, 'Review 01'), 'Home');
    await settleReveals();

    expect(document.activeElement).toBe(optionNamed(mount, 'Review 00'));
    expect(optionNamed(mount, 'Review 39')).toBeUndefined();
    expect(selectedKeys).toEqual([]);
    mount.unmount();
  });

  it('retires an in-flight focus request when a pointer selection takes over', async () => {
    const selectedKeys: string[] = [];
    asyncVirtualizer.reveals.length = 0;
    const mount = renderReviewList(selectedKeys, 'row-11');

    // Row 12 sits one past the mounted window, so this reveal is genuinely
    // deferred — the native frame in which the request is still in flight.
    await pressKey(optionNamed(mount, 'Review 11'), 'ArrowDown');
    expect(optionNamed(mount, 'Review 12')).toBeUndefined();

    // A pointer press focuses and selects in one gesture; the reader has now
    // chosen a different row than the one the keyboard asked to reveal.
    const pointerRow = optionNamed(mount, 'Review 08');
    await act(async () => {
      pointerRow?.focus();
      pointerRow?.click();
    });
    expect(selectedKeys).toEqual(['row-08']);
    expect(document.activeElement).toBe(optionNamed(mount, 'Review 08'));

    await settleReveals();

    // The revealed row has mounted now. It must not pull focus off the row the
    // reader just chose, one or more frames after the interaction.
    expect(optionNamed(mount, 'Review 12')).toBeDefined();
    expect(document.activeElement).toBe(optionNamed(mount, 'Review 08'));
    expect(optionNamed(mount, 'Review 08')?.getAttribute('aria-selected')).toBe('true');
    mount.unmount();
  });

  it('continues navigation from the requested row while its reveal is still in flight', async () => {
    const selectedKeys: string[] = [];
    asyncVirtualizer.reveals.length = 0;
    const mount = renderReviewList(selectedKeys);

    await pressKey(optionNamed(mount, 'Review 01'), 'End');
    // The End target has not mounted, so the DOM focus is still on Review 01.
    // The next navigation key must continue from the row the reader asked for,
    // not from the stale physical position.
    expect(optionNamed(mount, 'Review 39')).toBeUndefined();
    await pressKey(optionNamed(mount, 'Review 01'), 'ArrowUp');
    await settleReveals();

    expect(document.activeElement).toBe(optionNamed(mount, 'Review 38'));
    expect(tabStopIn(mount)).toBe(optionNamed(mount, 'Review 38'));
    expect(selectedKeys).toEqual([]);
    mount.unmount();
  });

  it('does not let a refreshed item array steal focus or selection', async () => {
    const selectedKeys: string[] = [];
    const context = createSurfaceContext();

    function RefreshingList({ revision }: Readonly<{ revision: number }>) {
      // A scan/refresh/watch arrival replaces the array identity while row
      // identity is unchanged. Neither focus nor selection may move.
      const items = React.useMemo(
        () => reviews.map((review) => ({ ...review, label: review.label + ' r' + revision })),
        [revision],
      );
      return (
        <List
          accessibilityLabel="Reviews"
          items={items}
          keyForItem={(item: Review) => item.id}
          renderItem={(item: Review) => <List.Item title={item.label} />}
          selection={{
            defaultSelectedKey: 'row-01',
            isItemDisabled: (item: Review) => item.blocked,
            onSelectedKeyChange: (key) => selectedKeys.push(key),
          }}
        />
      );
    }

    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <RefreshingList revision={0} />
      </PluginUiProvider>,
    );

    await pressKey(optionNamed(mount, 'Review 01'), 'ArrowDown');
    await settleReveals();
    const focusedBefore = document.activeElement;
    expect(focusedBefore).toBe(optionNamed(mount, 'Review 04'));

    await mount.render(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <RefreshingList revision={1} />
      </PluginUiProvider>,
    );
    await settleReveals();

    expect(mount.container.textContent).toContain('Review 04 r1');
    expect(document.activeElement).toBe(focusedBefore);
    expect(tabStopIn(mount)).toBe(optionNamed(mount, 'Review 04'));
    expect(optionNamed(mount, 'Review 01')?.getAttribute('aria-selected')).toBe('true');
    expect(selectedKeys).toEqual([]);
    mount.unmount();
  });
});
