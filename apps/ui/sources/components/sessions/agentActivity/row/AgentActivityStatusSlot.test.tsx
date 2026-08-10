import type { AgentActivityStatusV1 } from '@happier-dev/protocol';
import { AGENT_ACTIVITY_STATUSES_V1 } from '@happier-dev/protocol';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { lightTheme } from '@/theme';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

/**
 * The OS reduced-motion preference is a host property read through a platform adapter
 * (`AccessibilityInfo` / `matchMedia`) with a process-wide latch, so it is driven here through a
 * hoisted ref rather than by poking the platform twice in one file.
 */
const preferenceRef = vi.hoisted(() => ({ reducedMotion: false }));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => preferenceRef.reducedMotion,
}));

type IconLike = Readonly<{ name?: unknown; size?: unknown; color?: unknown }>;

async function renderSlot(props: Readonly<{ status: typeof AGENT_ACTIVITY_STATUSES_V1[number]; size?: number }>) {
    const { AgentActivityStatusSlot } = await import('./AgentActivityStatusSlot');
    return renderScreen(
        <AgentActivityStatusSlot status={props.status} size={props.size ?? 20} testID="slot" />,
    );
}

function findIcons(screen: Awaited<ReturnType<typeof renderScreen>>): IconLike[] {
    return screen.tree.root
        .findAll((node) => typeof (node.props as IconLike)?.name === 'string' && node.props.size != null)
        .map((node) => node.props as IconLike);
}

