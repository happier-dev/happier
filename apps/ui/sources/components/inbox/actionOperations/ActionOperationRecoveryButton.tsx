import * as React from 'react';
import { useRouter } from 'expo-router';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DeploymentRecoveryButton } from '@/components/projects/deployments/deploymentRecoveryNavigation';
import { createWorkflowInvocationRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { t } from '@/text';

import type { ActionOperationDetailRecoveryAction } from './actionOperationDetailPresentation';

export function ActionOperationRecoveryButton(props: Readonly<{
    recovery: ActionOperationDetailRecoveryAction; serverId: string; onOpened: () => void;
}>) {
    const { recovery, onOpened } = props;
    const router = useRouter();
    switch (recovery.kind) {
        case 'setup_retry':
            return <RoundButton
                title={t('managedMachines.creation.retrySetup')}
                testID="action-operation-retry-setup"
                onPress={() => {
                    router.push(createWorkflowInvocationRoute(recovery.retry.runId, recovery.retry.invocationId, props.serverId) as never);
                    onOpened();
                }}
            />;
        case 'deployment_navigation':
            return <DeploymentRecoveryButton action={recovery.action} address={recovery.address} onOpened={onOpened} />;
    }
}
