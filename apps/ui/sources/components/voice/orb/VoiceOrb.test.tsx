import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { VoiceEnergyProvider } from '@/components/voice/light/useVoiceEnergy';
import type { VoiceAttemptControlProjection } from '@/components/voice/attempt/useVoiceAttemptControl';
import type { VoiceControlAction } from '@/components/voice/controls/VoiceControls';

import { VoiceOrb, type VoiceOrbLabels } from './VoiceOrb';
import {
    VOICE_ORB_DOCK_HEADROOM,
    VOICE_ORB_HIT_TARGET,
} from './voiceOrbGeometry';

vi.mock('@/sync/store/hooks', () => ({ useLocalSetting: () => 1 }));

const labels: VoiceOrbLabels = {
    orb: 'Voice. Listening.',
    startHint: 'Starts a spoken conversation.',
    endHint: 'Ends the spoken conversation.',
    expandAction: 'Expand Voice',
    collapseAction: 'Collapse Voice',
    startAction: 'Start Voice',
    endAction: 'End Voice',
    status: 'Listening',
    caption: null,
    transport: {
        start: 'Start Voice',
        end: 'End Voice',
        startHint: 'Starts a spoken conversation.',
        endHint: 'Ends the spoken conversation.',
        startText: 'Start',
        endText: 'Stop',
        mute: 'Mute microphone',
        unmute: 'Unmute microphone',
    },
};

function createControl(
    overrides: Partial<VoiceAttemptControlProjection> = {},
): VoiceAttemptControlProjection {
    const primaryAction = overrides.primaryAction
        ?? (overrides.canStop === true
            ? 'end'
            : overrides.availability === 'recoverable'
                ? 'recover'
                : overrides.canStart === false
                    ? null
                    : 'start');
    const onToggle = overrides.onToggle ?? vi.fn();
    const onRecover = overrides.onRecover ?? vi.fn();
    const primaryActionLabel = overrides.primaryActionLabel
        ?? (primaryAction === 'end' ? 'End Voice' : primaryAction === 'recover' ? 'Retry' : 'Start Voice');
    const primaryActionHint = overrides.primaryActionHint
        ?? (primaryAction === 'end' ? 'Ends the spoken conversation.' : primaryAction === 'recover' ? 'Retry' : 'Starts a spoken conversation.');
    return {
        availability: 'ready',
        live: false,
        canStart: true,
        canStop: false,
        canMute: false,
        muted: false,
        capturing: false,
        micStateLabel: 'Microphone inactive',
        captionLabel: 'Microphone inactive',
        primaryAction,
        primaryActionLabel,
        primaryActionHint,
        recoveryLabel: primaryAction === 'recover' ? primaryActionLabel : null,
        recoveryAvailable: primaryAction === 'recover',
        surfaceState: 'idle',
        tone: 'neutral',
        stop: 'cool',
        sessionId: null,
        onToggle,
        onToggleMute: vi.fn(),
        onRecover,
        onPrimaryAction: overrides.onPrimaryAction
            ?? (primaryAction === 'recover' ? onRecover : onToggle),
        openConversationSessionId: null,
        onOpenConversation: vi.fn(),
        ...overrides,
    };
}

/** The shape §2.5 calls a failed attempt: an attempt object exists, but nothing can act on it. */
function createErroredControl(
    overrides: Partial<VoiceAttemptControlProjection> = {},
): VoiceAttemptControlProjection {
    return createControl({
        availability: 'recoverable',
        live: true,
        canStart: false,
        canStop: false,
        canMute: false,
        surfaceState: 'error',
        tone: 'error',
        primaryAction: 'recover',
        primaryActionLabel: 'Retry',
        primaryActionHint: 'Retry',
        recoveryLabel: 'Retry',
        recoveryAvailable: true,
        sessionId: 'session-1',
        ...overrides,
    });
}

