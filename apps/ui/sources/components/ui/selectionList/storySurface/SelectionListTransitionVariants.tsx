/**
 * FR4-14 — transition stress variant for the story surface.
 *
 * Hosts a push/pop interaction with motion enabled so the cross-slide
 * animation is visible in the story deck. Motion is independently covered
 * by the SelectionList motion primitive tests; this surface exists to make
 * the animation reviewable visually.
 */

import * as React from 'react';

import {
    SelectionList,
    VariantBlock,
    makeVariantProps,
    storyVariantTestId,
    type SelectionListStep,
} from './_shared';

function TransitionStressHost(props: Readonly<{ testID: string }>): React.ReactElement {
    const subStep: SelectionListStep = React.useMemo(() => ({
        id: 'stress-sub',
        title: 'Sub-step',
        backLabel: 'Stress root',
        inputPlaceholder: '',
        sections: [
            {
                kind: 'static',
                id: 'sub-rows',
                title: 'SUB ROWS',
                options: [
                    { id: 'sub-a', label: 'Sub A' },
                    { id: 'sub-b', label: 'Sub B' },
                ],
            },
        ],
    }), []);
    const rootStep: SelectionListStep = React.useMemo(() => ({
        id: 'stress-root',
        inputPlaceholder: 'Stress test',
        sections: [
            {
                kind: 'static',
                id: 'root-rows',
                title: 'STRESS ROWS',
                options: [
                    { id: 'go-sub', label: 'Push sub-step', openStep: subStep },
                ],
            },
        ],
        footerHints: [
            { id: 'enter', label: '↵', description: 'push' },
            { id: 'esc', label: 'Esc', description: 'pop' },
        ],
    }), [subStep]);
    return (
        <SelectionList
            {...makeVariantProps(rootStep, props.testID)}
            disableTransitions={false}
        />
    );
}

export function SelectionListTransitionVariants(props: Readonly<{
    rootTestID: string;
}>): React.ReactElement {
    const { rootTestID } = props;
    return (
        <VariantBlock
            testID={storyVariantTestId(rootTestID, 'transition-stress')}
            title="Transition stress — push / pop with motion enabled"
        >
            <TransitionStressHost testID={`${rootTestID}-transition-stress-list`} />
        </VariantBlock>
    );
}
