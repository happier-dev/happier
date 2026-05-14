/**
 * Shared types for the unified slide transition primitives (Phase 1A — Lane L).
 *
 * Three components share one animation pipeline:
 *   - `SlideTransitionFrame`  (low-level renderer; previous/current/next slots + progress)
 *   - `SlideTransitionSwitch` (discrete adapter — SelectionList / step-driven UIs)
 *   - `StoryDeckSlideTransition` (carousel adapter — StoryDeck / onboarding / release notes)
 *
 * The contract: caller drives a `progress: SharedValue<number>` in -1..1 (adapters own
 * the signal; the low-level frame consumes it). Same visual whether triggered by tap,
 * drag, or button click.
 */

import type * as React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';

import type { SlideTransitionPreset } from './slideTransitionTokens';

export type { SlideTransitionPreset } from './slideTransitionTokens';
export type { SlideLayerRole } from './resolveSlideLayerStyle';

export type SlideTransitionDirection = 'forward' | 'backward' | 'replace';

export type SlideTransitionFrameProps = Readonly<{
    /** Always rendered. */
    current: React.ReactNode;
    /** Rendered when present; positioned at -distance at progress=0. */
    previous?: React.ReactNode;
    /** Rendered when present; positioned at +distance at progress=0. */
    next?: React.ReactNode;
    /**
     * Caller-driven progress in -1..1. Adapters own this signal.
     *  - progress = 0 → only `current` visible at center
     *  - progress = +1 → only `previous` visible at center; `current` slid right out
     *  - progress = -1 → only `next` visible at center; `current` slid left out
     */
    progress: SharedValue<number>;
    /** Render the progress-tied blur layer; defaults set by the adapters (true for StoryDeck, false for SelectionList). */
    blur?: boolean;
    /** Preset controls translation distance, blur peak, and spring config the adapters use. */
    preset?: SlideTransitionPreset;
    /** Optional override; defaults via `useReducedMotionPreference()` inside adapters. */
    reducedMotion?: boolean;
    style?: StyleProp<ViewStyle>;
    testID?: string;
}>;

export type SlideTransitionSwitchProps = Readonly<{
    /** When this changes, runs the swap animation against the previously-rendered children. */
    contentKey: string | number;
    /** Forward = new content slides in from the right; backward = from the left; replace = no slide. */
    direction: SlideTransitionDirection;
    /** Plain children — the CURRENT content for `contentKey`. Caller does NOT pass a render function. */
    children: React.ReactNode;
    /** Defaults to false (popover-friendly). */
    blur?: boolean;
    /** Defaults to 'compact'. */
    preset?: SlideTransitionPreset;
    /** Optional override; defaults via `useReducedMotionPreference()`. */
    reducedMotion?: boolean;
    style?: StyleProp<ViewStyle>;
    testID?: string;
}>;

export type StoryDeckSlideTransitionRole = 'previous' | 'current' | 'next';

export type StoryDeckSlideTransitionProps = Readonly<{
    activeIndex: number;
    itemCount: number;
    renderItem: (index: number, role: StoryDeckSlideTransitionRole) => React.ReactNode;
    onCommitNext: () => void;
    onCommitPrevious: () => void;
    /** Fraction of pageWidth required to commit a card change on release; default 0.4. */
    gestureThresholdRatio?: number;
    /** Defaults to true (premium signature for full-screen carousels). */
    blur?: boolean;
    /** Defaults to 'soft'. */
    preset?: SlideTransitionPreset;
    /** Optional override; defaults via `useReducedMotionPreference()`. */
    reducedMotion?: boolean;
    style?: StyleProp<ViewStyle>;
    testID?: string;
}>;
