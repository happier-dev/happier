import * as React from 'react';
import type { z } from 'zod/mini';
import type { REGISTRY_ACTION_INPUT_SCHEMAS_V1, REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/registries';
import { REGISTRY_SOURCE_DELETE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { presentActionApproval } from '@/components/approvals/actionApprovalPresentation';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { Modal } from '@/modal';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import type { UiActionOperation } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { t } from '@/text';

export function useRegistrySourceMutations() {
    const scope = useAccountSettingsScope();
    const execution = useMountedActionExecution(scope);
    const execute = React.useCallback(async <K extends 'registries.sources.detect' | 'registries.sources.create' | 'registries.sources.update' | 'registries.sources.token.set' | 'registries.sources.delete'>(
        actionId: K, input: z.infer<(typeof REGISTRY_ACTION_INPUT_SCHEMAS_V1)[K]>, operation?: Pick<UiActionOperation, 'confirmed'>): Promise<z.infer<(typeof REGISTRY_ACTION_OUTPUT_SCHEMAS_V1)[K]>> => {
        const result = await execution.execute(actionId, input, operation);
        if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode, result });
        // The registry protocol host validated the result for this same Action id.
        return result.result as z.infer<(typeof REGISTRY_ACTION_OUTPUT_SCHEMAS_V1)[K]>;
    }, [execution.execute]);
    const remove = React.useCallback(async (sourceId: string) => {
        const input = { sourceId };
        const presentation = presentActionApproval({ actionId: REGISTRY_SOURCE_DELETE_ACTION_ID_V1, actionArgs: input });
        const confirmed = await Modal.confirm(presentation.title ?? t('capabilities.registries.detail.remove'), presentation.summary ?? '', {
            ...(presentation.confirmLabel ? { confirmText: presentation.confirmLabel } : {}),
            signal: execution.getSignal(),
        });
        if (!confirmed) throw Object.assign(new Error('approval_canceled'), { code: 'approval_canceled' });
        return execute(REGISTRY_SOURCE_DELETE_ACTION_ID_V1, input, { confirmed: true });
    }, [execute, execution.getSignal]);
    return React.useMemo(() => ({ ready: execution.ready, execute,
        detect: (input: z.infer<typeof REGISTRY_ACTION_INPUT_SCHEMAS_V1['registries.sources.detect']>) => execute('registries.sources.detect', input),
        create: (input: z.infer<typeof REGISTRY_ACTION_INPUT_SCHEMAS_V1['registries.sources.create']>) => execute('registries.sources.create', input),
        update: (input: z.infer<typeof REGISTRY_ACTION_INPUT_SCHEMAS_V1['registries.sources.update']>) => execute('registries.sources.update', input),
        setToken: (input: z.infer<typeof REGISTRY_ACTION_INPUT_SCHEMAS_V1['registries.sources.token.set']>) => execute('registries.sources.token.set', input),
        delete: remove,
    }), [execute, execution.ready, remove]);
}
