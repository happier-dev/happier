/**
 * FR4-14 — dynamic-section + slot-layout SelectionList variants for the story
 * surface.
 *
 * Covers Phase 2.8 dynamic loading/error/empty/success states, value-mode +
 * backspace walk-up, and the input prefix/suffix slot combinations.
 */

import * as React from 'react';

import {
    FAVORITES_OPTIONS,
    RECENT_OPTIONS,
    SelectionList,
    VariantBlock,
    makeVariantProps,
    makeStoryPathInputBehavior,
    storyVariantTestId,
    type SelectionListStep,
} from './_shared';
import { WITH_SEARCH_STEP } from './SelectionListBasicVariants';
import { Icon } from '@/components/ui/icons/Icon';

const DYNAMIC_SUCCESS_STEP: SelectionListStep = {
    id: 'dynamic-success',
    title: 'Dynamic — success',
    inputPlaceholder: 'Type a path…',
    sections: [
        {
            kind: 'dynamic',
            id: 'in-this-folder',
            title: 'IN THIS FOLDER',
            debounceMs: 0,
            resolve: async () => ({
                options: [
                    {
                        id: 'docs',
                        label: 'Documents',
                        subtitle: 'folder',
                        icon: <Icon name="folder" size={16} />,
                        autocompleteValue: '~/Documents/',
                    },
                    {
                        id: 'desktop',
                        label: 'Desktop',
                        subtitle: 'folder',
                        icon: <Icon name="folder" size={16} />,
                        autocompleteValue: '~/Desktop/',
                    },
                ],
            }),
        },
        { kind: 'static', id: 'favorites', title: 'FAVORITES', options: FAVORITES_OPTIONS },
        { kind: 'static', id: 'recent', title: 'RECENT', options: RECENT_OPTIONS },
    ],
};

const DYNAMIC_LOADING_STEP: SelectionListStep = {
    id: 'dynamic-loading',
    title: 'Dynamic — loading',
    inputPlaceholder: 'Loading…',
    sections: [
        {
            kind: 'dynamic',
            id: 'in-this-folder',
            title: 'IN THIS FOLDER',
            debounceMs: 0,
            loadingSkeletonRows: 4,
            // Promise never resolves so we sit in loading.
            resolve: () => new Promise(() => {}),
        },
    ],
};

const DYNAMIC_ERROR_STEP: SelectionListStep = {
    id: 'dynamic-error',
    title: 'Dynamic — error',
    inputPlaceholder: 'See error state',
    sections: [
        {
            kind: 'dynamic',
            id: 'in-this-folder',
            title: 'IN THIS FOLDER',
            debounceMs: 0,
            resolve: async () => {
                throw new Error('Filesystem unreachable');
            },
        },
    ],
};

const DYNAMIC_EMPTY_STEP: SelectionListStep = {
    id: 'dynamic-empty',
    title: 'Dynamic — empty',
    inputPlaceholder: 'No matches expected',
    sections: [
        {
            kind: 'dynamic',
            id: 'in-this-folder',
            title: 'IN THIS FOLDER',
            debounceMs: 0,
            resolve: async () => ({ options: [], emptyHint: 'Folder is empty' }),
        },
    ],
};

const VALUE_MODE_STEP: SelectionListStep = {
    id: 'value-mode',
    title: 'Value mode + walk-up',
    inputPlaceholder: 'Type a path; Backspace walks up',
    sections: [{ kind: 'static', id: 'favorites', title: 'FAVORITES', options: FAVORITES_OPTIONS }],
    footerHints: [
        { id: 'backspace', label: '⌫', description: 'walk up one segment' },
        { id: 'tab', label: 'Tab', description: 'autocomplete' },
    ],
};

export function SelectionListDynamicVariants(props: Readonly<{
    rootTestID: string;
}>): React.ReactElement {
    const { rootTestID } = props;
    return (
        <>
            <VariantBlock
                testID={storyVariantTestId(rootTestID, 'dynamic-loading')}
                title="Dynamic section — loading skeleton"
            >
                <SelectionList
                    {...makeVariantProps(DYNAMIC_LOADING_STEP, `${rootTestID}-dynamic-loading-list`)}
                    inputMode="value"
                    inputValue="~/"
                />
            </VariantBlock>

            <VariantBlock
                testID={storyVariantTestId(rootTestID, 'dynamic-error')}
                title="Dynamic section — error"
            >
                <SelectionList
                    {...makeVariantProps(DYNAMIC_ERROR_STEP, `${rootTestID}-dynamic-error-list`)}
                    inputMode="value"
                    inputValue="~/broken"
                />
            </VariantBlock>

            <VariantBlock
                testID={storyVariantTestId(rootTestID, 'dynamic-empty')}
                title="Dynamic section — empty"
            >
                <SelectionList
                    {...makeVariantProps(DYNAMIC_EMPTY_STEP, `${rootTestID}-dynamic-empty-list`)}
                    inputMode="value"
                    inputValue="~/empty"
                />
            </VariantBlock>

            <VariantBlock
                testID={storyVariantTestId(rootTestID, 'dynamic-success')}
                title="Dynamic section — success + ghost"
            >
                <SelectionList
                    {...makeVariantProps(DYNAMIC_SUCCESS_STEP, `${rootTestID}-dynamic-success-list`)}
                    inputMode="value"
                    inputValue="~/D"
                />
            </VariantBlock>

            <VariantBlock
                testID={storyVariantTestId(rootTestID, 'value-mode-walkup')}
                title="Value mode with backspace walk-up"
            >
                <SelectionList
                    {...makeVariantProps(VALUE_MODE_STEP, `${rootTestID}-value-mode-list`)}
                    inputMode="value"
                    inputBehavior={makeStoryPathInputBehavior()}
                    inputValue="~/Development/"
                />
            </VariantBlock>

            <VariantBlock
                testID={storyVariantTestId(rootTestID, 'slots-none')}
                title="Slots — no prefix and no suffix"
            >
                <SelectionList
                    {...makeVariantProps(WITH_SEARCH_STEP, `${rootTestID}-slots-none-list`)}
                />
            </VariantBlock>

            <VariantBlock
                testID={storyVariantTestId(rootTestID, 'slots-prefix-only')}
                title="Slots — inputPrefix only"
            >
                <SelectionList
                    {...makeVariantProps(WITH_SEARCH_STEP, `${rootTestID}-slots-prefix-list`)}
                    inputPrefix={<Icon name="folder" size={16} />}
                />
            </VariantBlock>

            <VariantBlock
                testID={storyVariantTestId(rootTestID, 'slots-suffix-only')}
                title="Slots — inputSuffix only"
            >
                <SelectionList
                    {...makeVariantProps(WITH_SEARCH_STEP, `${rootTestID}-slots-suffix-list`)}
                    inputSuffix={<Icon name="arrow-square-out" size={16} />}
                />
            </VariantBlock>

            <VariantBlock
                testID={storyVariantTestId(rootTestID, 'slots-both')}
                title="Slots — inputPrefix AND inputSuffix"
            >
                <SelectionList
                    {...makeVariantProps(WITH_SEARCH_STEP, `${rootTestID}-slots-both-list`)}
                    inputPrefix={<Icon name="folder" size={16} />}
                    inputSuffix={<Icon name="arrow-square-out" size={16} />}
                />
            </VariantBlock>
        </>
    );
}
