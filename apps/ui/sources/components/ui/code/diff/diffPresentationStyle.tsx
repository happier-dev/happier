import * as React from 'react';

import { settingsDefaults } from '@/sync/domains/settings/settings';
import { useSetting } from '@/sync/domains/state/storage';
import { useSurfaceStateSize } from '@/components/ui/surfaces/surfaceStateSize';

export type DiffPresentationStyle = 'unified' | 'split';

/** Phone code wraps for reading; the saved desktop preference is neither changed nor discarded. */
export function useEffectiveDiffWrapLines(preference: boolean | undefined): boolean | undefined {
    return useSurfaceStateSize() === 'phone' ? true : preference;
}

/**
 * The narrowest container a split diff is drawn in. Two sides of code with their own number and
 * sign columns need about 450 px each before ordinary lines stop clipping (details lab 2, Q2: the
 * 600 px docked column cramps split, Focus at ~900 px does not). Below it a split preference falls
 * back to unified, and the toggle says why instead of drawing two unreadable halves.
 */
export const DIFF_SPLIT_MIN_WIDTH_PX = 900;

export type EffectiveDiffPresentation = Readonly<{
    /** What the viewer draws. */
    style: DiffPresentationStyle;
    /** What the person asked for (the `filesDiffPresentationStyle` setting). */
    preference: DiffPresentationStyle;
    /** The container is too narrow for split, so a split preference is drawn unified. */
    splitTooNarrow: boolean;
}>;

export function normalizeDiffPresentationPreference(value: unknown): DiffPresentationStyle {
    if (value === 'unified' || value === 'split') return value;
    return settingsDefaults.filesDiffPresentationStyle === 'split' ? 'split' : 'unified';
}

export function resolveEffectiveDiffPresentation(input: Readonly<{
    preference: DiffPresentationStyle;
    /** The width the diff is drawn in; `null` when the host does not constrain it (no rule applies). */
    availableWidthPx: number | null;
}>): EffectiveDiffPresentation {
    const measured = typeof input.availableWidthPx === 'number' && Number.isFinite(input.availableWidthPx) && input.availableWidthPx > 0;
    const splitTooNarrow = measured && (input.availableWidthPx as number) < DIFF_SPLIT_MIN_WIDTH_PX;
    return {
        preference: input.preference,
        splitTooNarrow,
        style: input.preference === 'split' && !splitTooNarrow ? 'split' : 'unified',
    };
}

/**
 * Carries only whether split fits, never the raw width: resizing a pane re-renders its diffs when it
 * crosses the threshold, not on every pixel.
 */
const DiffSplitFitsContext = React.createContext<boolean | null>(null);

/**
 * Set by a container that knows its own width (a Details tab group) so every diff inside it — a
 * file, Review, a commit, a stash — applies the same split rule. Outside any provider (a tool card
 * in the transcript) the preference is drawn as it is.
 */
export function resolveDiffSplitFits(widthPx: number | null | undefined): boolean | null {
    return typeof widthPx === 'number' && Number.isFinite(widthPx) && widthPx > 0
        ? widthPx >= DIFF_SPLIT_MIN_WIDTH_PX
        : null;
}

export function DiffPresentationWidthProvider(props: Readonly<{ widthPx: number | null; children: React.ReactNode }>) {
    return (
        <DiffSplitFitsContext.Provider value={resolveDiffSplitFits(props.widthPx)}>
            {props.children}
        </DiffSplitFitsContext.Provider>
    );
}

/** Whether split fits the enclosing container; `null` outside any constraining container. */
export function useDiffSplitFits(): boolean | null {
    return React.useContext(DiffSplitFitsContext);
}

export function useEffectiveDiffPresentation(): EffectiveDiffPresentation {
    const setting = useSetting('filesDiffPresentationStyle');
    const splitFits = useDiffSplitFits();
    const preference = normalizeDiffPresentationPreference(setting);
    return React.useMemo(
        () => resolveEffectiveDiffPresentation({
            preference,
            availableWidthPx: splitFits === null ? null : splitFits ? DIFF_SPLIT_MIN_WIDTH_PX : 1,
        }),
        [preference, splitFits],
    );
}
