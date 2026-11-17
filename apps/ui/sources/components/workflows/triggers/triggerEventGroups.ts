import type { IconName } from '@/components/ui/icons/Icon';
import { WORKFLOW_BLOCK_KIND_GLYPH } from '@/components/workflows/presentation/workflowBlockKindGlyph';

import { formatTriggerSummary, readSessionLifecycleKind, type SessionLifecycleKind, type TriggerSummarySource } from './formatTriggerSummary';

/**
 * The event a trigger waits for, as the session Triggers section groups it (07 S16 owner-approved
 * presentation, item 2): a glyph and a legible label per group. Two triggers share a group exactly
 * when they read the same summary, so "Every day at 09:00" collects every daily 09:00 trigger.
 */
export type TriggerEventGroup = Readonly<{
    id: string;
    glyph: IconName;
    title: string;
}>;

/** I4-W §Handoff glyphs: turn end, session start and archive; the attention event uses the hand. */
export const TRIGGER_LIFECYCLE_GLYPHS = {
    turnStarts: 'play',
    turnEnds: 'arrows-clockwise',
    needsYou: 'hand',
    sessionStarts: 'play',
    sessionArchived: 'archive',
} as const satisfies Record<SessionLifecycleKind, IconName>;

export function resolveTriggerEventGroup(trigger: TriggerSummarySource): TriggerEventGroup {
    const title = formatTriggerSummary(trigger);
    switch (trigger.kind) {
        case 'action':
            return { id: `action:${JSON.stringify([trigger.phase, trigger.actionIds, trigger.mode, trigger.onFailure])}`,
                glyph: WORKFLOW_BLOCK_KIND_GLYPH.action, title };
        case 'sessionLifecycle': {
            const kind = readSessionLifecycleKind(trigger.events);
            return { id: `lifecycle:${kind}`, glyph: TRIGGER_LIFECYCLE_GLYPHS[kind], title };
        }
        case 'schedule':
            return { id: `schedule:${title}`, glyph: 'clock', title };
        case 'pluginEvent':
            return { id: `event:${trigger.eventRef.localId}:${title}`, glyph: 'lightning', title };
        case 'runLifecycle':
            return { id: `run:${trigger.condition}`, glyph: trigger.condition === 'needs_attention' ? 'hand' : 'arrows-clockwise', title };
        case 'prComment':
        case 'ciFailed':
            return { id: `event:${trigger.kind}:${title}`, glyph: trigger.kind === 'prComment' ? 'git-pull-request' : 'lightning', title };
    }
}
