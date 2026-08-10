import type { AgentActivityStatusV1, AgentActivityToneV1 } from '@happier-dev/protocol';

import { t } from '@/text';
import type { Theme } from '@/theme';

/**
 * The one binding from the protocol's tone vocabulary to this app's ink, and from its status
 * vocabulary to a spoken word. Everything visible about a status that is not its glyph comes from
 * here, so there is exactly one place to look and one place to change.
 *
 * **Why `foreground` and not `onTint`.** `state.<variant>.onTint` is bound to the *surface behind
 * the text*, not to the idea of "status": it is the only correct colour for a label sitting on
 * `state.<variant>.background`, which in this app means `StatusPill` with `chrome='pill'`. An agent
 * row's text sits on `Item`'s ordinary surface, so it takes `foreground` like every other glyph and
 * label on that surface. Using `onTint` here would look almost right and would quietly establish a
 * second colour language for the same concept.
 */

export type AgentActivityToneStyle = Readonly<{
    /** Text and glyph colour for content on an ordinary row surface. */
    ink: string;
}>;

/**
 * Tone -> `theme.colors.state.*` family.
 *
 * `live` deliberately maps to `active`, the app's existing live/connecting hue, rather than to
 * `info`: indigo `info` means "informational", and a running agent is not a notice.
 */
const STATE_VARIANT_BY_TONE = {
    pending: 'neutral',
    live: 'active',
    attention: 'warning',
    success: 'success',
    danger: 'danger',
    neutral: 'neutral',
} as const satisfies Record<AgentActivityToneV1, keyof Theme['colors']['state']>;

export function resolveAgentActivityToneStyle(
    tone: AgentActivityToneV1,
    theme: Theme,
): AgentActivityToneStyle {
    return { ink: theme.colors.state[STATE_VARIANT_BY_TONE[tone]].foreground };
}

/**
 * The translated word for a status.
 *
 * Every status has one, and it is never the enum member: rendering `succeeded` as `succeeded` is
 * defect A1, which shipped on three surfaces at once. The word is what carries an abnormal state to
 * a colour-blind reader and to a screen reader, so it is required, not decorative.
 */
const STATUS_LABEL_KEYS = {
    queued: 'session.agentActivity.status.queued',
    starting: 'session.agentActivity.status.starting',
    running: 'session.agentActivity.status.running',
    waiting: 'session.agentActivity.status.waiting',
    blocked: 'session.agentActivity.status.blocked',
    succeeded: 'session.agentActivity.status.succeeded',
    failed: 'session.agentActivity.status.failed',
    timedOut: 'session.agentActivity.status.timedOut',
    cancelled: 'session.agentActivity.status.cancelled',
    unknown: 'session.agentActivity.status.unknown',
} as const satisfies Record<AgentActivityStatusV1, string>;

export function resolveAgentActivityStatusWord(status: AgentActivityStatusV1): string {
    return t(STATUS_LABEL_KEYS[status]);
}
