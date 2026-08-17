/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { VoiceAttemptControlProjection } from '@/components/voice/attempt/useVoiceAttemptControl';
import { installVoiceSurfaceCommonModuleMocks } from '@/components/voice/surface/voiceSurfaceTestHelpers';

import type { VoiceOrbLabels } from './VoiceOrb';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installVoiceSurfaceCommonModuleMocks({
    reactNative: async () => await vi.importActual('react-native-web'),
});

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const mock = createReanimatedModuleMock() as Record<string, unknown>;
    const { View } = await vi.importActual<{ View: React.ComponentType<Record<string, unknown>> }>(
        'react-native-web',
    );
    return { ...mock, default: { ...(mock.default as object), View }, View };
});

vi.mock('react-native-gesture-handler', async () => {
    const { createGestureHandlerMock } = await import('@/dev/testkit/mocks/gestureHandler');
    const mock = createGestureHandlerMock();
    return {
        ...mock,
        GestureDetector: (props: React.PropsWithChildren) => props.children,
        Gesture: {
            ...mock.Gesture,
            Pan: () => {
                const pan = mock.Gesture.Pan();
                return Object.assign(pan, { enabled: () => pan });
            },
        },
    };
});

vi.mock('@/sync/store/hooks', () => ({ useLocalSetting: () => 1 }));

vi.mock('expo-linear-gradient', () => ({ LinearGradient: () => null }));
vi.mock('react-native-svg', () => {
    const passthrough = (name: string) => (props: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('div', { 'data-svg': name }, props.children as React.ReactNode);
    return {
        Svg: passthrough('svg'),
        Circle: passthrough('circle'),
        Defs: passthrough('defs'),
        RadialGradient: passthrough('radialGradient'),
        Stop: passthrough('stop'),
        Rect: passthrough('rect'),
        LinearGradient: passthrough('linearGradient'),
        Path: passthrough('path'),
        G: passthrough('g'),
    };
});
vi.mock('@/components/ui/icons/Icon', () => ({
    Icon: (props: Readonly<{ name?: string }>) => React.createElement('div', { 'data-icon': props.name }),
}));

const labels: VoiceOrbLabels = {
    orb: 'Voice. Listening.',
    startHint: 'Starts Voice',
    endHint: 'Ends Voice',
    expandAction: 'Expand Voice',
    collapseAction: 'Collapse Voice',
    startAction: 'Start Voice',
    endAction: 'End Voice',
    status: 'Listening',
    caption: 'Microphone active',
    transport: {
        start: 'Start Voice',
        end: 'End Voice',
        startHint: 'Starts Voice',
        endHint: 'Ends Voice',
        startText: 'Start',
        endText: 'End',
        mute: 'Mute microphone',
        unmute: 'Unmute microphone',
        micState: 'Microphone active',
    },
};

function createControl(
    onPrimaryAction: () => void,
    overrides: Partial<VoiceAttemptControlProjection> = {},
): VoiceAttemptControlProjection {
    return {
        availability: 'ready',
        live: true,
        canStart: false,
        canStop: true,
        canMute: true,
        muted: false,
        capturing: true,
        micStateLabel: 'Microphone active',
        captionLabel: 'Microphone active',
        primaryAction: 'end',
        primaryActionLabel: 'End Voice',
        primaryActionHint: 'Ends Voice',
        recoveryAvailable: false,
        recoveryLabel: null,
        surfaceState: 'listening',
        tone: 'active',
        stop: 'cool',
        sessionId: 'session-1',
        onToggle: onPrimaryAction,
        onToggleMute: () => {},
        onRecover: () => {},
        onPrimaryAction,
        openConversationSessionId: null,
        onOpenConversation: () => {},
        ...overrides,
    };
}

function pointerEvent(type: string, x: number, y: number, timeStamp: number): MouseEvent {
    const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
    });
    Object.defineProperty(event, 'timeStamp', { value: timeStamp });
    return event;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderOrb(
    initialExpanded: boolean,
    controlOverrides: Partial<VoiceAttemptControlProjection> = {},
) {
    const onPrimaryAction = vi.fn();
    const expandedChanges = vi.fn();
    const toggleMute = vi.fn();
    const { VoiceOrb } = await import('./VoiceOrb');
    const { VoiceEnergyProvider } = await import('@/components/voice/light/useVoiceEnergy');
    const control = createControl(onPrimaryAction, controlOverrides);
    const resolvedLabels: VoiceOrbLabels = {
        ...labels,
        caption: control.captionLabel,
        transport: { ...labels.transport, micState: control.micStateLabel },
    };

    function Harness() {
        const [expanded, setExpanded] = React.useState(initialExpanded);
        const onExpandedChange = React.useCallback((next: boolean) => {
            expandedChanges(next);
            setExpanded(next);
        }, []);
        /*
         * Mute is a toggle, so the harness owns the fact it acts on rather than freezing it. A
         * frozen projection would let a control that only ever mutes pass a test that claims it
         * unmutes too, and the second press is exactly where a mis-routed key shows up.
         */
        const [muted, setMuted] = React.useState(control.muted);
        const onToggleMute = React.useCallback(() => {
            toggleMute();
            setMuted((current) => !current);
        }, []);
        const liveControl = React.useMemo(
            () => ({ ...control, muted, onToggleMute }),
            [muted, onToggleMute],
        );
        return (
            <VoiceEnergyProvider
                state={{ luminosity: 0.5, energized: true, direction: 'inward' }}
                previewTimeMs={1_100}
            >
                <VoiceOrb
                    control={liveControl}
                    labels={resolvedLabels}
                    expanded={expanded}
                    onExpandedChange={onExpandedChange}
                    restingBottomInset={24}
                    availableSheetHeight={900}
                    testID="voice.orb.overlay"
                />
            </VoiceEnergyProvider>
        );
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root?.render(<Harness />);
    });
    const body = container.querySelector('[data-testid="voice.orb.body"]') as HTMLElement | null;
    if (!body) throw new Error('Voice orb body did not render');
    return { body, onPrimaryAction, expandedChanges, toggleMute };
}