async function renderOrb(props: Readonly<{
    control?: VoiceAttemptControlProjection;
    expanded?: boolean;
    onExpandedChange?: (next: boolean) => void;
    availableSheetHeight?: number;
    extraControls?: readonly VoiceControlAction[];
    onAction?: (id: string) => void;
}> = {}) {
    const control = props.control ?? createControl();
    const onExpandedChange = props.onExpandedChange ?? vi.fn();
    const screen = await renderScreen(
        <VoiceEnergyProvider
            state={{ luminosity: 0.4, energized: false, direction: 'none' }}
            previewTimeMs={1_100}
        >
            <VoiceOrb
                control={control}
                labels={labels}
                expanded={props.expanded ?? false}
                onExpandedChange={onExpandedChange}
                restingBottomInset={24}
                availableSheetHeight={props.availableSheetHeight ?? 900}
                extraControls={props.extraControls}
                onAction={props.onAction as never}
            />
        </VoiceEnergyProvider>,
    );
    const body = screen.findByTestId('voice.orb.body');
    if (!body) throw new Error('Voice orb body did not render');
    return { screen, body, control, onExpandedChange };
}

function findTransportControl(
    screen: Awaited<ReturnType<typeof renderScreen>>,
    accessibilityLabel: string,
) {
    return screen.root.findAll((node) => (
        typeof node.type === 'string'
        && node.props?.accessibilityLabel === accessibilityLabel
        && typeof node.props?.onPress === 'function'
    ));
}

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    return style && typeof style === 'object' ? { ...style } as Record<string, unknown> : {};
}

/**
 * §2.6 — the arbitration rules a floating transport lives or dies by. A control that starts Voice
 * because the user dragged it, or that a screen-reader user can only reach with a swipe gesture, is
 * not shippable, and none of these are visible in a screenshot.
 */
