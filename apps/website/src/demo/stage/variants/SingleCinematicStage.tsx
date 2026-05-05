import { type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { MacWindowFrame } from '../../frames/MacWindowFrame';
import { PhoneFrame } from '../../frames/PhoneFrame';
import { DesktopFrame } from '../../frames/DesktopFrame';
import { TerminalBody } from '../../frames/TerminalFrame';
import { SyncIndicator } from '../../frames/SyncIndicator';
import { MockSessionProvider } from '../../timeline/MockSessionProvider';
import { NarrativeLayer, heroKindForFocus } from '../../narrative/NarrativeLayer';
import type { DeviceFocus } from '../../timeline/types';
import type { ScenarioStagePrep } from '../useScenarioStage';
import { useResponsiveStageScale } from '../useResponsiveStageScale';

/**
 * The stage.
 *
 * One device is the hero at any moment. Others fly on/off stage via spring
 * transitions. During "dual" beats (terminal-phone, phone-desktop) the two
 * devices partner at equal scale. During the "all" beat all three appear in
 * a small triptych.
 *
 * Captions render NEXT to the active device (not below):
 *   - Phone hero → side-left (phone is narrow, room beside it)
 *   - Terminal/desktop hero or dual/triptych → above
 * The caption layer cross-fades as the beat advances and smooth-swaps slots
 * when focus changes.
 *
 * Motion rules:
 *   - Transition only transform, opacity, filter (never `transition: all`)
 *   - Spring `bounce: 0` for every device move
 *   - ~0.55s entrance, ~0.35s exit
 */

type DeviceRole = 'hero' | 'partner-left' | 'partner-right' | 'triptych' | 'offstage';

// Tightened (was 720) — stage is now sized just larger than the phone's 600px
// so devices feel anchored rather than swimming in dead space, and captions
// can hug the device top edges naturally.
const STAGE_MIN_HEIGHT = 660;

type Roles = {
    terminal: DeviceRole;
    phone: DeviceRole;
    desktop: DeviceRole;
};

const offstageRoles: Roles = {
    terminal: 'offstage',
    phone: 'offstage',
    desktop: 'offstage',
};

/**
 * Roles per focus value.
 *
 * The terminal frame is 540px wide and the desktop frame is 760px wide, so
 * "single hero at scale 1 + partner at scale 0.86" is geometrically too tight
 * for both to fit inside the 1180px stage. Instead, when a "single-hero"
 * focus also includes a second device for context, we render both side-by-
 * side at *partner* scale (0.86) — the one with focus gets full opacity and
 * no blur (`active`); the partner gets `equal` (also no blur, but in the
 * codebase's vocabulary it's the supporting device).
 *
 *   - terminal hero  → side-by-side terminal+phone (terminal is the active)
 *   - phone hero     → side-by-side terminal+phone (phone is the active)
 *   - desktop hero   → desktop alone, full-stage. Other devices offstage.
 *   - terminal-phone → side-by-side, same as terminal hero / phone hero
 *   - phone-desktop  → side-by-side phone+desktop (no terminal)
 *   - all            → triptych
 */
function rolesForFocus(focus: DeviceFocus): Roles {
    // The terminal is the persistent "session" surface — when the scenarios
    // wire a real asciinema cast in, we want viewers to see it keep playing
    // across beats rather than vanishing every time focus shifts. So the
    // terminal stays at partner-left for every focus mode except triptych,
    // where the geometry is already constrained.
    switch (focus) {
        case 'terminal':
        case 'phone':
        case 'terminal-phone':
            return {
                terminal: 'partner-left',
                phone: 'partner-right',
                desktop: 'offstage',
            };
        case 'desktop':
            // Terminal stays as the partner-left thumbnail so the cast keeps
            // visible motion during desktop beats. The desktop slides into
            // the partner-right slot at the same scale.
            return {
                terminal: 'partner-left',
                phone: 'offstage',
                desktop: 'partner-right',
            };
        case 'phone-desktop':
            return {
                terminal: 'offstage',
                phone: 'partner-left',
                desktop: 'partner-right',
            };
        case 'all':
        case 'both':
            return {
                terminal: 'triptych',
                phone: 'triptych',
                desktop: 'triptych',
            };
    }
}

function rolesForVisiblePair(visibleDevices: ReadonlySet<'terminal' | 'phone' | 'desktop'>): Roles {
    if (visibleDevices.has('terminal') && visibleDevices.has('phone')) {
        return {
            terminal: 'partner-left',
            phone: 'partner-right',
            desktop: 'offstage',
        };
    }

    if (visibleDevices.has('terminal') && visibleDevices.has('desktop')) {
        return {
            terminal: 'partner-left',
            phone: 'offstage',
            desktop: 'partner-right',
        };
    }

    return {
        terminal: 'offstage',
        phone: 'partner-left',
        desktop: 'partner-right',
    };
}

function resolveRolesForStage(
    focus: DeviceFocus,
    visibility: ScenarioStagePrep['surfaceVisibility'],
): Roles {
    const visibleDevices = new Set<'terminal' | 'phone' | 'desktop'>();
    if (visibility.showTerminal) visibleDevices.add('terminal');
    if (visibility.showPhone) visibleDevices.add('phone');
    if (visibility.showDesktop) visibleDevices.add('desktop');

    if (visibleDevices.size === 0) return offstageRoles;
    if (visibleDevices.size === 1) {
        const visibleDevice = [...visibleDevices][0];
        return {
            terminal: visibleDevice === 'terminal' ? 'hero' : 'offstage',
            phone: visibleDevice === 'phone' ? 'hero' : 'offstage',
            desktop: visibleDevice === 'desktop' ? 'hero' : 'offstage',
        };
    }
    if (visibleDevices.size === 2) return rolesForVisiblePair(visibleDevices);

    return rolesForFocus(focus);
}

function roleToMotion(role: DeviceRole, device: 'terminal' | 'phone' | 'desktop') {
    switch (role) {
        case 'hero':
            return {
                x: 0,
                y: 0,
                scale: 1,
                opacity: 1,
                filter: 'blur(0px)',
                zIndex: 20,
            };
        case 'partner-left':
            return {
                x: device === 'phone' ? -200 : -260,
                y: 0,
                scale: 0.86,
                opacity: 1,
                filter: 'blur(0px)',
                zIndex: 12,
            };
        case 'partner-right':
            return {
                x: device === 'phone' ? 200 : 260,
                y: 0,
                scale: 0.86,
                opacity: 1,
                filter: 'blur(0px)',
                zIndex: 12,
            };
        case 'triptych':
            // Stage container is max-w-[1180px]. Devices at scale 0.62 give:
            //   terminal: 540 * 0.62 = 335 wide
            //   phone:    296 * 0.62 = 184 wide
            //   desktop:  580 * 0.62 = 360 wide  (shrunk from 760)
            // Triptych row total ≈ 879 with 30px gaps between edges. Center
            // offsets land at -290, 0, +300.
            return {
                x: device === 'terminal' ? -290 : device === 'desktop' ? 300 : 0,
                y: 0,
                scale: 0.62,
                opacity: 1,
                filter: 'blur(0px)',
                zIndex: 10,
            };
        case 'offstage':
            return {
                x: device === 'terminal' ? -700 : device === 'desktop' ? 700 : 0,
                y: device === 'phone' ? 620 : 40,
                scale: 0.82,
                opacity: 0,
                filter: 'blur(4px)',
                zIndex: 0,
            };
    }
}

const SPRING = { type: 'spring' as const, duration: 0.55, bounce: 0 };

function deviceFocusFor(
    role: DeviceRole,
    device: 'terminal' | 'phone' | 'desktop',
    focus: DeviceFocus,
): 'active' | 'inactive' | 'equal' {
    if (role === 'hero') return 'active';
    if (role === 'offstage') return 'inactive';

    // For side-by-side single-hero beats, the device whose name matches the
    // focus value gets `active` styling (full opacity, no blur, lifted shadow);
    // the partner gets `equal` so it's visible but supporting.
    if (focus === 'terminal' && device === 'terminal') return 'active';
    if (focus === 'phone' && device === 'phone') return 'active';
    if (focus === 'desktop' && device === 'desktop') return 'active';

    return 'equal';
}

function DeviceSlot({
    device,
    role,
    children,
}: {
    device: 'terminal' | 'phone' | 'desktop';
    role: DeviceRole;
    children: ReactNode;
}) {
    const target = roleToMotion(role, device);
    return (
        <motion.div
            className="pointer-events-auto absolute left-1/2 top-1/2"
            style={{ transformOrigin: 'center center' }}
            initial={{ ...target, x: target.x, y: target.y, scale: target.scale, opacity: 0 }}
            animate={{
                x: `calc(-50% + ${target.x}px)`,
                y: `calc(-50% + ${target.y}px)`,
                scale: target.scale,
                opacity: target.opacity,
                filter: target.filter,
            }}
            transition={SPRING}
            aria-hidden={role === 'offstage'}
        >
            <div style={{ zIndex: target.zIndex, position: 'relative' }}>{children}</div>
        </motion.div>
    );
}

export function SingleCinematicStage({
    prep,
    phoneSurface,
    desktopSurface,
}: {
    prep: ScenarioStagePrep;
    phoneSurface: ReactNode;
    desktopSurface: ReactNode;
}) {
    const {
        state,
        focus,
        activeBeat,
        surfaceVisibility,
        terminalTitle,
        desktopTitle,
        stageRef,
    } = prep;
    const roles = resolveRolesForStage(focus, surfaceVisibility);
    const hero = heroKindForFocus(focus);

    // The stage geometry is authored in absolute pixels (1180×660). On narrow
    // viewports we scale the whole composition down uniformly so the device
    // positions, transitions, and xterm grid stay coherent rather than
    // overflowing or rebuilding the layout.
    const STAGE_INTRINSIC_WIDTH = 1180;
    const stageScale = useResponsiveStageScale({
        intrinsicWidth: STAGE_INTRINSIC_WIDTH,
        maxScale: 1,
        horizontalMargin: 16,
    });
    const scaledHeight = STAGE_MIN_HEIGHT * stageScale;

    return (
        <MockSessionProvider value={{ state, focus }}>
            <div
                ref={stageRef}
                className="relative mx-auto"
                style={{
                    // Reserve the scaled shell height. The intrinsic 1180×660
                    // stage is absolutely positioned inside this box so its
                    // unscaled min-height does not create dead air on mobile.
                    width: STAGE_INTRINSIC_WIDTH * stageScale,
                    maxWidth: '100%',
                    height: scaledHeight,
                }}
            >
                <div
                    className="relative w-[1180px] overflow-hidden"
                    style={{
                        position: 'absolute',
                        left: 0,
                        top: 0,
                        minHeight: STAGE_MIN_HEIGHT,
                        transform: `scale(${stageScale})`,
                        transformOrigin: 'top left',
                    }}
                >
                {/* Camera layer — animates a beat-controlled zoom + origin
                    so scenarios can punch in on a specific device or region
                    for rhythm, then pull back out for the next beat. The
                    spring overlaps with the device transitions, which keeps
                    motion feeling continuous rather than stop-and-start. */}
                <motion.div
                    className="relative h-full w-full"
                    animate={{
                        scale: activeBeat.camera?.zoom ?? 1,
                        x: -(activeBeat.camera?.offsetX ?? 0),
                        y: -(activeBeat.camera?.offsetY ?? 0),
                    }}
                    transition={{ type: 'spring', duration: 0.7, bounce: 0.05 }}
                    style={{
                        transformOrigin: '50% 50%',
                        minHeight: STAGE_MIN_HEIGHT,
                    }}
                >
                {/* Caption hugs the active device — slot is derived from hero
                    kind. The caption itself remounts via key={beatId} so it
                    advances in lockstep with the device transition rather
                    than waiting for an exit animation. */}
                <NarrativeLayer activeBeat={activeBeat} hero={hero} />

                {/* Device canvas */}
                <div className="relative h-full w-full" style={{ minHeight: STAGE_MIN_HEIGHT }}>
                    <DeviceSlot device="terminal" role={roles.terminal}>
                        <MacWindowFrame
                            focus={deviceFocusFor(roles.terminal, 'terminal', focus)}
                            tiltSide="left"
                            title={terminalTitle}
                        >
                            <TerminalBody
                                lines={state.terminal}
                                commands={activeBeat.terminal?.commands}
                                typingPrompt={activeBeat.terminal?.typingPrompt}
                                cast={activeBeat.terminal?.cast}
                                // Tie the replay identity to the cast source so a
                                // cast keeps playing across beat changes when the
                                // same cast is referenced. Beats without a cast
                                // still get per-beat reset of the synthetic
                                // typewriter via beat id.
                                replayKey={
                                    activeBeat.terminal?.cast?.src ?? activeBeat.id
                                }
                                pendingPermissionActive={state.permission?.state === 'pending'}
                            />
                        </MacWindowFrame>
                    </DeviceSlot>

                    <DeviceSlot device="phone" role={roles.phone}>
                        <PhoneFrame
                            focus={deviceFocusFor(roles.phone, 'phone', focus)}
                            tiltSide="right"
                            notification={state.phoneNotification}
                        >
                            {phoneSurface}
                        </PhoneFrame>
                    </DeviceSlot>

                    <DeviceSlot device="desktop" role={roles.desktop}>
                        <DesktopFrame
                            focus={deviceFocusFor(roles.desktop, 'desktop', focus)}
                            tiltSide="right"
                            title={desktopTitle}
                            height="short"
                        >
                            {desktopSurface}
                        </DesktopFrame>
                    </DeviceSlot>
                </div>

                {/* Sync indicator sits close to the stage so it reads as part
                    of the scene, not a footer. Lives inside the scaled wrapper
                    so it shrinks alongside the device frames. */}
                <div className="relative -mt-4 flex flex-col items-center gap-2">
                    <SyncIndicator
                        pulseKey={state.syncPulseKey}
                        direction={state.syncDirection}
                    />
                </div>
                </motion.div>
                </div>
            </div>
        </MockSessionProvider>
    );
}
