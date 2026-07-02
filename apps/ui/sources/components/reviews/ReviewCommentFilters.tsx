import React from 'react';
import { Pressable, View } from 'react-native';

import type { ReviewCommentStateV1 } from '@happier-dev/protocol';

import { Text } from '@/components/ui/text/Text';

export type ReviewCommentFilterOption = Readonly<{
    key: string;
    label: string;
    selected: boolean;
}>;

export type ReviewCommentFiltersProps = Readonly<{
    labels: Readonly<{
        title: string;
        states: Readonly<Record<ReviewCommentStateV1, string>>;
    }>;
    stateOptions: readonly ReviewCommentStateV1[];
    selectedStates: readonly ReviewCommentStateV1[];
    engineOptions?: readonly ReviewCommentFilterOption[];
    runOptions?: readonly ReviewCommentFilterOption[];
    onToggleState?: (state: ReviewCommentStateV1) => void;
    onToggleEngine?: (engineId: string) => void;
    onToggleRun?: (runId: string) => void;
    testID?: string;
}>;

function isStateSelected(props: ReviewCommentFiltersProps, state: ReviewCommentStateV1): boolean {
    return props.selectedStates.includes(state);
}

export function ReviewCommentFilters(props: ReviewCommentFiltersProps) {
    return (
        <View testID={props.testID}>
            <Text>{props.labels.title}</Text>
            {props.stateOptions.map((state) => (
                <Pressable
                    key={state}
                    accessibilityState={{ selected: isStateSelected(props, state) }}
                    onPress={() => props.onToggleState?.(state)}
                    testID={`review-comment-filter-state-${state}`}
                >
                    <Text>{props.labels.states[state]}</Text>
                </Pressable>
            ))}
            {props.engineOptions?.map((engine) => (
                <Pressable
                    key={engine.key}
                    accessibilityState={{ selected: engine.selected }}
                    onPress={() => props.onToggleEngine?.(engine.key)}
                    testID={`review-comment-filter-engine-${engine.key}`}
                >
                    <Text>{engine.label}</Text>
                </Pressable>
            ))}
            {props.runOptions?.map((run) => (
                <Pressable
                    key={run.key}
                    accessibilityState={{ selected: run.selected }}
                    onPress={() => props.onToggleRun?.(run.key)}
                    testID={`review-comment-filter-run-${run.key}`}
                >
                    <Text>{run.label}</Text>
                </Pressable>
            ))}
        </View>
    );
}
