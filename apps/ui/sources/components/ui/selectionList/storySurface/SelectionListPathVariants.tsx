/**
 * FR4-14 — path-picker realistic-composition variants.
 *
 * The path picker variants synthesize the dynamic IN THIS FOLDER section above
 * static FAVORITES + RECENT, mirroring the production `PathSelectionList` shape
 * without depending on a live machine. `DrillDownChevron` is imported from the
 * real accessories module so the drill affordance can't drift visually.
 */

import * as React from 'react';

import { DrillDownChevron } from '../accessories/DrillDownChevron';
import { Icon } from '@/components/ui/icons/Icon';
import {
    FAVORITES_OPTIONS,
    RECENT_OPTIONS,
    SelectionList,
    VariantBlock,
    makeVariantProps,
    makeStoryPathInputBehavior,
    storyVariantTestId,
    type SelectionListOption,
    type SelectionListStep,
} from './_shared';

function buildPathRootStep(args: Readonly<{
    resolveBehavior: 'success' | 'loading' | 'error';
    onChangeInputValue: (next: string) => void;
}>): SelectionListStep {
    const successOptions: ReadonlyArray<SelectionListOption> = [
        {
            id: 'in-folder:Documents',
            label: 'Documents',
            subtitle: '~/Documents',
            icon: <Icon name="folder" size={16} />,
            autocompleteValue: '~/Documents/',
            rightAccessory: (
                <DrillDownChevron
                    testID="story-path-real-success:option:in-folder:Documents:drill"
                    accessibilityLabel="Open Documents"
                    onPress={() => args.onChangeInputValue('~/Documents/')}
                />
            ),
        },
        {
            id: 'in-folder:Downloads',
            label: 'Downloads',
            subtitle: '~/Downloads',
            icon: <Icon name="folder" size={16} />,
            autocompleteValue: '~/Downloads/',
            rightAccessory: (
                <DrillDownChevron
                    testID="story-path-real-success:option:in-folder:Downloads:drill"
                    accessibilityLabel="Open Downloads"
                    onPress={() => args.onChangeInputValue('~/Downloads/')}
                />
            ),
        },
        {
            id: 'in-folder:Development',
            label: 'Development',
            subtitle: '~/Development',
            icon: <Icon name="folder" size={16} />,
            autocompleteValue: '~/Development/',
            rightAccessory: (
                <DrillDownChevron
                    testID="story-path-real-success:option:in-folder:Development:drill"
                    accessibilityLabel="Open Development"
                    onPress={() => args.onChangeInputValue('~/Development/')}
                />
            ),
        },
    ];
    return {
        id: 'path-root',
        inputPlaceholder: 'Type a path…',
        sections: [
            {
                kind: 'dynamic',
                id: 'in-this-folder',
                title: 'IN THIS FOLDER',
                debounceMs: 0,
                visibleWhen: (input) => input.length > 0,
                resolve: async () => {
                    if (args.resolveBehavior === 'loading') {
                        return new Promise(() => {}) as never;
                    }
                    if (args.resolveBehavior === 'error') {
                        throw new Error('Filesystem unreachable');
                    }
                    return { options: successOptions };
                },
                loadingSkeletonRows: 4,
            },
            {
                kind: 'static',
                id: 'favorites',
                title: 'FAVORITES',
                count: FAVORITES_OPTIONS.length,
                options: FAVORITES_OPTIONS,
            },
            {
                kind: 'static',
                id: 'recent',
                title: 'RECENT',
                count: RECENT_OPTIONS.length,
                options: RECENT_OPTIONS,
            },
        ],
        footerHints: [
            { id: 'navigate', label: '↑↓', description: 'navigate' },
            { id: 'enter', label: '↵', description: 'select' },
            { id: 'tab', label: 'Tab', description: 'autocomplete' },
            { id: 'backspace', label: '⌫', description: 'walk up' },
        ],
    };
}

function PathRealCompositionHost(props: Readonly<{
    testID: string;
    resolveBehavior: 'success' | 'loading' | 'error';
}>): React.ReactElement {
    const [inputValue, setInputValue] = React.useState('~/D');
    const rootStep = React.useMemo(
        () => buildPathRootStep({ resolveBehavior: props.resolveBehavior, onChangeInputValue: setInputValue }),
        [props.resolveBehavior],
    );
    return (
        <SelectionList
            {...makeVariantProps(rootStep, props.testID)}
            inputMode="value"
            inputBehavior={makeStoryPathInputBehavior()}
            inputPrefix={<Icon name="folder" size={16} />}
            inputValue={inputValue}
            onChangeInputValue={setInputValue}
        />
    );
}

export function SelectionListPathVariants(props: Readonly<{
    rootTestID: string;
}>): React.ReactElement {
    const { rootTestID } = props;
    return (
        <>
            <VariantBlock
                testID={storyVariantTestId(rootTestID, 'path-real-success')}
                title="Path picker — IN THIS FOLDER success + favorites + recents"
            >
                <PathRealCompositionHost
                    testID={`${rootTestID}-path-real-success`}
                    resolveBehavior="success"
                />
            </VariantBlock>

            <VariantBlock
                testID={storyVariantTestId(rootTestID, 'path-real-loading')}
                title="Path picker — IN THIS FOLDER loading skeleton"
            >
                <PathRealCompositionHost
                    testID={`${rootTestID}-path-real-loading`}
                    resolveBehavior="loading"
                />
            </VariantBlock>

            <VariantBlock
                testID={storyVariantTestId(rootTestID, 'path-real-error')}
                title="Path picker — IN THIS FOLDER error fallback"
            >
                <PathRealCompositionHost
                    testID={`${rootTestID}-path-real-error`}
                    resolveBehavior="error"
                />
            </VariantBlock>
        </>
    );
}
