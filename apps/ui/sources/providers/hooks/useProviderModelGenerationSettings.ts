import * as React from 'react';
import type { ProviderConnectionV1 } from '@happier-dev/protocol/providers/connections/v1';
import type { ProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type { DaemonProviderConnectionMutationResponseV1 } from '@happier-dev/protocol/rpc/providers';

import type { ProviderPendingApproval } from '@/providers/actions/useProviderActionClient';
import { useProviderConnectionMutation } from './useProviderConnectionMutation';
import type { UiActionOperation } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

type ProviderModelGenerationSettingsInput = Parameters<typeof useProviderConnectionMutation>[0] & Readonly<{
    /** The page's already-admitted Account connection; no second catalog reader. */
    connection: Pick<ProviderConnectionV1, 'id' | 'revision' | 'modelSettings'> | null;
    modelId: string | null;
}>;

export type ProviderModelGenerationSettings = Readonly<{
    value: number | null;
    save: (maxTokens: number, options?: Pick<UiActionOperation, 'confirmed'>) => Promise<DaemonProviderConnectionMutationResponseV1 | null>;
    clear: (options?: Pick<UiActionOperation, 'confirmed'>) => Promise<DaemonProviderConnectionMutationResponseV1 | null>;
    pending: boolean;
    error: ProviderErrorV1 | null;
    retry: (() => Promise<void>) | undefined;
    pendingApproval: ProviderPendingApproval | null;
    clearError: () => void;
}>;

/** Per-model authoring through the existing revision/approval/Account write owner. */
export function useProviderModelGenerationSettings(input: ProviderModelGenerationSettingsInput): ProviderModelGenerationSettings {
    const mutation = useProviderConnectionMutation(input);
    const connectionId = input.connection?.id;
    const revision = input.connection?.revision;
    const modelId = input.modelId;
    const key = JSON.stringify(['generation-settings', connectionId, modelId]);
    const { run } = mutation;
    const update = React.useCallback((maxTokens: number | null, options?: Pick<UiActionOperation, 'confirmed'>) => {
        if (!connectionId || revision === undefined || !modelId) return Promise.resolve(null);
        return run({ action: 'update', connectionId, expectedRevision: revision,
            modelSettings: { [modelId]: { maxTokens } } }, key, options);
    }, [connectionId, revision, modelId, key, run]);
    const save = React.useCallback((maxTokens: number, options?: Pick<UiActionOperation, 'confirmed'>) => {
        if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
            throw new RangeError('Output allowance must be a positive safe integer');
        }
        return update(maxTokens, options);
    }, [update]);
    // Clear only this preference, not temperature or the model's other fields.
    const clear = React.useCallback((options?: Pick<UiActionOperation, 'confirmed'>) => update(null, options), [update]);
    const ownsError = mutation.errorKey === key;
    return {
        value: modelId ? input.connection?.modelSettings?.[modelId]?.maxTokens ?? null : null,
        save,
        clear,
        pending: mutation.isPending(key),
        error: ownsError ? mutation.error : null,
        retry: ownsError ? mutation.retry : undefined,
        pendingApproval: mutation.pendingApproval,
        clearError: mutation.clearError,
    };
}
