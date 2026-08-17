import type { HappierTone } from '@happier-dev/plugin-ui/presentation';

import type { ChatListItem } from '@/components/sessions/chatListItems';
import {
    resolveItemSubtitleMaxLines,
    resolveItemTitleMaxLines,
} from '@/components/ui/lists/itemTextClamp';
import { t } from '@/text';

export type PluginTranscriptActivityItem = Extract<
    ChatListItem,
    { kind: 'plugin-transcript-activity' }
>;

export type PluginTranscriptActivityChecklistStep = Readonly<{
    stepId: string;
    title: string;
    status: 'pending' | 'active' | 'done' | 'failed';
}>;

type PluginTranscriptActivityPhasePresentation = Readonly<{
    label: string;
    tone: HappierTone;
    isPulsing: boolean;
}>;

function resolvePhasePresentation(
    phase: PluginTranscriptActivityItem['phase'],
): PluginTranscriptActivityPhasePresentation {
    switch (phase) {
        case 'running':
            return { label: t('status.working'), tone: 'info', isPulsing: true };
        case 'succeeded':
            return { label: t('common.done'), tone: 'success', isPulsing: false };
        case 'failed':
            return { label: t('common.error'), tone: 'danger', isPulsing: false };
        case 'cancelled':
            return { label: t('status.canceled'), tone: 'secondary', isPulsing: false };
    }
}

function resolveChecklistStatus(
    state: PluginTranscriptActivityItem['checklist'][number]['state'],
): PluginTranscriptActivityChecklistStep['status'] {
    switch (state) {
        case 'complete':
            return 'done';
        case 'active':
            return 'active';
        case 'failed':
            return 'failed';
        case 'pending':
            return 'pending';
    }
}

export type PluginTranscriptActivityPresentation = Readonly<{
    /** Localized current phase, prefixed with the explicit stale/offline fact when retained LKG is shown. */
    statusTitle: string;
    /** Plugin-owned bounded status text and determinate count, when either is available. */
    statusDetail: string | null;
    tone: HappierTone;
    isPulsing: boolean;
    progress: Readonly<{ label: string; value: number | undefined }> | null;
    checklistSteps: readonly PluginTranscriptActivityChecklistStep[];
    /** Full current snapshot for direct exploration; it is not a live region. */
    accessibilityLabel: string;
    /** Coalesced semantic transition only: counter ticks and volatile status copy never enter it. */
    announcement: string;
    announcementKey: string;
}>;

/**
 * The presentation-only activity projection. It turns the validated Resource
 * snapshot into app-local semantic facts, but never owns Resource freshness,
 * Action admission, dismissal, or terminal lifecycle.
 */
export function resolvePluginTranscriptActivityPresentation(
    activity: PluginTranscriptActivityItem,
): PluginTranscriptActivityPresentation {
    const phase = resolvePhasePresentation(activity.phase);
    const isStale = activity.freshness === 'stale';
    const statusTitle = [
        isStale ? t('status.offline') : null,
        phase.label,
    ].filter((part): part is string => part !== null).join(' · ');
    const progress = activity.progress
        ? {
            label: `${activity.progress.completed} / ${activity.progress.total}`,
            value: activity.progress.total > 0
                ? activity.progress.completed / activity.progress.total
                : undefined,
        }
        : null;
    const statusDetail = [
        activity.status,
        progress?.label ?? null,
    ].filter((part): part is string => part !== null).join(' · ') || null;
    const checklistSteps = activity.checklist.map((step) => ({
        stepId: step.id,
        title: step.label,
        status: resolveChecklistStatus(step.state),
    }));
    const hasChecklistFailure = checklistSteps.some((step) => step.status === 'failed');
    const accessibilityLabel = [
        activity.title,
        statusTitle,
        activity.status,
        progress?.label ?? null,
    ].filter((part): part is string => part !== null).join('. ');
    // A Resource can update its count or descriptive text rapidly. Those facts
    // remain readable on the row/progressbar, but do not become a burst of live
    // announcements. Freshness, terminal phase, and first checklist failure do.
    const announcement = [
        activity.title,
        statusTitle,
        hasChecklistFailure && activity.phase !== 'failed' ? t('common.error') : null,
    ].filter((part): part is string => part !== null).join('. ');

    return {
        statusTitle,
        statusDetail,
        tone: isStale ? 'warning' : phase.tone,
        isPulsing: !isStale && phase.isPulsing,
        progress,
        checklistSteps,
        accessibilityLabel,
        announcement,
        announcementKey: [
            activity.identityKey,
            activity.freshness,
            activity.phase,
            hasChecklistFailure ? 'checklist-failed' : 'checklist-clear',
        ].join('\u0000'),
    };
}

/**
 * Whether the card paints its dismiss row. This is a whole `Item` — the one place `phase` and
 * `dismissible` decide the card's HEIGHT rather than its copy.
 */
