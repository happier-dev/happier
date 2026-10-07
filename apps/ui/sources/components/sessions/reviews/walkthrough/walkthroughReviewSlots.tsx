import * as React from 'react';

import type { WalkthroughReviewSlots } from '@/components/sessions/files/walkthrough/WalkthroughView';
import { REVIEW_SEVERITY_RANK, reviewSeverityLabel } from '@/components/sessions/reviews/findings/reviewFindingPresentation';
import type { ReviewFinding } from '@happier-dev/protocol';
import { t } from '@/text';

import {
    ReviewFindingReferences,
    ReviewFindingsFirst,
    ReviewSeverityDot,
    WalkthroughFindingCard,
    WalkthroughFindingsTail,
    WalkthroughReviewFact,
    WalkthroughSeededNote,
} from './ReviewWalkthroughParts';
import type { WalkthroughFindingView, WalkthroughReviewOverlay } from './reviewWalkthroughOverlay';

export type WalkthroughReviewSlotsInput = Readonly<{
    overlay: WalkthroughReviewOverlay;
    phone: boolean;
    /** Findings published before the walkthrough is ready are listed above it, usable at once (WT5-R5). */
    findingsFirst?: Readonly<{ publishedAt: string | null; engineLabel?: string | null }> | null;
    /** After-the-fact narration: findings in the reviewer's context, or from a review at a time. */
    factVariant?: Readonly<{ kind: 'in_context' }> | Readonly<{ kind: 'from_review'; at: string }> | null;
    seededNote?: Readonly<{ reviewers: string; at: string; changedFiles: number }> | null;
    notice?: React.ReactNode;
    writing?: boolean;
    renderTriage?: (view: WalkthroughFindingView) => React.ReactNode;
    /** Ask about a finding beside a stop: the stop's own Ask, to the walkthrough's reviewer or narrator. */
    onAskStop?: ((stopId: string) => void) | null;
    showKeys?: boolean;
    /** Severity colours (from `useReviewSeverityColorResolver`), for citations drawn inside the prose. */
    severityColors: (severity: ReviewFinding['severity']) => Readonly<{ foreground: string; tint: string }>;
    /** An explanation of the findings asked for explicitly, by stop (lab WT5-R2). */
    explanationsByStopId?: ReadonlyMap<string, React.ReactNode> | null;
}>;

/** Whether the prose cites this finding inline (`[text](finding:<id>)` or `(finding:<runId>:<id>)`). */
function citedInProse(markdown: string, view: WalkthroughFindingView, viewForReference: (target: string) => WalkthroughFindingView | null): boolean {
    for (const match of markdown.matchAll(/\(finding:([^\s()]+)\)/g)) {
        if (match[1] && viewForReference(match[1])?.key === view.key) return true;
    }
    return false;
}

/**
 * The walkthrough slots a review fills (lab WT5-R1, R3, R5, R6, R9), from one findings overlay. Built
 * here so the live view and the dev specimen draw the same thing.
 */
export function buildWalkthroughReviewSlots(input: WalkthroughReviewSlotsInput): WalkthroughReviewSlots {
    const { overlay, phone } = input;
    const viewForReference = (target: string): WalkthroughFindingView | null => {
        try {
            return overlay.viewsByReference.get(decodeURI(target)) ?? null;
        } catch {
            return null;
        }
    };
    const allViews = [...overlay.stops.values()].flatMap((stop) => stop.cards).concat(overlay.tail);
    const cardStopByKey = new Map<string, string>();
    for (const [stopId, stop] of overlay.stops) for (const card of stop.cards) cardStopByKey.set(card.key, stopId);
    return {
        stopAccessory: (stopId) => {
            const severity = overlay.railSeverityByStopId.get(stopId);
            return severity ? <ReviewSeverityDot severity={severity} /> : null;
        },
        renderStopFindings: (stop, nav) => {
            const placed = overlay.stops.get(stop.id);
            const explanation = input.explanationsByStopId?.get(stop.id) ?? null;
            const proseCites = stop.explanationMarkdown.includes('(finding:');
            if (!placed && !explanation && !proseCites) return null;
            const goTo = (view: WalkthroughFindingView) => {
                const cardStop = cardStopByKey.get(view.key);
                if (cardStop) nav.scrollToStop(cardStop);
                else nav.scrollToFindings();
            };
            // The narrator's citations sit where it wrote them; any it only listed follow the prose.
            const trailing = (placed?.refs ?? []).filter((view) => !citedInProse(stop.explanationMarkdown, view, viewForReference));
            return {
                proseReferences: proseCites ? {
                    scheme: 'finding',
                    resolve: (target) => {
                        const view = viewForReference(target);
                        if (!view) return null;
                        const colors = input.severityColors(view.severity);
                        return { label: `${reviewSeverityLabel(view.severity)} · ${view.engineLabel}`, foreground: colors.foreground, background: colors.tint };
                    },
                    onPress: (target) => {
                        const view = viewForReference(target);
                        if (view) goTo(view);
                    },
                } : undefined,
                explanation,
                refs: <ReviewFindingReferences views={trailing} onPress={goTo} />,
                cards: placed && placed.cards.length > 0 ? (
                    <>
                        {placed.cards.map((view) => (
                            <WalkthroughFindingCard
                                key={view.key}
                                view={view}
                                phone={phone}
                                triage={input.renderTriage?.(view)}
                                onAsk={input.onAskStop ? () => input.onAskStop?.(stop.id) : null}
                                showAskKey={input.showKeys}
                            />
                        ))}
                    </>
                ) : null,
            };
        },
        // While the walkthrough is written, the findings-first list carries the review; the story split comes after.
        headerFact: input.writing && overlay.summary.state !== 'running' && !input.factVariant
            ? null
            : <WalkthroughReviewFact summary={overlay.summary} variant={input.factVariant ?? null} />,
        headerNote: input.seededNote ? <WalkthroughSeededNote {...input.seededNote} /> : null,
        beforeHeader: input.findingsFirst && allViews.length > 0 ? (
            <ReviewFindingsFirst
                views={[...allViews].sort((left, right) => severityRank(left) - severityRank(right))}
                publishedAt={input.findingsFirst.publishedAt}
                engineLabel={input.findingsFirst.engineLabel}
                phone={phone}
            />
        ) : null,
        // Until the story is written, "not tied to a stop" would be untrue; the findings-first list carries them.
        afterStops: input.writing ? null : <WalkthroughFindingsTail entries={overlay.tail} phone={phone} renderTriage={input.renderTriage} />,
        notice: input.notice,
        writingLabel: input.writing ? t('reviewWalkthrough.writingWithFindings') : undefined,
    };
}

function severityRank(view: WalkthroughFindingView): number {
    return REVIEW_SEVERITY_RANK[view.severity] ?? 9;
}
