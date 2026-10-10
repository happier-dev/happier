import { SessionModelSelectionIntentV1Schema, type ProviderBoundModelRef, type SessionModelSelectionV1 } from '@happier-dev/protocol/providers/model-selection';
import { readSessionProviderBindingMetadataStateV1 } from '@happier-dev/protocol/providers/sessions/bindingMetadataV1';
import {
    createRpcCallError,
    isRpcMethodNotAvailableError,
    isRpcMethodNotFoundError,
} from '@happier-dev/protocol/rpcErrors';

export function isProviderSafeDaemonSessionMethodAbsent(error: unknown): boolean {
    if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) return true;
    if (!error || typeof error !== 'object') return false;
    const response = error as { error?: unknown; errorCode?: unknown };
    if (typeof response.error !== 'string' || typeof response.errorCode !== 'string') return false;
    const transportError = createRpcCallError({ error: response.error, errorCode: response.errorCode });
    return isRpcMethodNotAvailableError(transportError) || isRpcMethodNotFoundError(transportError);
}

export function requiresProviderSafeModelSelectionRpc(
    ...selections: readonly (ProviderBoundModelRef | null | undefined)[]
): boolean {
    return selections.some((selection) => selection?.providerConnectionId != null);
}

export function requiresProviderSafeSessionRpc(params: Readonly<{
    modelSelection?: SessionModelSelectionV1;
    existingSessionMetadata?:
        | Readonly<{ state: 'known'; metadata: Readonly<Record<string, unknown>> }>
        | Readonly<{ state: 'unknown' }>;
}>): boolean {
    const explicitSelectionRequiresProvider = requiresProviderSafeModelSelectionRpc(params.modelSelection?.ref);

    if (params.existingSessionMetadata?.state === 'unknown') {
        return true;
    }
    const metadata = params.existingSessionMetadata?.metadata;
    if (!metadata) return explicitSelectionRequiresProvider;

    if (readSessionProviderBindingMetadataStateV1(metadata).kind !== 'absent') {
        return true;
    }

    if (!Object.prototype.hasOwnProperty.call(metadata, 'modelSelectionIntentV1')) {
        return explicitSelectionRequiresProvider;
    }
    const parsedIntent = SessionModelSelectionIntentV1Schema.safeParse(metadata.modelSelectionIntentV1);
    if (!parsedIntent.success) {
        return true;
    }
    return explicitSelectionRequiresProvider || parsedIntent.data.selection?.providerConnectionId != null;
}
