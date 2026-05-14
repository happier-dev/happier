/**
 * FR4-14 — worktree-picker realistic-composition variants.
 *
 * Synthesizes a two-step worktree picker (root list + branches sub-step) and
 * covers the four status-pill states (clean / dirty / stale / recent activity)
 * via the production `StatusPill` + `RelativeTimeText` accessories so the
 * visual contract cannot drift from production.
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

function buildWorktreeRootStep(): SelectionListStep {
    const branchesStep: SelectionListStep = {
        id: 'worktree-branches',
        title: 'Branches',
        backLabel: 'Worktrees',
        inputPlaceholder: 'Search branches',
        sections: [
            {
                kind: 'static',
                id: 'local',
                title: 'LOCAL BRANCHES',
                count: 3,
                options: [
                    { id: 'br-main', label: 'main', subtitle: 'origin/main' },
                    { id: 'br-feat-auth', label: 'feature/auth', subtitle: 'origin/feature/auth' },
                    { id: 'br-rel-024', label: 'release/v0.2.4', subtitle: 'origin/release/v0.2.4' },
                ],
            },
            {
                kind: 'static',
                id: 'remote',
                title: 'REMOTE BRANCHES',
                count: 2,
                options: [
                    { id: 'br-remote-1', label: 'origin/feature/voice', subtitle: 'remote' },
                    { id: 'br-remote-2', label: 'origin/feature/payments', subtitle: 'remote' },
                ],
            },
        ],
        footerHints: [
            { id: 'back', label: 'Esc', description: 'back to worktrees' },
            { id: 'enter', label: '↵', description: 'choose branch' },
        ],
    };
    return {
        id: 'worktrees',
        inputPlaceholder: 'Search worktrees',
        sections: [
            {
                kind: 'static',
                id: 'existing',
                title: 'EXISTING WORKTREES',
                count: 4,
                options: [
                    {
                        id: 'wt-clean',
                        label: 'happier (main)',
                        subtitle: '/Users/dev/happier',
                        rightAccessory: (
                            <StatusPill variant="clean" label="clean" testID="story-wt-real:wt-clean:status" />
                        ),
                    },
                    {
                        id: 'wt-dirty',
                        label: 'happier (feature/auth)',
                        subtitle: '/Users/dev/happier-feature-auth',
                        rightAccessory: (
                            <StatusPill variant="dirty" label="ch" count={4} testID="story-wt-real:wt-dirty:status" />
                        ),
                    },
                    {
                        id: 'wt-stale',
                        label: 'happier (release/v0.2.4)',
                        subtitle: '/Users/dev/happier-release-v024',
                        rightAccessory: (
                            <RelativeTimeText
                                atMs={STORY_NOW - 14 * 24 * 60 * 60 * 1000}
                                nowMs={STORY_NOW}
                                testID="story-wt-real:wt-stale:time"
                            />
                        ),
                    },
                    {
                        id: 'wt-recent',
                        label: 'happier (feature/voice)',
                        subtitle: '/Users/dev/happier-feature-voice',
                        rightAccessory: (
                            <RelativeTimeText
                                atMs={STORY_NOW - 6 * 60 * 1000}
                                nowMs={STORY_NOW}
                                testID="story-wt-real:wt-recent:time"
                            />
                        ),
                    },
                ],
            },
            {
                kind: 'static',
                id: 'create',
                title: 'CREATE NEW',
                options: [
                    {
                        id: 'choose-base',
                        label: 'Choose base branch…',
                        openStep: branchesStep,
                    },
                ],
            },
        ],
        footerHints: [
            { id: 'navigate', label: '↑↓', description: 'navigate' },
            { id: 'enter', label: '↵', description: 'select' },
        ],
    };
}

export function SelectionListWorktreeVariants(props: Readonly<{
    rootTestID: string;
}>): React.ReactElement {
    const { rootTestID } = props;
    return (
        <VariantBlock
            testID={storyVariantTestId(rootTestID, 'worktree-real')}
            title="Worktree picker — clean / dirty / stale / recent + branches sub-step"
        >
            <SelectionList
                {...makeVariantProps(buildWorktreeRootStep(), `${rootTestID}-worktree-real-list`)}
            />
        </VariantBlock>
    );
}
