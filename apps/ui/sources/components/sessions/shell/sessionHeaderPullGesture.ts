/**
 * The session-title pull (phone): press the session header and drag down past a deliberate
 * threshold to open All tabs.
 *
 * Plain worklet-safe arithmetic, so the header's pan worklet and a node test read one rule. The
 * gesture only exists on the header's identity and title (never its back or action buttons), and
 * only activates downward, so transcript scrolling and light drags never reach it.
 */

/** Downward travel before the header moves at all; the same activation the bar gestures use. */
export const SESSION_HEADER_PULL_ARM_PX = 12;

/** Travel past arming that commits: one tick, "Release for all tabs". Device-tunable. */
export const SESSION_HEADER_PULL_OPEN_PX = 64;

/** How far the header can stretch; the follow is asymptotic so it never runs off. */
const PULL_RESISTANCE_DIMENSION_PX = 300;
const PULL_RESISTANCE_COEFFICIENT = 0.9;

export type SessionHeaderPullFrame = Readonly<{
    /** 0 at arming, 1 at the threshold. Drives the hint and the transcript's recede. */
    progress: number;
    /** Past the threshold: letting go opens All tabs. */
    ready: boolean;
    /** How far the header follows the finger, under resistance. */
    offset: number;
}>;

function pullTravel(translationY: number): number {
    'worklet';
    const y = typeof translationY === 'number' && translationY === translationY ? translationY : 0;
    const travel = y - SESSION_HEADER_PULL_ARM_PX;
    return travel > 0 ? travel : 0;
}

export function resolveSessionHeaderPullFrame(params: Readonly<{ translationY: number }>): SessionHeaderPullFrame {
    'worklet';
    const travel = pullTravel(params.translationY);
    const progress = travel >= SESSION_HEADER_PULL_OPEN_PX ? 1 : travel / SESSION_HEADER_PULL_OPEN_PX;
    const offset = (travel * PULL_RESISTANCE_DIMENSION_PX * PULL_RESISTANCE_COEFFICIENT)
        / (PULL_RESISTANCE_DIMENSION_PX + PULL_RESISTANCE_COEFFICIENT * travel);
    return { progress, ready: travel >= SESSION_HEADER_PULL_OPEN_PX, offset };
}

/** The release decision. A gesture the system took away (`cancelled`) never opens anything. */
export function resolveSessionHeaderPullRelease(params: Readonly<{ translationY: number; cancelled: boolean }>): boolean {
    'worklet';
    if (params.cancelled) return false;
    return pullTravel(params.translationY) >= SESSION_HEADER_PULL_OPEN_PX;
}
