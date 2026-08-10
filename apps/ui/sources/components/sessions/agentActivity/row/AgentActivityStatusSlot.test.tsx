import { AGENT_ACTIVITY_STATUSES_V1 } from '@happier-dev/protocol';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

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
