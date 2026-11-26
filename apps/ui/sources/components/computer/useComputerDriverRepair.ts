import * as React from 'react';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readActionFailureEnvelope } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import type { ComputerRecovery } from '@/sync/domains/computer/targets';
import { MachineCapabilityInstallOutputSchema } from '@happier-dev/protocol/actions/specs/machineConnection';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { Modal } from '@/modal';
import { alertActionFailure } from '@/utils/errors/alertActionFailure';
import { presentActionExecutionFailure } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import type { ComputerScope } from '@/sync/domains/computer/computerControlClient';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

function showRepairFailure(failure?: ActionExecuteFailure | null): void {
    if (!failure) {
        Modal.alert(t('common.error'), t('deps.installFailed'));
        return;
    }
    const presentation = presentActionExecutionFailure(failure, t('deps.installFailed'), { closedCodesOnly: true });
    alertActionFailure({ reason: presentation.reason, code: failure.errorCode, requestId: failure.requestId,
        context: Object.fromEntries(presentation.technicalDetails.filter(line => line.key !== 'code' && line.key !== 'requestId')
            .map(line => [line.key, line.value])) });
}

/** Explicit repair uses the existing admitted installer and then re-reads native facts. */
export function useComputerDriverRepair(scope: ComputerScope, accountLifetime: ServerAccountScopeLifetime | null | undefined, refresh: () => void, recovery: ComputerRecovery | null) {
    const { execute, isCurrent } = useMountedActionExecution(accountLifetime?.scope ?? null);
    const installation = React.useMemo(() => ({ execute, isCurrent, accountLifetime, machineId: scope.machineId, serverId: scope.serverId }),
        [accountLifetime, execute, isCurrent, scope.machineId, scope.serverId]);
    const [flight, setFlight] = React.useState<typeof installation | null>(null);
    const current = React.useRef(installation);
    current.current = installation;
    const installHint = recovery?.action === 'repair_driver' ? recovery.installHint : undefined;
    const repair = React.useCallback(() => {
        if (!installHint || !installation.isCurrent() || !accountLifetime?.isCurrent() || flight === installation) return;
        setFlight(installation);
        void (async () => {
            try {
                const execution = await installation.execute(installHint.actionId, {
                    machineId: scope.machineId, serverId: scope.serverId ?? undefined,
                    capabilityId: installHint.capabilityId, method: 'install',
                });
                if (!installation.isCurrent() || !accountLifetime.isCurrent() || current.current !== installation) return;
                if (!execution.ok) {
                    showRepairFailure(execution);
                } else {
                    const result = MachineCapabilityInstallOutputSchema.safeParse(execution.result);
                    if (!result.success) Modal.alert(t('common.error'), t('deps.installFailed'));
                    else if (!result.data.supported) Modal.alert(t('common.error'), result.data.reason === 'not-supported' ? t('deps.installNotSupported') : t('deps.installFailed'));
                    else if (!result.data.response.ok) {
                        const failure = result.data.response.error;
                        showRepairFailure(failure.code ? { ok: false, errorCode: failure.code, error: failure.message } : undefined);
                    }
                }
                refresh();
            } catch (error) {
                if (installation.isCurrent() && accountLifetime.isCurrent() && current.current === installation) showRepairFailure(readActionFailureEnvelope(error));
            } finally {
                if (current.current === installation) setFlight(null);
            }
        })();
    }, [accountLifetime, flight, installation, installHint, refresh, scope.machineId, scope.serverId]);
    return { repair, repairing: flight === installation };
}
