import * as React from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import type { PlanChecklistItem } from '@/components/systemTasks/planChecklist';
import { PlanChecklistCard } from '@/components/systemTasks/planChecklist';

import type { RemoteSshChecklistCopy } from './copy';
import { remoteSshChecklistStyles } from './styles';

export type RemoteSshChecklistCompletePhaseProps = Readonly<{
    testID?: string;
    copy: RemoteSshChecklistCopy;
    planItems: readonly PlanChecklistItem[];
    selectedIds: readonly string[];
    completionRelayUrl: string | null;
}>;

export const RemoteSshChecklistCompletePhase = React.memo(function RemoteSshChecklistCompletePhase(
    props: RemoteSshChecklistCompletePhaseProps,
) {
    const styles = remoteSshChecklistStyles;
    const completedItems = React.useMemo(() => {
        const selectedIds = new Set(props.selectedIds);
        return props.planItems.map((item) => (
            selectedIds.has(item.id)
                ? { ...item, satisfied: true }
                : item
        ));
    }, [props.planItems, props.selectedIds]);

    return (
        <View testID={props.testID} style={styles.root}>
            <View style={styles.heading}>
                <Text style={styles.title}>{props.copy.completeTitle}</Text>
                <Text style={styles.subtitle}>
                    {props.completionRelayUrl
                        ? `${props.copy.completeSubtitle} ${props.completionRelayUrl}`
                        : props.copy.completeSubtitle}
                </Text>
            </View>

            <PlanChecklistCard
                testID={props.testID ? `${props.testID}-complete-checklist` : 'remote-ssh-checklist-complete-checklist'}
                phase="select"
                variant="onboarding"
                items={completedItems}
                selectedIds={props.selectedIds}
            />
        </View>
    );
});