function controlByLabel(label: string): HTMLElement {
    const element = container?.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
    if (!element) throw new Error(`Sheet control ${label} did not render`);
    return element;
}

/**
 * Elements the browser activates from the keyboard on its own.
 *
 * This is the entire keyboard story for every Voice control except the orb. React Native Web's
 * `PressResponder` deliberately refuses to synthesize `onPress` from a key when the host element is
 * natively interactive — its document `keyup` handler skips `onPress` for `button`/`a`/`input`/
 * `select`/`textarea` and leaves activation to the UA. So a control that stops rendering as a real
 * `<button>` stops responding to the keyboard altogether, silently, and a harness that synthesizes
 * clicks regardless would still report it green.
 */
function isNativelyActivatable(element: HTMLElement): boolean {
    if (element.hasAttribute('disabled')) return false;
    const tag = element.tagName.toLowerCase();
    if (tag === 'button' || tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'summary') {
        return true;
    }
    return tag === 'a' && element.hasAttribute('href');
}

function dispatchActivationClick(element: HTMLElement): void {
    // `detail: 0` is what a keyboard-driven activation click carries, unlike a pointer click.
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
}

/**
 * Keyboard activation over the browser's real, per-key route.
 *
 * Enter and Space do not share a path on a native button. Enter activates as the default action of
 * `keypress`; Space arms the button on `keydown` and activates as the default action of `keyup`.
 * jsdom performs neither, so the harness performs them — and performs them *separately*, because a
 * helper that synthesizes one identical click for both keys can never fail Enter while Space
 * passes, which is precisely the asymmetry this file exists to catch.
 *
 * Nothing is synthesized when the key was consumed on the way (any `preventDefault` on the path
 * suppresses the default action, and on Enter a consumed `keypress` is enough), or when the focused
 * element is not one the UA activates at all.
 */
