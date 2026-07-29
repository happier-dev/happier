import {
    SessionModelSelectionIntentV1Schema,
    readSessionProviderBindingMetadataStateV1,
    type SessionModelSelectionV1,
} from '@happier-dev/protocol';
import {
    isRpcMethodNotAvailableError,
    isRpcMethodNotFoundError,
} from '@happier-dev/protocol/rpcErrors';

export function isProviderSafeDaemonSessionMethodAbsent(error: unknown): boolean {
    return isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error);
}

export function requiresProviderSafeSessionRpc(params: Readonly<{
    modelSelection?: SessionModelSelectionV1;
    existingSessionMetadata?:
        | Readonly<{ state: 'known'; metadata: Readonly<Record<string, unknown>> }>
        | Readonly<{ state: 'unknown' }>;
}>): boolean {
    const explicitSelectionRequiresProvider = params.modelSelection?.ref.providerConnectionId != null;

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
