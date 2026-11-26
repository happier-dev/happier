import * as React from 'react';
import type { SimulatorDeviceOperationResultV1 } from '@happier-dev/protocol/devices/simulator/operationsV1';

import { readActionFailureEnvelope } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { Modal } from '@/modal';
import { presentActionExecutionFailure } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { alertActionFailure } from '@/utils/errors/alertActionFailure';
import type { SimulatorPreviewActions } from '@/sync/domains/devices/simulator/useSimulatorPreview';
import type { SimulatorDeviceOperationRequest } from '@/sync/domains/devices/simulator/types';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { t } from '@/text';

function presentSimulatorDeviceFailure(error: unknown): void {
    const failure = readActionFailureEnvelope(error);
    const title = t('simulatorPreview.device.operationFailed');
    if (!failure) {
        Modal.alert(title, t('errors.unknownError'));
        return;
    }
    const fallback = resolveReasonCopy({ reasonCode: failure.errorCode, kind: 'simulatorPreview' }).body;
    const presentation = presentActionExecutionFailure(failure, fallback, { closedCodesOnly: true });
    alertActionFailure({ title, reason: presentation.reason, code: failure.errorCode, requestId: failure.requestId,
        context: Object.fromEntries(presentation.technicalDetails.filter(line => line.key !== 'code').map(line => [line.key, line.value])) });
}

/**
 * Runs one device operation for a control and tells the person how it ended: the control that
 * started it shows busy while the Action runs, and a typed failure says its cause once. Success
 * needs no extra message; the device (or the Session, for a screenshot) shows the result.
 */
export function useSimulatorDeviceOperation(actions: Partial<SimulatorPreviewActions>): Readonly<{
    pending: string | null;
    run: (
        key: string,
        simulatorId: string,
        request: SimulatorDeviceOperationRequest,
    ) => Promise<SimulatorDeviceOperationResultV1 | null>;
}> {
    const [pending, setPending] = React.useState<string | null>(null);
    const runDeviceOperation = actions.runDeviceOperation;
    const run = React.useCallback(async (key: string, simulatorId: string, request: SimulatorDeviceOperationRequest) => {
        if (!runDeviceOperation) return null;
        setPending(key);
        try {
            const result = await runDeviceOperation(simulatorId, request);
            if (result && !result.ok) {
                presentSimulatorDeviceFailure(result);
            }
            return result;
        } catch (error) {
            presentSimulatorDeviceFailure(error);
            return null;
        } finally {
            setPending((current) => (current === key ? null : current));
        }
    }, [runDeviceOperation]);
    return { pending, run };
}
