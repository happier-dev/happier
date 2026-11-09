import React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import type { ReviewCommentStateV1 } from '@happier-dev/protocol/reviews/comments/v1';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { StatusPill } from '@/components/ui/status/StatusPill';

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

/** One filter: a capsule chip that is itself the control; a check marks the ones narrowing the list. */
function FilterChip(props: Readonly<{ label: string; selected: boolean; onPress: () => void; testID: string }>) {
    const { theme } = useUnistyles();
    return (
        <HappierPressable
            accessibilityRole="button"
            selected={props.selected}
            onPress={props.onPress}
            testID={props.testID}
            style={(state) => [state.pressed ? styles.pressed : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
        >
            <StatusPill
                variant="neutral"
                shape="capsule"
                label={props.label}
                hideDot={!props.selected}
                leading={props.selected ? <Icon name="check" size={ICON_SIZE.xs} color={theme.colors.text.primary} /> : undefined}
                chrome="pill"
            />
        </HappierPressable>
    );
}

export function ReviewCommentFilters(props: ReviewCommentFiltersProps) {
    return (
        <View testID={props.testID} accessibilityLabel={props.labels.title} style={styles.row}>
            {props.stateOptions.map((state) => (
                <FilterChip
                    key={state}
                    label={props.labels.states[state]}
                    selected={props.selectedStates.includes(state)}
                    onPress={() => props.onToggleState?.(state)}
                    testID={`review-comment-filter-state-${state}`}
                />
            ))}
            {props.engineOptions?.map((engine) => (
                <FilterChip
                    key={engine.key}
                    label={engine.label}
                    selected={engine.selected}
                    onPress={() => props.onToggleEngine?.(engine.key)}
                    testID={`review-comment-filter-engine-${engine.key}`}
                />
            ))}
            {props.runOptions?.map((run) => (
                <FilterChip
                    key={run.key}
                    label={run.label}
                    selected={run.selected}
                    onPress={() => props.onToggleRun?.(run.key)}
                    testID={`review-comment-filter-run-${run.key}`}
                />
            ))}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s6 },
    pressed: { opacity: 0.7 },
}));