function findSpinners(screen: Awaited<ReturnType<typeof renderScreen>>) {
    return screen.tree.root.findAll((node) => node.props?.accessibilityRole === 'progressbar');
}

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>(
            (accumulator, entry) => ({ ...accumulator, ...flattenStyle(entry) }),
            {},
        );
    }
    if (style && typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

const SLOT_PX = 20;

async function renderSwappableSlot(status: AgentActivityStatusV1) {
    const { AgentActivityStatusSlot } = await import('./AgentActivityStatusSlot');
    const screen = await renderScreen(
        <AgentActivityStatusSlot status={status} size={SLOT_PX} testID="slot" />,
    );
    return {
        screen,
        async swapTo(next: AgentActivityStatusV1): Promise<void> {
            await act(async () => {
                screen.tree.update(
                    <AgentActivityStatusSlot status={next} size={SLOT_PX} testID="slot" />,
                );
            });
        },
    };
}

describe('AgentActivityStatusSlot', () => {
    it('gives every status its own glyph, so no glyph carries two meanings', async () => {
        preferenceRef.reducedMotion = false;
        const glyphs = new Map<string, string>();

        for (const status of AGENT_ACTIVITY_STATUSES_V1) {
            const screen = await renderSlot({ status });
            if (status === 'running') {
                expect(findSpinners(screen)).toHaveLength(1);
                await screen.unmount();
                continue;
            }
            const icons = findIcons(screen);
            expect(icons).toHaveLength(1);
            glyphs.set(status, String(icons[0].name));
            await screen.unmount();
        }

        const names = [...glyphs.values()];
        expect(names).toHaveLength(AGENT_ACTIVITY_STATUSES_V1.length - 1);
        expect(new Set(names).size).toBe(names.length);
    });

    it('keeps the running glyph distinct from every other status under reduced motion', async () => {
        preferenceRef.reducedMotion = false;
        const others = new Set<string>();
        for (const status of AGENT_ACTIVITY_STATUSES_V1) {
            if (status === 'running') continue;
            const screen = await renderSlot({ status });
            others.add(String(findIcons(screen)[0].name));
            await screen.unmount();
        }

        preferenceRef.reducedMotion = true;
        const reduced = await renderSlot({ status: 'running' });

        // A frozen spinner is invisible; reduced motion needs a real glyph, and it must not collide
        // with `queued`, which is the other "nothing is happening yet" mark.
        expect(findSpinners(reduced)).toHaveLength(0);
        const reducedGlyph = String(findIcons(reduced)[0].name);
        expect(others.has(reducedGlyph)).toBe(false);
        await reduced.unmount();
        preferenceRef.reducedMotion = false;
    });

    it('derives the spinner diameter from the glyph size instead of guessing it', async () => {
        preferenceRef.reducedMotion = false;
        const { iconMatchedSpinnerSize } = await import('@/components/ui/feedback/ActivitySpinner');
        const screen = await renderSlot({ status: 'running', size: 20 });

        const spinner = findSpinners(screen)[0];
        const style = Array.isArray(spinner.props.style)
            ? Object.assign({}, ...spinner.props.style.filter(Boolean))
            : spinner.props.style;

        // 16, not 20: a vector glyph draws its circle inset in its em box while a spinner's diameter
        // IS its box, so matching the numbers makes the running state read 1.25x its own outcome.
        expect(style.width).toBe(iconMatchedSpinnerSize(20));
        expect(style.width).not.toBe(20);
        await screen.unmount();
    });

    it('speaks the status, so a read-only row is not a coloured glyph with no name', async () => {
        preferenceRef.reducedMotion = false;
        const { resolveAgentActivityStatusWord } = await import('../presentation/agentActivityToneStyle');
        const screen = await renderSlot({ status: 'timedOut' });

        expect(screen.findByTestId('slot')?.props.accessibilityLabel)
            .toBe(resolveAgentActivityStatusWord('timedOut'));
        await screen.unmount();
    });

    it('tints the glyph from the shared tone table', async () => {
        preferenceRef.reducedMotion = false;
        const succeeded = await renderSlot({ status: 'succeeded' });
        expect(findIcons(succeeded)[0].color).toBe(lightTheme.colors.state.success.foreground);
        await succeeded.unmount();

        const cancelled = await renderSlot({ status: 'cancelled' });
        // A stop is neutral, never danger — the row must not read as an error the user caused.
        expect(findIcons(cancelled)[0].color).toBe(lightTheme.colors.state.neutral.foreground);
        expect(findIcons(cancelled)[0].color).not.toBe(lightTheme.colors.state.danger.foreground);
        await cancelled.unmount();
    });
});

/**
 * The settle: a spinner becoming a tick without the row moving.
 *
 * These assert the wiring, not the primitive — `StatusTransition.test.tsx` owns the curves and the
 * two-layer contract. What can only be checked here is that the slot actually routes its mark
 * through that primitive, hands it the fixed box, and keeps its single glyph table.
 */
describe('AgentActivityStatusSlot settle', () => {
    beforeEach(() => {
        preferenceRef.reducedMotion = false;
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('cross-fades the outgoing mark into the incoming one instead of cutting between them', async () => {
        const { screen, swapTo } = await renderSwappableSlot('running');
        expect(findSpinners(screen)).toHaveLength(1);

        await swapTo('succeeded');

        // Both marks are on screen at once. A cut would leave only the tick on the very frame the
        // run ended — and that frame is the whole "did it just work?" moment this animation serves.
        expect(findSpinners(screen)).toHaveLength(1);
        expect(findIcons(screen).map((icon) => String(icon.name))).toContain('check-circle');
    });

    it('holds the mark box at a fixed square, which is what keeps the row still', async () => {
        const { screen, swapTo } = await renderSwappableSlot('running');
        const running = flattenStyle(screen.findHostByTestId('slot:mark')?.props.style);
        expect(running.width).toBe(SLOT_PX);
        expect(running.height).toBe(SLOT_PX);

        await swapTo('succeeded');

        // A 16px spinner turning into a 20px glyph inside a content-sized box is a size jump at the
        // exact moment the eye is on it. The box is declared, so the swap cannot resize anything.
        const settled = flattenStyle(screen.findHostByTestId('slot:mark')?.props.style);
        expect(settled.width).toBe(SLOT_PX);
        expect(settled.height).toBe(SLOT_PX);
    });

    it('retires the outgoing mark once the settle has landed, leaving one', async () => {
        const { STATUS_TRANSITION_TIMELINE } = await import('@/components/ui/motion/StatusTransition');
        const { screen, swapTo } = await renderSwappableSlot('running');
        await swapTo('succeeded');
        expect(findSpinners(screen)).toHaveLength(1);

        await act(async () => {
            vi.advanceTimersByTime(STATUS_TRANSITION_TIMELINE.totalMs);
        });

        expect(findSpinners(screen)).toHaveLength(0);
        expect(findIcons(screen)).toHaveLength(1);
    });

    it('swaps the mark immediately under reduced motion, with nothing left behind', async () => {
        preferenceRef.reducedMotion = true;
        const { screen, swapTo } = await renderSwappableSlot('running');
        expect(findIcons(screen).map((icon) => String(icon.name))).toEqual(['circle-half']);

        await swapTo('succeeded');

        // The mark still changes — only its travel is removed. Two glyphs here would mean the
        // cross-fade ran anyway and a person who asked for less motion got a fade instead.
        expect(findIcons(screen).map((icon) => String(icon.name))).toEqual(['check-circle']);
    });
});
