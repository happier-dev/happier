import * as React from 'react';
import { View } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { TestGestureChain } from '@/dev/testkit';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';

import { PendingMessagesDragReorderList } from './PendingMessagesDragReorderList';

/**
 * M1 (2026-08-10) · the queued-message block is sized by its rows, and a drag does not resize it.
 *
 * The rows used to be `position: 'absolute'` inside a container whose height was a Reanimated shared
 * value recomputed from a per-row height map, with the account setting
 * `transcriptPendingQueueReorderRowHeightPx` (default 72) substituted for every row that had not
 * laid out yet. That is why the block painted a three-step 20.25 -> 92.25 -> 68.25 height on ~2
 * sends in 12 — a seed, then an estimate, then the truth — and every one of those steps was an MVCP
 * scroll adjust in the transcript above it.
 *
 * The removal is only correct if BOTH halves hold, so both are pinned here: nothing in this list
 * declares a height or a position (flow owns them, and an unlaid-out row therefore has no estimated
 * extent to be wrong about), and the drag still reorders — by transform, which carries no layout.
 *
 * The geometry itself is pinned separately in `pendingMessagesDragReorderGeometry.test.ts`; this
 * test exists because the removal changed a path the user can INTERACT with, and the block's own
 * test mocks this component away.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
/**
 * FILE-LOCAL spring fake, deliberately not the shared testkit's `withSpring`.
 *
 * P3 (2026-08-10) — the shared mock returns its argument (`dev/testkit/mocks/reanimated.ts`), which
 * makes `withSpring(0)` and the literal `0` this component returns for a zero displacement the same
 * observation. That is why deleting the zero-displacement snap left this whole lane green. Real
 * Reanimated returns an ANIMATION descriptor from `withSpring`, not a number, so modelling it as one
 * here is both more faithful and enough to tell a sprung transform from a settled one. The shared
 * mock keeps its identity behaviour for every other consumer.
 */