describe('VoiceOrb', () => {
    it('is the transport when collapsed: one tap starts the canonical attempt', async () => {
        const { body, control } = await renderOrb();

        body.props.onPress();

        expect(control.onToggle).toHaveBeenCalledTimes(1);
    });

    it('routes a tap to recovery, not to start, when the attempt is only recoverable', async () => {
        const control = createControl({ availability: 'recoverable', canStart: false });
        const { body } = await renderOrb({ control });

        body.props.onPress();

        expect(control.onRecover).toHaveBeenCalledTimes(1);
        expect(control.onToggle).not.toHaveBeenCalled();
    });

    it('routes the sheet transport to recovery too, so the open orb has no dead Start', async () => {
        /*
         * The recoverable rung is reachable without an error now — an unfinished provider setup
         * lands here — so the sheet's Start is a control a real user meets. It is enabled
         * (`canStart || recoverable`), and if it still dispatched `onToggle` the lifecycle owner
         * would refuse it and the press would do nothing at all: the dead transport §2.2 forbids,
         * one level deeper than the collapsed tap this file already pins.
         */
        const control = createControl({ availability: 'recoverable', canStart: false });
        const { screen } = await renderOrb({ control, expanded: true });

        const recover = findTransportControl(screen, 'Retry');
        expect(recover.length).toBe(1);

        recover[0]!.props.onPress();

        expect(control.onRecover).toHaveBeenCalledTimes(1);
        expect(control.onToggle).not.toHaveBeenCalled();
    });

    it('names and dispatches the canonical recovery action instead of presenting it as Start', async () => {
        const onPrimaryAction = vi.fn();
        const control = createControl({
            availability: 'recoverable',
            canStart: false,
            primaryAction: 'recover',
            primaryActionLabel: 'Retry',
            primaryActionHint: 'Retry',
            onPrimaryAction,
        });
        const { screen, body } = await renderOrb({ control, expanded: true });

        expect(findTransportControl(screen, 'Retry')).toHaveLength(1);
        expect(findTransportControl(screen, labels.transport.start)).toHaveLength(0);
        expect(body.props.accessibilityActions[0]).toEqual({ name: 'activate', label: 'Retry' });

        findTransportControl(screen, 'Retry')[0]!.props.onPress();
        expect(onPrimaryAction).toHaveBeenCalledTimes(1);
        expect(control.onToggle).not.toHaveBeenCalled();
        expect(control.onRecover).not.toHaveBeenCalled();
    });

    /**
     * §2.2 / §2.5 — the deepest version of the dead control, and the one that actually shipped: an
     * *errored* attempt is still an attempt object, so presence read as readiness drew a live
     * transport. End was enabled, the meter implied audio, and the press went to a lifecycle owner
     * with nothing to stop. Actionability is the only thing the transport may read.
     */
    it('does not draw a live End for an attempt that cannot be ended', async () => {
        const control = createErroredControl();
        const { screen, body } = await renderOrb({ control, expanded: true });

        expect(findTransportControl(screen, labels.transport.end)).toHaveLength(0);
        const recover = findTransportControl(screen, 'Retry');
        expect(recover).toHaveLength(1);

        recover[0]!.props.onPress();
        expect(control.onRecover).toHaveBeenCalledTimes(1);
        expect(control.onToggle).not.toHaveBeenCalled();
        // The collapsed body stops promising an ending it cannot deliver either.
        expect(body.props.accessibilityHint).not.toBe(labels.endHint);
    });

    it('exposes Start/End and Expand as screen-reader actions, and states the current state', async () => {
        const { body, onExpandedChange } = await renderOrb();

        expect(body.props.accessibilityLabel).toBe('Voice. Listening.');
        expect(body.props.accessibilityHint).toBe(labels.startHint);
        expect(body.props.accessibilityActions).toEqual([
            { name: 'activate', label: 'Start Voice' },
            // Semantic action name, not an icon name — §2.6 asks for Expand/Collapse.
            { name: 'expand', label: 'Expand Voice' },
        ]);

        body.props.onAccessibilityAction({ nativeEvent: { actionName: 'expand' } });
        expect(onExpandedChange).toHaveBeenCalledWith(true);
    });

    it('removes the collapsed sheet and every descendant from native accessibility traversal', async () => {
        const { screen } = await renderOrb({ expanded: false });
        const sheet = screen.findByTestId('voice.orb.sheet');

        expect(sheet?.props.accessibilityElementsHidden).toBe(true);
        expect(sheet?.props.importantForAccessibility).toBe('no-hide-descendants');
        expect(sheet?.props.pointerEvents).toBe('none');
    });

    it('restores the expanded sheet to native accessibility traversal', async () => {
        const { screen } = await renderOrb({ expanded: true });
        const sheet = screen.findByTestId('voice.orb.sheet');

        expect(sheet?.props.accessibilityElementsHidden).toBe(false);
        expect(sheet?.props.importantForAccessibility).toBe('auto');
        expect(sheet?.props.pointerEvents).toBe('box-none');
    });

    it('uses a physical 48-point interaction wrapper instead of clipped hit slop', async () => {
        const { body } = await renderOrb();
        const style = flattenStyle(body.props.style);

        expect(style.width).toBe(VOICE_ORB_HIT_TARGET);
        expect(style.height).toBe(VOICE_ORB_HIT_TARGET);
        expect(style.alignItems).toBe('center');
        expect(style.justifyContent).toBe('center');
        expect(body.props.hitSlop).toBeUndefined();
    });

    it('offers End and Collapse once live and expanded, and minimises on tap', async () => {
        const control = createControl({ live: true, canStop: true, canMute: true, surfaceState: 'listening' });
        const { body, onExpandedChange } = await renderOrb({ control, expanded: true });

        expect(body.props.accessibilityHint).toBe(control.primaryActionHint);
        expect(body.props.accessibilityActions).toEqual([
            { name: 'activate', label: 'End Voice' },
            { name: 'collapse', label: 'Collapse Voice' },
        ]);

        body.props.onPress();
        expect(onExpandedChange).toHaveBeenCalledWith(false);
        // Minimising is not ending: the tap must not also settle the attempt.
        expect(control.onToggle).not.toHaveBeenCalled();
    });

    it('shows the mute pip whenever the microphone is muted, independent of body colour', async () => {
        const { screen } = await renderOrb({
            control: createControl({ live: true, canStop: true, muted: true, canMute: true }),
        });

        expect(screen.findByTestId('voice.orb.mutePip')).toBeTruthy();
    });

    it('shows a closed microphone when capture is closed even though the attempt is unmuted', async () => {
        const { screen } = await renderOrb({
            control: createControl({
                live: true,
                canStop: true,
                canMute: true,
                muted: false,
                capturing: false,
                micStateLabel: 'Microphone inactive',
            }),
            expanded: true,
        });

        const mic = screen.root.findAll((node) => (
            node.props?.accessibilityLabel === labels.transport.mute
            && typeof node.props?.onPress === 'function'
        ));
        expect(mic.some((node) => (
            node.props.accessibilityValue?.text === 'Microphone inactive'
        ))).toBe(true);
        expect(screen.root.findAllByProps({ name: 'microphone-slash' }).length).toBeGreaterThan(0);
    });

    /**
     * §2.6 — `activate` is the transport, on both sides of the expansion.
     *
     * Expanded, it used to run the press handler, whose expanded branch minimises. A screen-reader
     * user could open the companion and then had no way to start or end Voice at all: the default
     * action and Collapse did the same thing under two names.
     */
    it('routes the expanded orb’s activate action to the transport, not to collapse', async () => {
        const control = createControl({ live: true, canStop: true, canMute: true, surfaceState: 'listening' });
        const { body, onExpandedChange } = await renderOrb({ control, expanded: true });

        body.props.onAccessibilityAction({ nativeEvent: { actionName: 'activate' } });

        expect(control.onToggle).toHaveBeenCalledTimes(1);
        expect(onExpandedChange).not.toHaveBeenCalled();
    });

    it('keeps collapse as its own action, so both remain reachable while expanded', async () => {
        const control = createControl({ live: true, canStop: true, canMute: true, surfaceState: 'listening' });
        const { body, onExpandedChange } = await renderOrb({ control, expanded: true });

        body.props.onAccessibilityAction({ nativeEvent: { actionName: 'collapse' } });

        expect(onExpandedChange).toHaveBeenCalledWith(false);
        expect(control.onToggle).not.toHaveBeenCalled();
    });

    /**
     * The orb publishes exactly `activate` plus one of Expand/Collapse. Anything else reaching this
     * handler — a platform action the runtime added, a misdispatch, a future name — is not a
     * request to start or end a live conversation, and the transport must not treat it as one.
     */
    it('ignores an accessibility action it does not publish instead of starting or ending Voice', async () => {
        const control = createControl({ live: true, canStop: true, canMute: true, surfaceState: 'listening' });
        const { body, onExpandedChange } = await renderOrb({ control, expanded: true });

        body.props.onAccessibilityAction({ nativeEvent: { actionName: 'magicTap' } });

        expect(control.onToggle).not.toHaveBeenCalled();
        expect(control.onRecover).not.toHaveBeenCalled();
        expect(onExpandedChange).not.toHaveBeenCalled();
    });

    it('routes activate to recovery when that is what a press would do', async () => {
        const control = createErroredControl();
        const { body } = await renderOrb({ control, expanded: true });

        body.props.onAccessibilityAction({ nativeEvent: { actionName: 'activate' } });

        expect(control.onRecover).toHaveBeenCalledTimes(1);
        expect(control.onToggle).not.toHaveBeenCalled();
    });

    /**
     * §2.7 — the sheet is measured and clamped, and what gives way is never the way out.
     *
     * `236` is a default-scale target: a long locale, 200% web text or Dynamic Type makes the
     * status block taller, and a short viewport or an open keyboard makes the space smaller. The
     * bar carries End Voice and every recovery action, so it keeps its measured height and the
     * caption becomes the sheet's single scroll owner.
     */
    it('scrolls the caption and keeps the transport bar whole when space runs out', async () => {
        const control = createControl({ live: true, canStop: true, canMute: true, surfaceState: 'listening' });
        // A short viewport with the keyboard up.
        const { screen } = await renderOrb({ control, expanded: true, availableSheetHeight: 260 });

        const scroll = screen.findByTestId('voice.orb.captionScroll');
        const bar = screen.findByTestId('voice.orb.bar');
        if (!scroll || !bar) throw new Error('Voice orb sheet did not render');
        // Exactly one internal scroll owner — never nested (§2.7).
        expect(screen.root.findAllByProps({ testID: 'voice.orb.captionScroll' }).length).toBeGreaterThan(0);

        await act(async () => {
            bar.props.onLayout({ nativeEvent: { layout: { height: 60 } } });
            // Two wrapped lines of status plus two of caption at 200% text.
            scroll.props.onContentSizeChange(0, 168);
        });

        const scrolled = screen.findByTestId('voice.orb.captionScroll');
        const barAfter = screen.findByTestId('voice.orb.bar');
        expect(scrolled?.props.scrollEnabled).toBe(true);
        // Padding at `restingBottomInset: 24` is `24 + 34 - 12`.
        expect(flattenStyle(scrolled?.props.style).maxHeight)
            .toBeCloseTo(260 - VOICE_ORB_DOCK_HEADROOM - 60 - 46, 5);
        // The bar absorbed none of the clamp.
        expect(flattenStyle(barAfter?.props.style).flexShrink).toBe(0);
        expect(findTransportControl(screen, labels.transport.end)).toHaveLength(1);
    });

    /**
     * §2.7 — the bar is one row until the room for one row is gone. At 320px with 200% text or
     * the longest supported localization, transport plus contextual controls cannot share a line,
     * and the thing that must never be pushed off the edge is End Voice or a recovery action.
     *
     * So the outer composition wraps, the transport and contextual groups keep their content
     * width, and the meter is the only child that can absorb or surrender leftover space: with
     * `flexBasis: 0` it takes what the controls left over and can never push one onto another
     * line. This is asserted on the emitted layout contract because a unit renderer runs no
     * flexbox engine; the pixel result stays a browser/device gate.
     */
    it('wraps the bar and makes the meter, not a control, surrender space first', async () => {
        const control = createControl({ live: true, canStop: true, canMute: true, surfaceState: 'listening' });
        const { screen } = await renderOrb({
            control,
            expanded: true,
            extraControls: [{
                id: 'open-conversation',
                label: 'Open the conversation this Voice session belongs to',
                weight: 'primary',
            }],
        });

        const bar = flattenStyle(screen.findByTestId('voice.orb.bar')?.props.style);
        expect(bar.flexWrap).toBe('wrap');
        // Still pinned: the bar never absorbs the sheet clamp.
        expect(bar.flexShrink).toBe(0);

        const meter = flattenStyle(screen.findByTestId('voice.orb.bar.meter')?.props.style);
        expect(meter.flexGrow).toBe(1);
        expect(meter.flexBasis).toBe(0);
        expect(meter.minWidth).toBe(0);

        const transport = flattenStyle(screen.findByTestId('voice.orb.bar.transport')?.props.style);
        expect(transport.flexShrink).toBe(0);
        expect(transport.flexGrow).toBeUndefined();

        // Everything the gate names is still mounted and operable at once.
        expect(findTransportControl(screen, labels.transport.end)).toHaveLength(1);
        expect(findTransportControl(screen, labels.transport.mute)).toHaveLength(1);
        expect(findTransportControl(screen, 'Open the conversation this Voice session belongs to'))
            .toHaveLength(1);
        expect(screen.findByTestId('voice.orb.bar.meter')).not.toBeNull();
    });

    it('does not scroll a sheet that fits, and grows instead when the room is there', async () => {
        const { screen } = await renderOrb({ expanded: true, availableSheetHeight: 900 });

        const scroll = screen.findByTestId('voice.orb.captionScroll');
        if (!scroll) throw new Error('Voice orb sheet did not render');

        await act(async () => {
            screen.findByTestId('voice.orb.bar')?.props.onLayout({ nativeEvent: { layout: { height: 60 } } });
            scroll.props.onContentSizeChange(0, 168);
        });

        const grown = screen.findByTestId('voice.orb.captionScroll');
        expect(grown?.props.scrollEnabled).toBe(false);
        expect(flattenStyle(grown?.props.style).maxHeight as number).toBeGreaterThanOrEqual(168);
    });

    /**
     * §2.5 — a session-bound attempt has a conversation the user came from, and the expanded orb is
     * where they get back to *that exact one*. The action is projected, not invented here.
     */
    it('dispatches the contextual open-conversation action the caller projects', async () => {
        const onAction = vi.fn();
        const control = createControl({
            live: true,
            canStop: true,
            canMute: true,
            surfaceState: 'listening',
            sessionId: 'control-1',
            openConversationSessionId: 'conversation-7',
        });
        const { screen } = await renderOrb({
            control,
            expanded: true,
            extraControls: [{ id: 'openConversation', label: 'Open Voice conversation', weight: 'secondary' }],
            onAction,
        });

        const open = findTransportControl(screen, 'Open Voice conversation');
        expect(open).toHaveLength(1);

        open[0]!.props.onPress();

        expect(onAction).toHaveBeenCalledWith('openConversation');
    });
});
