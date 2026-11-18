import { APP_RAIL_BADGE, APP_RAIL_BADGE_OVERLAP_PX } from '@/components/navigation/shell/appRail/appRailMetrics';

import type { BotFaceSnapshot } from '../../presentation/notchBotTypes';
import type { DesktopActivityOverlayAttentionMark } from '../../presentation/model/desktopActivityOverlayModelTypes';

/** A side dock's rest stacks three marks, then "+N" (lab `ntshape` R). */
export const NOTCH_REST_MARKS_SHOWN = 3;

export type NotchRestMark =
    | Readonly<{ kind: 'face'; face: BotFaceSnapshot }>
    | Readonly<{ kind: 'session'; mark: DesktopActivityOverlayAttentionMark }>;

/**
 * What a side dock's rest stacks: the Bots that need you, then the Sessions that need you, then the other
 * Show-Bots faces, each list in its owner's order. Membership and attention are already decided upstream.
 */
export function resolveNotchRestMarks(
    faces: readonly BotFaceSnapshot[],
    attention: readonly DesktopActivityOverlayAttentionMark[],
): Readonly<{ shown: readonly NotchRestMark[]; more: number }> {
    const all: NotchRestMark[] = [
        ...faces.filter((face) => face.activity === 'needsYou').map((face) => ({ kind: 'face' as const, face })),
        ...attention.map((mark) => ({ kind: 'session' as const, mark })),
        ...faces.filter((face) => face.activity !== 'needsYou').map((face) => ({ kind: 'face' as const, face })),
    ];
    return { shown: all.slice(0, NOTCH_REST_MARKS_SHOWN), more: Math.max(0, all.length - NOTCH_REST_MARKS_SHOWN) };
}

/**
 * How far a mark moves toward its leading side so it and the needs-you dot it carries (the rail badge, past
 * the mark's bottom-right corner) stand centred together on the column (owner 2026-11-18: centred marks
 * otherwise read as sitting right of the tab). "+N" carries no dot and stays on the centre line.
 */
export function resolveNotchRestMarkShiftPx(): number {
    const dot = APP_RAIL_BADGE.dotSizePx + 2 * APP_RAIL_BADGE.ringPx;
    return -Math.max(0, dot - APP_RAIL_BADGE_OVERLAP_PX) / 2;
}
