import * as React from 'react';
import { View } from 'react-native';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import type { SystemTaskRunState } from './types';
import { resolveSystemTaskStepLabel } from './resolveSystemTaskStepLabel';

function translateStatus(snapshot: SystemTaskRunState): string {
    if (snapshot.awaitingInput) {
        return t('settings.machineSetupTaskWaitingForInput');
    }
    switch (snapshot.status) {
        case 'canceling':
            return t('common.loading');
        case 'canceled':
            return t('common.cancel');
        case 'failed':
            return t('common.error');
        case 'succeeded':
            return t('common.done');
        default:
            return t('common.loading');
    }
}

function renderValue(value: string | null): string {
    return value ?? t('settingsProviders.notAvailable');
}

export const SystemTaskProgressCard = React.memo(function SystemTaskProgressCard(props: Readonly<{
    snapshot: SystemTaskRunState;
    onCancel?: () => void;
    title?: string;
}>) {
    const canCancel = Boolean(props.onCancel) && (props.snapshot.status === 'running' || props.snapshot.status === 'canceling');
    const stepLabel = resolveSystemTaskStepLabel(props.snapshot.currentStepId);
    const latestMessage = props.snapshot.latestMessage;

    return (
        <View testID="system-task-progress-card">
            <ItemGroup title={props.title ?? t('settings.machineSetupCurrentMachineTitle')}>
                <Item
                    testID={`system-task-progress-status-${props.snapshot.status}`}
                    title={translateStatus(props.snapshot)}
                    showChevron={false}
                    mode="info"
                />
                <Item
                    title={t('settings.systemTaskCurrentStepLabel')}
                    subtitle={renderValue(stepLabel)}
                    subtitleTestID="system-task-step-label"
                    showChevron={false}
                    mode="info"
                />
                <Item
                    title={t('settings.systemTaskLatestUpdateLabel')}
                    subtitle={renderValue(latestMessage)}
                    subtitleTestID="system-task-message"
                    showChevron={false}
                    mode="info"
                />
                {canCancel ? (
                    <Item
                        testID="system-task-progress-cancel"
                        title={t('common.cancel')}
                        onPress={props.onCancel}
                        destructive
                    />
                ) : null}
            </ItemGroup>
        </View>
    );
});
