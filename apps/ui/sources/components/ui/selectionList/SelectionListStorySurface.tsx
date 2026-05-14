import * as React from 'react';
import { ScrollView } from 'react-native';

import { SelectionListBasicVariants } from './storySurface/SelectionListBasicVariants';
import { SelectionListDynamicVariants } from './storySurface/SelectionListDynamicVariants';
import { SelectionListPathVariants } from './storySurface/SelectionListPathVariants';
import { SelectionListTransitionVariants } from './storySurface/SelectionListTransitionVariants';
import { SelectionListWorktreeVariants } from './storySurface/SelectionListWorktreeVariants';
import { storyStylesheet } from './storySurface/_shared';

/**
 * Story Deck preview surface for SelectionList variants. Used by the dev
 * preview screen and as a visual regression target during validation.
 *
 * FR4-14 split this 857-line catch-all into domain-specific variant modules
 * under `storySurface/*`. This file now exists solely to compose them into
 * a single scrollable surface; behavior is unchanged and the existing
 * testID hierarchy is preserved.
 *
 * Variant domains:
 *  - Basic (simple, search, steps, footer, empty, selected/disabled, reduced motion, touch footer)
 *  - Dynamic + slots (Phase 2.8 loading / error / empty / success, value-mode walk-up, slot combos)
 *  - Path picker (success / loading / error real-composition hosts)
 *  - Worktree picker (clean / dirty / stale / recent + branches sub-step)
 *  - Transition stress (push/pop with motion enabled)
 */

export type SelectionListStorySurfaceProps = Readonly<{
    testID?: string;
}>;

export function SelectionListStorySurface(
    props: SelectionListStorySurfaceProps,
): React.ReactElement {
    const testID = props.testID ?? 'selection-list-story';
    return (
        <ScrollView
            testID={testID}
            style={storyStylesheet.container}
            contentContainerStyle={{ paddingVertical: 16 }}
        >
            <SelectionListBasicVariants rootTestID={testID} />
            <SelectionListDynamicVariants rootTestID={testID} />
            <SelectionListPathVariants rootTestID={testID} />
            <SelectionListWorktreeVariants rootTestID={testID} />
            <SelectionListTransitionVariants rootTestID={testID} />
        </ScrollView>
    );
}
