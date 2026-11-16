import * as React from 'react';
import type { SimulatorDeviceOperationResultV1 } from '@happier-dev/protocol/devices/simulator/operationsV1';

import { Modal } from '@/modal';
import type { SimulatorPreviewActions } from '@/sync/domains/devices/simulator/useSimulatorPreview';
import type { SimulatorDeviceOperationRequest } from '@/sync/domains/devices/simulator/types';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { t } from '@/text';

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
                const copy = resolveReasonCopy({ reasonCode: result.errorCode, kind: 'simulatorPreview' });
                Modal.alert(t('simulatorPreview.device.operationFailed'), copy.body);
            }
            return result;
        } catch (error) {
            Modal.alert(t('simulatorPreview.device.operationFailed'), error instanceof Error ? error.message : t('errors.unknownError'));
            return null;
        } finally {
            setPending((current) => (current === key ? null : current));
        }
    }, [runDeviceOperation]);
    return { pending, run };
}
