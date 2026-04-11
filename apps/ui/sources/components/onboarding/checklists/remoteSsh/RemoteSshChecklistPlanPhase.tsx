import * as React from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import type { PlanChecklistItem } from '@/components/systemTasks/planChecklist';
import { PlanChecklistCard } from '@/components/systemTasks/planChecklist';

import type { RemoteSshChecklistCopy } from './copy';
import { remoteSshChecklistStyles } from './styles';

export type RemoteSshChecklistPlanPhaseProps = Readonly<{
    testID?: string;
    copy: RemoteSshChecklistCopy;
    planItems: readonly PlanChecklistItem[];
    selectedIds: readonly string[];
    expandedIds: readonly string[];
    onToggleItem: (id: string) => void;
    onToggleExpanded: (id: string) => void;
    startErrorMessage: string | null;
}>;

export const RemoteSshChecklistPlanPhase = React.memo(function RemoteSshChecklistPlanPhase(
    props: RemoteSshChecklistPlanPhaseProps,
) {
    const styles = remoteSshChecklistStyles;

    return (
        <View testID={props.testID} style={styles.root}>
            <View style={styles.heading}>
                <Text style={styles.title}>{props.copy.planTitle}</Text>
                <Text style={styles.subtitle}>{props.copy.planSubtitle}</Text>
            </View>

            <PlanChecklistCard
                testID={props.testID ? `${props.testID}-plan` : 'remote-ssh-checklist-plan'}
                phase="select"
                variant="onboarding"
                items={props.planItems}
                selectedIds={props.selectedIds}
                expandedIds={props.expandedIds}
                onToggleItem={props.onToggleItem}
                onToggleExpanded={props.onToggleExpanded}
            />

            {props.startErrorMessage ? (
                <Text style={styles.promptBody}>{props.startErrorMessage}</Text>
            ) : null}
        </View>
    );
});
