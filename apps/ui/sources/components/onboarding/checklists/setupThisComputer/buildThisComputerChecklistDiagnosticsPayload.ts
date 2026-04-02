import { sanitizeBugReportUrl } from '@happier-dev/protocol';

import type { SystemTaskRunState } from '@/components/systemTasks/types';
import type { PlanChecklistExecutionState } from '@/components/systemTasks/planChecklist';

import type { ThisComputerSetupPreflight } from './types';

function redactId(value: string | null | undefined): string | null {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) return null;
    if (raw.length <= 8) return '***';
    return `${raw.slice(0, 4)}…${raw.slice(-4)}`;
}

export type ThisComputerChecklistDiagnosticsPayload = Readonly<{
    capturedAt: string;
    kind: 'setup.thisComputer';
    row: string;
    selection: readonly string[];
    activeRelayUrl: string | null;
    uiAccountId: string | null;
    daemon: Readonly<{
        serviceInstalled: boolean;
        daemonRunning: boolean;
        needsAuth: boolean;
        machineId: string | null;
        serverUrl: string | null;
        accountId: string | null;
        machineRegistered: boolean | null;
    }>;
    mismatch: Readonly<{
        serverMismatch: boolean;
        accountMismatch: boolean;
        pairingRequired: boolean;
    }>;
    task: Readonly<{
        status: string;
        currentStepId: string | null;
        errorCode?: string;
    }> | null;
    logs: PlanChecklistExecutionState['logs'];
    error: Readonly<{
        title: string;
        message: string | null;
    }> | null;
}>;

export function buildThisComputerChecklistDiagnosticsPayload(params: Readonly<{
    itemId: string;
    selectedIds: readonly string[];
    preflight: ThisComputerSetupPreflight;
    activeTaskSnapshot: SystemTaskRunState | null;
    executionById?: Readonly<Record<string, PlanChecklistExecutionState>> | undefined;
}>): ThisComputerChecklistDiagnosticsPayload {
    const rowExecution = params.executionById?.[params.itemId];

    return {
        capturedAt: new Date().toISOString(),
        kind: 'setup.thisComputer',
        row: params.itemId,
        selection: params.selectedIds,
        activeRelayUrl: sanitizeBugReportUrl(params.preflight.activeRelayUrl) ?? params.preflight.activeRelayUrl,
        uiAccountId: redactId(params.preflight.uiAccountId),
        daemon: {
            serviceInstalled: params.preflight.serviceInstalled,
            daemonRunning: params.preflight.daemonRunning,
            needsAuth: params.preflight.needsAuth,
            machineId: redactId(params.preflight.machineId),
            serverUrl: sanitizeBugReportUrl(params.preflight.daemonServerUrl) ?? params.preflight.daemonServerUrl,
            accountId: redactId(params.preflight.daemonAccountId),
            machineRegistered: params.preflight.daemonMachineRegistered,
        },
        mismatch: {
            serverMismatch: params.preflight.serverMismatch,
            accountMismatch: params.preflight.accountMismatch,
            pairingRequired: params.preflight.pairingRequired,
        },
        task: params.activeTaskSnapshot?.result && !params.activeTaskSnapshot.result.ok
            ? {
                status: params.activeTaskSnapshot.status,
                currentStepId: params.activeTaskSnapshot.currentStepId ?? null,
                errorCode: params.activeTaskSnapshot.result.error.code,
            }
            : params.activeTaskSnapshot
                ? {
                    status: params.activeTaskSnapshot.status,
                    currentStepId: params.activeTaskSnapshot.currentStepId ?? null,
                }
                : null,
        logs: rowExecution?.logs ?? [],
        error: rowExecution?.error
            ? {
                title: rowExecution.error.title,
                message: rowExecution.error.message ?? null,
            }
            : null,
    };
}