async function activateWithKey(element: HTMLElement, key: 'Enter' | ' '): Promise<Readonly<{
    /** True when the UA dispatched the activation click — the key really reached the control. */
    nativeActivation: boolean;
    /** The stage that consumed the key, when one did. */
    consumedAt: 'keydown' | 'keypress' | null;
}>> {
    let consumedAt: 'keydown' | 'keypress' | null = null;
    let nativeActivation = false;
    await act(async () => {
        const activatable = isNativelyActivatable(element);
        const down = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        element.dispatchEvent(down);
        if (down.defaultPrevented) consumedAt = 'keydown';

        if (key === 'Enter') {
            if (consumedAt === null) {
                const press = new KeyboardEvent('keypress', { key, bubbles: true, cancelable: true });
                element.dispatchEvent(press);
                if (press.defaultPrevented) consumedAt = 'keypress';
                else if (activatable) {
                    nativeActivation = true;
                    dispatchActivationClick(element);
                }
            }
            element.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
            return;
        }

        element.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
        if (consumedAt === null && activatable) {
            nativeActivation = true;
            dispatchActivationClick(element);
        }
    });
    return { nativeActivation, consumedAt };
}

/**
 * A held key: one press followed by the UA's auto-repeat keydowns, then a single keyup.
 *
 * Returns whether every repeat stayed consumed. A repeat that escapes is not merely ignored — the
 * browser would answer it with its own native activation, so "we returned early" and "nothing
 * happened" are different outcomes.
 */
async function holdKey(element: HTMLElement, key: 'Enter' | ' ', repeats: number): Promise<Readonly<{
    everyRepeatConsumed: boolean;
}>> {
    let everyRepeatConsumed = true;
    await act(async () => {
        for (let index = 0; index <= repeats; index += 1) {
            const down = new KeyboardEvent('keydown', {
                key,
                repeat: index > 0,
                bubbles: true,
                cancelable: true,
            });
            element.dispatchEvent(down);
            if (index > 0 && !down.defaultPrevented) everyRepeatConsumed = false;
        }
        element.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
    });
    return { everyRepeatConsumed };
}

function sheetElement(): HTMLElement {
    const sheet = container?.querySelector('[data-testid="voice.orb.sheet"]') as HTMLElement | null;
    if (!sheet) throw new Error('Voice orb sheet did not render');
    return sheet;
}

function overlayElement(): HTMLElement {
    const overlay = container?.querySelector('[data-testid="voice.orb.overlay"]') as HTMLElement | null;
    if (!overlay) throw new Error('Voice orb overlay did not render');
    return overlay;
}

/**
 * Sequential-navigation order, as the browser would resolve it.
 *
 * jsdom implements neither `inert` nor `aria-hidden` removal, so tabbability is derived
 * structurally: document order, minus anything sitting under a subtree the orb has taken out of
 * the keyboard and accessibility trees.
 */
function tabbableLabels(): readonly string[] {
    const candidates = Array.from(
        container?.querySelectorAll('button:not([disabled]), [tabindex]:not([tabindex^="-"])') ?? [],
    ) as HTMLElement[];
    return candidates
        .filter((element) => element.closest('[inert], [aria-hidden="true"]') === null)
        .map((element) => element.getAttribute('data-testid') ?? element.getAttribute('aria-label') ?? '');
}

