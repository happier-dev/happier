import * as React from 'react';
import { ConnectedAccountConnectionTestResultSchema, type ConnectedAccountConnectionTestResult } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import { buildConnectedAccountTestConnectionInputV1 } from '@happier-dev/protocol/connect/configurationActionsV1';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { resolveConnectedServiceSettingsErrorMessage } from '../connectedServiceSettingsErrors';
import { t } from '@/text';

function describeResult(result: ConnectedAccountConnectionTestResult): string {
    switch (result.status) {
        case 'ok': return t('connectedServicesSettings.testConnectionSucceeded');
        case 'needsReauth': return t('connectedServicesSettings.testConnectionNeedsReauth');
        case 'networkUnavailable': return t('connectedServicesSettings.testConnectionNetworkUnavailable');
        case 'unsupported': return result.reason ?? t('connectedServicesSettings.testConnectionUnsupported');
    }
}

/** One mounted Action and result for the account's Sign-in control and overflow item. */
export function useConnectedAccountTestConnection(params: Readonly<{
    serverId?: string;
    account: QualifiedConnectedAccountRef;
    machineId?: string | null;
}>) {
    const execution = useMountedActionExecution(params.serverId);
    const [pending, setPending] = React.useState(false);
    const pendingRef = React.useRef(false);
    const [result, setResult] = React.useState<ConnectedAccountConnectionTestResult | null>(null);
    const [error, setError] = React.useState<string | undefined>();
    const { account, machineId } = params;
    const run = React.useCallback(async () => {
        if (pendingRef.current) return;
        pendingRef.current = true;
        setPending(true);
        setError(undefined);
        try {
            const response = await execution.execute('connectedServices.accounts.testConnection',
                buildConnectedAccountTestConnectionInputV1({ account, ...(machineId ? { machineId } : {}) }));
            if (!execution.isCurrent()) return;
            if (!response.ok) throw createActionExecuteFailureError(response);
            setResult(ConnectedAccountConnectionTestResultSchema.parse(response.result));
        } catch (cause) {
            if (execution.isCurrent()) setError(resolveConnectedServiceSettingsErrorMessage(cause));
        } finally {
            pendingRef.current = false;
            setPending(false);
        }
    }, [account, execution.execute, execution.isCurrent, machineId]);
    const disabledReason = !params.serverId ? t('common.unavailable')
        : result?.status === 'unsupported' ? describeResult(result) : undefined;
    return { execution, control: { run, pending, disabledReason,
        message: error ?? (result ? describeResult(result) : undefined) } };
}