type SpringDrivenValue = Readonly<{ __animation: 'spring'; toValue: number }>;

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return {
        ...createReanimatedModuleMock(),
        withSpring: (toValue: number) => ({ __animation: 'spring', toValue }),
    };
});
vi.mock('react-native-gesture-handler', async () => {
    const { createGestureHandlerMock } = await import('@/dev/testkit/mocks/gestureHandler');
    return createGestureHandlerMock();
});
vi.mock('react-native-worklets', () => ({
    scheduleOnRN: (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => fn(...args),
}));

const ROW_HEIGHT_PX: Readonly<Record<string, number>> = { a: 60, b: 80, c: 40 };

function pendingMessage(id: string): PendingMessage {
    return { id, localId: null, createdAt: 1, updatedAt: 1 } as PendingMessage;
}

const MESSAGES: ReadonlyArray<PendingMessage> = ['a', 'b', 'c'].map(pendingMessage);

function renderRow(args: { message: PendingMessage; renderDragHandle: (a: Readonly<{ children: React.ReactNode; testID?: string }>) => React.ReactNode }): React.ReactNode {
    return (
        <View testID={`row-${args.message.id}`}>
            {args.renderDragHandle({ children: <View testID={`grip-${args.message.id}`} />, testID: `handle-${args.message.id}` })}
        </View>
    );
}

function styleEntries(instance: ReactTestInstance): ReadonlyArray<Record<string, unknown>> {
    const style = (instance.props as { style?: unknown }).style;
    if (!style) return [];
    return (Array.isArray(style) ? style : [style]).filter((entry): entry is Record<string, unknown> => (
        typeof entry === 'object' && entry !== null
    ));
}

function isSpringDriven(value: unknown): value is SpringDrivenValue {
    return typeof value === 'object'
        && value !== null
        && (value as { __animation?: unknown }).__animation === 'spring';
}

/** Both halves of what a row paints: where it sits, and whether a spring is driving it there. */
function rowTranslateY(instance: ReactTestInstance): Readonly<{ px: number; sprung: boolean }> {
    const transform = styleEntries(instance)
        .flatMap((entry) => (Array.isArray(entry.transform) ? entry.transform : []));
    const translate = transform.find((op): op is { translateY: unknown } => (
        typeof op === 'object' && op !== null && 'translateY' in op
    ));
    const value = translate?.translateY ?? 0;
    if (isSpringDriven(value)) return { px: value.toValue, sprung: true };
    return { px: typeof value === 'number' ? value : Number.NaN, sprung: false };
}

function mountQueue(onReorderIds: (ids: string[]) => void) {
    // A fresh `renderItem` identity per element so `React.memo` cannot skip a repaint: the derived
    // transforms we assert on are recomputed on render, exactly as a real frame recomputes them.
    const element = (messages: ReadonlyArray<PendingMessage>) => (
        <PendingMessagesDragReorderList
            messages={messages}
            onReorderIds={onReorderIds}
            renderItem={(args) => renderRow(args)}
        />
    );
    let tree!: renderer.ReactTestRenderer;
    act(() => {
        tree = renderer.create(element(MESSAGES));
    });
    // Every row reports the height it painted, exactly as `onLayout` does on device.
    const layoutHosts = tree.root.findAll((node) => typeof (node.props as { onLayout?: unknown }).onLayout === 'function');
    act(() => {
        layoutHosts.forEach((host, index) => {
            const id = MESSAGES[index]!.id;
            (host.props as { onLayout: (e: unknown) => void }).onLayout({ nativeEvent: { layout: { height: ROW_HEIGHT_PX[id] } } });
        });
    });
    const repaint = (messages: ReadonlyArray<PendingMessage> = MESSAGES) => act(() => {
        tree.update(element(messages));
    });
    repaint();
    return {
        tree,
        repaint,
        rows: () => tree.root.findAllByType('Animated.View' as unknown as React.ComponentType),
        dragHandleGesture: (index: number) => (
            tree.root.findAllByType('GestureDetector' as unknown as React.ComponentType)[index]!.props.gesture as TestGestureChain
        ),
    };
}

describe('PendingMessagesDragReorderList · flow layout', () => {
    it('declares no height and no position: the rows in flow are the block’s only height owner', () => {
        const queue = mountQueue(() => {});
        const declared = queue.tree.root.findAll(() => true)
            .flatMap(styleEntries)
            .flatMap((entry) => ['height', 'position', 'top', 'bottom'].filter((key) => entry[key] !== undefined));
        // The removed model declared `height: totalHeightSv` on the container and
        // `position: 'absolute', top: 0` on every row — three owners of one height, and an
        // unmeasured row contributed an ESTIMATED 72px to it.
        expect(declared).toEqual([]);
    });

    it('paints an idle queue with no transform at all, so a fresh row lands where flow puts it', () => {
        const queue = mountQueue(() => {});
        // `sprung: false` is the load-bearing half: a spring toward 0 would also read 0px here, and
        // it is a running animation on a row whose slot is already correct.
        expect(queue.rows().map(rowTranslateY)).toEqual([
            { px: 0, sprung: false },
            { px: 0, sprung: false },
            { px: 0, sprung: false },
        ]);
    });

    it('reorders on drag and moves the displaced rows by transform only', () => {
        const onReorderIds = vi.fn();
        const queue = mountQueue(onReorderIds);
        const gesture = queue.dragHandleGesture(0);

        act(() => { gesture.__handlers.onStart?.(); });
        // Far enough that the dragged row’s CENTRE clears the last row’s midpoint.
        act(() => { gesture.__handlers.onUpdate?.({ translationY: 150 }); });
        queue.repaint();

        // The dragged row follows the finger directly (no spring — it must track the touch); the two
        // it passed SPRING into the 60px slot it vacated. Both are transforms, so the block’s height
        // is identical to the idle frame above.
        expect(queue.rows().map(rowTranslateY)).toEqual([
            { px: 150, sprung: false },
            { px: -60, sprung: true },
            { px: -60, sprung: true },
        ]);

        act(() => { gesture.__handlers.onEnd?.(); });
        expect(onReorderIds).toHaveBeenCalledWith(['b', 'c', 'a']);
    });

    it('SNAPS to no transform once the reorder is persisted, instead of springing to zero', () => {
        const onReorderIds = vi.fn();
        const queue = mountQueue(onReorderIds);
        const gesture = queue.dragHandleGesture(0);
        act(() => { gesture.__handlers.onStart?.(); });
        act(() => { gesture.__handlers.onUpdate?.({ translationY: 150 }); });
        act(() => { gesture.__handlers.onEnd?.(); });

        // The persisted order arrives as new props: each row’s flow slot moves by exactly the
        // displacement its transform held, so the transform must be gone on that same frame or the
        // motion paints twice. A spring toward 0 is NOT gone — it is an animation still running
        // over a slot that already moved — which is why `sprung` is asserted alongside the pixels.
        const reordered = (onReorderIds.mock.calls[0]![0] as string[]).map(pendingMessage);
        queue.repaint(reordered);
        expect(queue.rows().map(rowTranslateY)).toEqual([
            { px: 0, sprung: false },
            { px: 0, sprung: false },
            { px: 0, sprung: false },
        ]);
    });
});