export function resolvePluginTranscriptActivityCanDismiss(
    activity: PluginTranscriptActivityItem,
): boolean {
    return activity.dismissible && activity.phase !== 'running';
}

/**
 * Everything `PluginTranscriptActivityCard` paints that can change the row's HEIGHT, named as the
 * card paints it: a group title, a status title/detail, an optional fixed-width progress rail,
 * one `Item` per checklist/action, and the dismiss `Item`.
 *
 * This is the counterpart of `resolvePendingMessageHeightBearingChrome` for this row — the painter
 * declares what it paints, and `buildTranscriptRowShellSignature` decides how to key each painted
 * LINE (by rendered extent, exactly as it already keys the pending row's text). It deliberately does
 * NOT return an already-compressed key: how a painted line maps to a size version is a measurement
 * decision with one owner, and this module must not restate it.
 *
 * Progress counter values and checklist state are deliberately absent: they repaint inside fixed
 * geometry. Checklist membership/labels remain here because each step is a row whose title can
 * change geometry.
 */
export type PluginTranscriptActivityHeightBearingPaint = Readonly<{
    /** `ItemGroup title` — rendered through `Eyebrow` with no `numberOfLines`, so it wraps freely. */
    groupTitle: PluginTranscriptActivityPaintedLine;
    /** The one status `Item`'s title, clamped by `Item` to one line with a subtitle and two without. */
    statusTitle: PluginTranscriptActivityPaintedLine;
    /** The status `Item` subtitle. It appears only when the snapshot has detail/progress. */
    statusDetail: PluginTranscriptActivityPaintedLine | null;
    /** The progress rail narrows the status item's text column, so its presence is height-bearing. */
    hasProgress: boolean;
    /** One whole `Item` per bounded checklist entry; each title can wrap up to `Item`'s clamp. */
    checklistStepLabels: readonly PluginTranscriptActivityPaintedLine[];
    /** One whole `Item` per action, each with its own title. Membership is height-bearing. */
    actionLabels: readonly PluginTranscriptActivityPaintedLine[];
    /** The dismiss `Item` — a whole row that appears and disappears. */
    canDismiss: boolean;
}>;

/**
 * A painted line of text together with the clamp of the box that paints it — `null` when that box
 * grows with its content.
 *
 * V-2 (2026-08-11): the clamps used to live only in the prose above, while
 * `buildTranscriptRowShellSignature` keyed every one of these lines by full text extent. A CLAMPED
 * line cannot pay for its length: `9 / 10 -> 10 / 10`, `99 -> 100 / 200` and `Compiling -> Linking`
 * all moved the row's Legend size version with the painted box byte-identical, which is the churn
 * F-P4 set out to remove. Naming the clamp as DATA lets the one keying rule in that module bound the
 * extent it takes, and keeps this descriptor the single authority on what the card paints.
 */
export type PluginTranscriptActivityPaintedLine = Readonly<{
    text: string;
    maxLines: number | null;
}>;

/**
 * F-2 (2026-08-11): these clamps used to be hand-copied constants living here, next to a prose
 * reference to `Item.tsx`. That made this module a SECOND decision-maker about a clamp it does not
 * paint — deleting the with/without-subtitle flip left every test in this corridor green, because
 * the guard asserted the copy against a literal instead of against the render. `Item`'s clamps now
 * have one owner, `components/ui/lists/itemTextClamp`, which `Item` renders from and this descriptor
 * reads. The card passes no `subtitleLines`.
 */
function resolveItemSubtitleLine(text: string): PluginTranscriptActivityPaintedLine {
    return { text, maxLines: resolveItemSubtitleMaxLines({ text, subtitleLines: undefined }) };
}

export function resolvePluginTranscriptActivityHeightBearingPaint(
    activity: PluginTranscriptActivityItem,
): PluginTranscriptActivityHeightBearingPaint {
    const presentation = resolvePluginTranscriptActivityPresentation(activity);
    return {
        groupTitle: { text: activity.title, maxLines: null },
        statusTitle: {
            text: presentation.statusTitle,
            maxLines: resolveItemTitleMaxLines(presentation.statusDetail !== null),
        },
        statusDetail: presentation.statusDetail === null
            ? null
            : resolveItemSubtitleLine(presentation.statusDetail),
        hasProgress: presentation.progress !== null,
        // `ProgressChecklist` is given `showStepMessages={false}`, so each step is an `Item` with a
        // title and no subtitle.
        checklistStepLabels: presentation.checklistSteps.map((step) => ({
            text: step.title,
            maxLines: resolveItemTitleMaxLines(false),
        })),
        // Session Action admission has already shaped the final transcript
        // item. The card and this descriptor deliberately consume that same
        // array, so an unavailable Action removes both its painted `Item` and
        // its height reservation in the same render.
        actionLabels: activity.actions.map((action) => ({
            text: action.label ?? action.localId,
            maxLines: resolveItemTitleMaxLines(false),
        })),
        canDismiss: resolvePluginTranscriptActivityCanDismiss(activity),
    };
}
