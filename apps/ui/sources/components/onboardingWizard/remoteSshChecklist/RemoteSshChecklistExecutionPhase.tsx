import * as React from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import type { PlanChecklistItem } from '@/components/systemTasks/planChecklist';
import { PlanChecklistCard } from '@/components/systemTasks/planChecklist';
import type { PlanChecklistExecutionState } from '@/components/systemTasks/planChecklist';
import { t } from '@/text';
import type { SystemTaskRunState } from '@/components/systemTasks/types';

import type { RemoteSshChecklistCopy } from './remoteSshChecklistCopy';
import { remoteSshChecklistStyles } from './remoteSshChecklistStyles';

export type RemoteSshChecklistExecutionPhaseProps = Readonly<{
    testID?: string;
    copy: RemoteSshChecklistCopy;
    planItems: readonly PlanChecklistItem[];
    executionById: Readonly<Record<string, PlanChecklistExecutionState>>;
    selectedIds: readonly string[];
    expandedIds: readonly string[];
    onToggleExpanded: (id: string) => void;
    onCopyDiagnostics: (item: PlanChecklistItem) => void;
    promptBlock: React.ReactNode;
    startErrorMessage: string | null;
    activeTaskSnapshot: SystemTaskRunState | null;
}>;

export const RemoteSshChecklistExecutionPhase = React.memo(function RemoteSshChecklistExecutionPhase(
    props: RemoteSshChecklistExecutionPhaseProps,
) {
    const styles = remoteSshChecklistStyles;

    return (
        <View testID={props.testID} style={styles.root}>
            <View style={styles.heading}>
                <Text style={styles.title}>{props.copy.executionTitle}</Text>
                <Text style={styles.subtitle}>{props.copy.executionSubtitle}</Text>
            </View>

            {props.startErrorMessage ? (
                <Text style={styles.subtitle}>{props.startErrorMessage}</Text>
            ) : null}

            <PlanChecklistCard
                testID={props.testID ? `${props.testID}-execution` : 'remote-ssh-checklist-execution'}
                phase="execute"
                items={props.planItems}
                executionById={props.executionById}
                selectedIds={props.selectedIds}
                expandedIds={props.expandedIds}
                onToggleExpanded={props.onToggleExpanded}
                onCopyDiagnostics={(item) => props.onCopyDiagnostics(item)}
            />

            {props.promptBlock}

            {props.activeTaskSnapshot && props.activeTaskSnapshot.result && !props.activeTaskSnapshot.result.ok ? (
                <Text style={styles.subtitle}>{t('setupOnboarding.remoteSshChecklist.completeSubtitleMachine')}</Text>
            ) : null}
        </View>
    );
});
