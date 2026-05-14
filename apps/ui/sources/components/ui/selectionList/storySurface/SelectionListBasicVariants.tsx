/**
 * FR4-14 — basic SelectionList variants for the story surface.
 *
 * Covers: simple sectioned list, with-search + status pills, with-steps,
 * with-footer hints, empty state, selected + disabled, and reduced motion.
 *
 * Status pills and time-relative accessories are imported directly from the
 * production `accessories/` modules so the story deck cannot drift from the
 * real pill/text components.
 */

import * as React from 'react';

import { RelativeTimeText } from '../accessories/RelativeTimeText';
import { StatusPill } from '../accessories/StatusPill';
import {
    SelectionList,
    STORY_NOW,
    VariantBlock,
    makeVariantProps,
    storyVariantTestId,
    type SelectionListStep,
} from './_shared';

// ─── Fixtures ─────────────────────────────────────────────────────────────

const SIMPLE_STEP: SelectionListStep = {
    id: 'simple',
    title: 'Simple',
    inputPlaceholder: '',
    sections: [
        {
            kind: 'static',
            id: 'profiles',
            title: 'PROFILES',
            options: [
                { id: 'plan', label: 'Plan' },
                { id: 'code', label: 'Code' },
                { id: 'voice', label: 'Voice' },
            ],
        },
    ],
};

const WITH_SEARCH_STEP: SelectionListStep = {
    id: 'with-search',
    title: 'With search',
    inputPlaceholder: 'Search worktrees',
    sections: [
        {
            kind: 'static',
            id: 'existing',
            title: 'EXISTING WORKTREES',
            options: [
                {
                    id: 'wt-main',
                    label: 'happier (main)',
                    subtitle: '/Users/dev/happier',
                    rightAccessory: (
                        <StatusPill variant="clean" label="clean" testID="story:wt-main:status" />
                    ),
                },
                {
                    id: 'wt-feat',
                    label: 'happier (feature/auth)',
                    subtitle: '/Users/dev/happier-feature-auth',
                    rightAccessory: (
                        <StatusPill variant="dirty" label="ch" count={3} testID="story:wt-feat:status" />
                    ),
                },
                {
                    id: 'wt-stale',
                    label: 'happier (release/v0.2.4)',
                    subtitle: '/Users/dev/happier-release-v024',
                    rightAccessory: (
                        <RelativeTimeText
                            atMs={STORY_NOW - 9 * 24 * 60 * 60 * 1000}
                            nowMs={STORY_NOW}
                            testID="story:wt-stale:time"
                        />
                    ),
                },
            ],
        },
    ],
    footerHints: [
        { id: 'navigate', label: '↑↓', description: 'navigate' },
        { id: 'enter', label: '↵', description: 'select' },
    ],
};

const DETAIL_STEP: SelectionListStep = {
    id: 'branches',
    title: 'Branches',
    backLabel: 'Worktrees',
    inputPlaceholder: 'Search branches',
    sections: [
        {
            kind: 'static',
            id: 'local',
            title: 'LOCAL BRANCHES',
            options: [
                { id: 'main', label: 'main', subtitle: 'origin/main' },
                { id: 'feature-auth', label: 'feature/auth', subtitle: 'origin/feature/auth' },
            ],
        },
    ],
    footerHints: [
        { id: 'back', label: 'Esc', description: 'back' },
        { id: 'enter', label: '↵', description: 'select' },
    ],
};

const WITH_STEPS_STEP: SelectionListStep = {
    id: 'with-steps',
    title: 'With steps',
    inputPlaceholder: 'Search',
    sections: [
        {
            kind: 'static',
            id: 'root',
            title: 'WORKTREES',
            options: [
                { id: 'choose-base', label: 'Choose base branch…', openStep: DETAIL_STEP },
                { id: 'current', label: 'Use current path' },
            ],
        },
    ],
};

const SELECTED_DISABLED_STEP: SelectionListStep = {
    id: 'selected-disabled',
    title: 'Selected & disabled',
    inputPlaceholder: '',
    sections: [
        {
            kind: 'static',
            id: 'modes',
            title: 'MODES',
            options: [
                { id: 'plan', label: 'Plan' },
                { id: 'code', label: 'Code' },
                { id: 'windows-only', label: 'Windows-only', disabled: true, subtitle: 'unavailable on this machine' },
            ],
        },
    ],
};

const EMPTY_STEP: SelectionListStep = {
    id: 'empty',
    title: 'Empty state',
    inputPlaceholder: 'Search (no matches)',
    emptyStateLabel: 'No matches yet',
    sections: [
        {
            kind: 'static',
            id: 'none',
            title: '',
            // No options — relies on the orchestrator's filter -> empty path
            // when input narrows to zero. We seed a single non-matching option
            // and let the story author type into the input to see the empty
            // state surface.
            options: [{ id: 'only', label: 'Only option' }],
        },
    ],
};

// ─── Exported variants ────────────────────────────────────────────────────

export function SelectionListBasicVariants(props: Readonly<{
    rootTestID: string;
}>): React.ReactElement {
    const { rootTestID } = props;
    return (
        <>
            <VariantBlock testID={storyVariantTestId(rootTestID, 'simple')} title="Simple sectioned list">
                <SelectionList {...makeVariantProps(SIMPLE_STEP, `${rootTestID}-simple-list`)} />
            </VariantBlock>

            <VariantBlock testID={storyVariantTestId(rootTestID, 'with-search')} title="With search + status pills">
                <SelectionList {...makeVariantProps(WITH_SEARCH_STEP, `${rootTestID}-with-search-list`)} />
            </VariantBlock>

            <VariantBlock testID={storyVariantTestId(rootTestID, 'with-steps')} title="With steps (push to detail)">
                <SelectionList {...makeVariantProps(WITH_STEPS_STEP, `${rootTestID}-with-steps-list`)} />
            </VariantBlock>

            <VariantBlock testID={storyVariantTestId(rootTestID, 'with-footer')} title="With footer hints">
                <SelectionList
                    {...makeVariantProps(WITH_SEARCH_STEP, `${rootTestID}-footer-list`)}
                    keyboardHintsEnabled={true}
                />
            </VariantBlock>

            <VariantBlock testID={storyVariantTestId(rootTestID, 'empty')} title="Empty state">
                <SelectionList {...makeVariantProps(EMPTY_STEP, `${rootTestID}-empty-list`)} />
            </VariantBlock>

            <VariantBlock testID={storyVariantTestId(rootTestID, 'selected-disabled')} title="Selected + disabled rows">
                <SelectionList
                    {...makeVariantProps(SELECTED_DISABLED_STEP, `${rootTestID}-selected-disabled-list`)}
                    selectedOptionId="plan"
                />
            </VariantBlock>

            <VariantBlock testID={storyVariantTestId(rootTestID, 'reduced-motion')} title="Reduced motion (no spring)">
                <SelectionList
                    {...makeVariantProps(WITH_STEPS_STEP, `${rootTestID}-reduced-motion-list`)}
                    disableTransitions={true}
                />
            </VariantBlock>

            <VariantBlock testID={storyVariantTestId(rootTestID, 'footer-touch')} title="Footer hidden on touch viewport">
                <SelectionList
                    {...makeVariantProps(WITH_SEARCH_STEP, `${rootTestID}-touch-footer-list`)}
                    keyboardHintsEnabled={false}
                />
            </VariantBlock>
        </>
    );
}

// Re-exported so the slots variant module can reuse the same search step.
export { WITH_SEARCH_STEP };