async function pressKey(body: HTMLElement, key: string) {
    await act(async () => {
        body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
}

describe('VoiceOrb web DOM keyboard contract', () => {
    afterEach(async () => {
        const activeRoot = root;
        if (activeRoot) {
            await act(async () => {
                activeRoot.unmount();
            });
        }
        container?.remove();
        container = null;
        root = null;
    });

    it('keeps the interactive orb free of deprecated RNW pointer-events props', async () => {
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        try {
            const { body, onPrimaryAction } = await renderOrb(false);
            await act(async () => {
                body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            });
            expect(onPrimaryAction).toHaveBeenCalledTimes(1);

            const deprecatedPointerEventsWarnings = warning.mock.calls.filter(([message]) => (
                String(message).includes('props.pointerEvents is deprecated. Use style.pointerEvents')
            ));
            expect(deprecatedPointerEventsWarnings).toEqual([]);
        } finally {
            warning.mockRestore();
        }
    });

    it('passes a collapsed full-size overlay through while keeping the orb pressable', async () => {
        const { body, onPrimaryAction } = await renderOrb(false);

        expect(getComputedStyle(overlayElement()).pointerEvents).toBe('none');
        expect(getComputedStyle(body).pointerEvents).toBe('auto');
        expect(getComputedStyle(sheetElement()).pointerEvents).toBe('none');

        await act(async () => {
            body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        });
        expect(onPrimaryAction).toHaveBeenCalledTimes(1);
    });

    it('passes an expanded sheet frame through while preserving panel controls', async () => {
        const { onPrimaryAction } = await renderOrb(true);
        const end = controlByLabel('End Voice');

        expect(getComputedStyle(overlayElement()).pointerEvents).toBe('none');
        expect(getComputedStyle(sheetElement()).pointerEvents).toBe('none');
        expect(getComputedStyle(end).pointerEvents).toBe('auto');

        await act(async () => {
            end.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        });
        expect(onPrimaryAction).toHaveBeenCalledTimes(1);
    });

    it.each(['Enter', ' '] as const)('uses %j as the transport while collapsed', async (key) => {
        const { body, onPrimaryAction, expandedChanges } = await renderOrb(false);
        await act(async () => body.focus());

        const activation = await activateWithKey(body, key);

        // The orb is the one Voice control that owns its keys itself, so it must consume them: a
        // key it acted on and then let through would be answered a second time by the UA.
        expect(activation.consumedAt).toBe('keydown');
        expect(activation.nativeActivation).toBe(false);
        expect(onPrimaryAction).toHaveBeenCalledTimes(1);
        expect(expandedChanges).not.toHaveBeenCalled();
    });

    it('makes the collapsed sheet inert and hidden from the web accessibility tree', async () => {
        const { body } = await renderOrb(false);
        const sheet = container?.querySelector('[data-testid="voice.orb.sheet"]') as HTMLElement | null;

        expect(sheet).not.toBeNull();
        expect(sheet?.getAttribute('aria-hidden')).toBe('true');
        expect(sheet?.hasAttribute('inert')).toBe(true);
        expect(sheet?.contains(body)).toBe(false);
        expect(sheet?.querySelector('[tabindex="0"]')).not.toBeNull();
    });

    it('restores the expanded sheet to the web accessibility and keyboard trees', async () => {
        await renderOrb(true);
        const sheet = container?.querySelector('[data-testid="voice.orb.sheet"]') as HTMLElement | null;

        expect(sheet).not.toBeNull();
        // React Native Web omits the false ARIA attribute, restoring the subtree to traversal.
        expect(sheet?.getAttribute('aria-hidden')).toBeNull();
        expect(sheet?.hasAttribute('inert')).toBe(false);
        expect(sheet?.querySelector('[tabindex="0"]')).not.toBeNull();
    });

    it.each(['Enter', ' '] as const)('uses %j as the transport while expanded without double activation', async (key) => {
        const { body, onPrimaryAction, expandedChanges } = await renderOrb(true);
        await act(async () => body.focus());

        const activation = await activateWithKey(body, key);

        // Expanded, a pointer press minimises. If the orb stopped consuming the key the UA would
        // add its own activation click on top, and the same press would both act and collapse.
        expect(activation.nativeActivation).toBe(false);
        expect(onPrimaryAction).toHaveBeenCalledTimes(1);
        expect(expandedChanges).not.toHaveBeenCalled();
    });

    it.each(['Enter', ' '] as const)('treats a held %j on the orb as a single transport press', async (key) => {
        const { body, onPrimaryAction, expandedChanges } = await renderOrb(false);
        await act(async () => body.focus());

        const held = await holdKey(body, key, 3);

        /*
         * Auto-repeat is not a sequence of presses. Start/End is the one Voice action that tears a
         * live realtime session down and builds a new one, so a leaning finger must not run it at
         * the OS repeat rate — and the repeats have to stay consumed, or the UA answers them with
         * the native `<button>` activation the orb replaced.
         */
        expect(onPrimaryAction).toHaveBeenCalledTimes(1);
        expect(held.everyRepeatConsumed).toBe(true);
        expect(expandedChanges).not.toHaveBeenCalled();
    });

    it('keeps pointer press as collapse without nesting another button', async () => {
        const { body, onPrimaryAction, expandedChanges } = await renderOrb(true);

        await act(async () => {
            body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        });
        expect(expandedChanges).toHaveBeenCalledWith(false);
        expect(onPrimaryAction).not.toHaveBeenCalled();
        expect(body.querySelector('[role="button"]')).toBeNull();
    });

    it('does not let an expanded pointer drag suppress tap-to-minimise', async () => {
        const { body, onPrimaryAction, expandedChanges } = await renderOrb(true);

        await act(async () => {
            body.dispatchEvent(pointerEvent('pointerdown', 100, 200, 0));
            window.dispatchEvent(pointerEvent('pointermove', 160, 140, 20));
            window.dispatchEvent(pointerEvent('pointerup', 160, 140, 40));
            body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        });

        expect(expandedChanges).toHaveBeenCalledWith(false);
        expect(onPrimaryAction).not.toHaveBeenCalled();
    });

    it('treats a collapsed zero-movement pointer tap as the transport', async () => {
        const { body, onPrimaryAction, expandedChanges } = await renderOrb(false);

        await act(async () => {
            body.dispatchEvent(pointerEvent('pointerdown', 100, 200, 0));
            window.dispatchEvent(pointerEvent('pointerup', 100, 200, 30));
            // React Native Web synthesizes `onPress` from `click`, which the browser dispatches
            // after `pointerup` — the ordering that let the drag session swallow the tap.
            body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        });

        expect(onPrimaryAction).toHaveBeenCalledTimes(1);
        expect(expandedChanges).not.toHaveBeenCalled();
    });

    it('expands with ArrowUp and collapses with ArrowDown without touching the transport', async () => {
        const { body, onPrimaryAction, expandedChanges } = await renderOrb(false);
        await act(async () => body.focus());

        await pressKey(body, 'ArrowUp');
        expect(expandedChanges).toHaveBeenLastCalledWith(true);

        await pressKey(body, 'ArrowDown');
        expect(expandedChanges).toHaveBeenLastCalledWith(false);
        expect(onPrimaryAction).not.toHaveBeenCalled();
    });

    it.each([false, true])('publishes aria-expanded=%s and a web-reachable expand/collapse shortcut', async (initialExpanded) => {
        const { body } = await renderOrb(initialExpanded);

        expect(body.getAttribute('aria-expanded')).toBe(String(initialExpanded));
        expect(body.getAttribute('aria-keyshortcuts')).toBe('ArrowUp ArrowDown');
    });

    it('collapses with Escape, returns focus, and exposes a visible focus outline', async () => {
        const { body, onPrimaryAction, expandedChanges } = await renderOrb(true);
        await act(async () => body.focus());

        await act(async () => {
            body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        });
        expect(expandedChanges).toHaveBeenCalledWith(false);
        expect(onPrimaryAction).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(body);
        expect(body.style.outlineStyle).toBe('solid');
        expect(body.style.outlineWidth).not.toBe('');
    });

    it('puts the expanded sheet controls after the orb in tab order', async () => {
        const { body } = await renderOrb(true);

        expect(tabbableLabels()).toEqual(['voice.orb.body', 'End Voice', 'Mute microphone']);
        // Tab order is document order, so the sheet has to follow its own trigger.
        expect(body.compareDocumentPosition(sheetElement()) & Node.DOCUMENT_POSITION_FOLLOWING)
            .not.toBe(0);
    });

    it('keeps the collapsed sheet controls out of tab order', async () => {
        await renderOrb(false);

        expect(tabbableLabels()).toEqual(['voice.orb.body']);
    });

    it('reports capture-closed truth while unmuted', async () => {
        await renderOrb(true, {
            muted: false,
            capturing: false,
            micStateLabel: 'Microphone inactive',
            captionLabel: 'Microphone inactive',
        });

        const mic = container?.querySelector('[aria-label="Mute microphone"]');
        expect(mic?.getAttribute('aria-valuetext')).toBe('Microphone inactive');
        expect(container?.querySelector('[data-icon="microphone-slash"]')).not.toBeNull();
    });

    it.each(['Enter', ' '] as const)('activates the focused sheet Mute control with %j instead of the transport', async (key) => {
        const { onPrimaryAction, expandedChanges, toggleMute } = await renderOrb(true);
        const mute = controlByLabel('Mute microphone');
        await act(async () => mute.focus());

        const activation = await activateWithKey(mute, key);

        // Mute has no key handling of its own, so "the UA activated it" is the fact under test —
        // not merely that a callback ran, which a fallback path could also satisfy.
        expect(activation.consumedAt).toBeNull();
        expect(activation.nativeActivation).toBe(true);
        expect(toggleMute).toHaveBeenCalledTimes(1);
        // The orb's Enter/Space transport must not reach a key aimed at a control inside the sheet.
        expect(onPrimaryAction).not.toHaveBeenCalled();
        expect(expandedChanges).not.toHaveBeenCalled();
    });

    it('keeps Mute a truthful keyboard toggle across repeated presses', async () => {
        const { toggleMute } = await renderOrb(true);
        await act(async () => controlByLabel('Mute microphone').focus());

        // The action the control names is the state it is in: muting republishes it as Unmute.
        await activateWithKey(controlByLabel('Mute microphone'), 'Enter');
        expect(toggleMute).toHaveBeenCalledTimes(1);
        expect(container?.querySelector('[aria-label="Mute microphone"]')).toBeNull();

        await activateWithKey(controlByLabel('Unmute microphone'), 'Enter');
        expect(toggleMute).toHaveBeenCalledTimes(2);
        expect(controlByLabel('Mute microphone')).not.toBeNull();
    });

    it.each(['Enter', ' '] as const)('activates the focused End Voice control with %j', async (key) => {
        const { onPrimaryAction, expandedChanges, toggleMute } = await renderOrb(true);
        const end = controlByLabel('End Voice');
        await act(async () => end.focus());

        const activation = await activateWithKey(end, key);

        // End Voice and the orb share `onPrimaryAction`, so the discriminating fact is that the UA
        // really activated the focused control rather than the key being consumed on the way to it.
        expect(activation.consumedAt).toBeNull();
        expect(activation.nativeActivation).toBe(true);
        expect(onPrimaryAction).toHaveBeenCalledTimes(1);
        expect(toggleMute).not.toHaveBeenCalled();
        expect(expandedChanges).not.toHaveBeenCalled();
    });

    it('leaves the sheet controls as native buttons, which is what makes them keyboard-operable', async () => {
        await renderOrb(true);

        /*
         * Not a restatement of the markup. These two controls contribute no key handling of their
         * own — react-native-web's `PressResponder` skips `onPress` on key-up precisely when the
         * host element is natively interactive, so Enter and Space reach `onPress` only as the
         * UA's activation click on a real `<button>`. Render them as anything else — a wrapper, a
         * dropped `accessibilityRole`, a library upgrade that stops mapping the role to an element
         * — and both keys go dead with no other visible symptom.
         */
        for (const label of ['End Voice', 'Mute microphone'] as const) {
            const control = controlByLabel(label);
            expect(control.tagName).toBe('BUTTON');
            // Without an explicit type a button is a submit button, which changes what Enter does.
            expect(control.getAttribute('type')).toBe('button');
            expect(isNativelyActivatable(control)).toBe(true);
        }
    });

});
