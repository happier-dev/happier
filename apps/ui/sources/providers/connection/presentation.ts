import type { DaemonProviderConnectionViewV1 } from '@happier-dev/protocol/rpc';

export type ProviderConnectionPresentationStatus =
    | 'available'
    | 'partial'
    | 'notChecked'
    | 'needsAttention'
    | 'unreachable'
    | 'disabled'
    | 'sourceUnavailable';

export const PROVIDER_CONNECTION_STATUS_VARIANT = Object.freeze({
    available: 'success',
    partial: 'warning',
    notChecked: 'neutral',
    needsAttention: 'warning',
    unreachable: 'danger',
    disabled: 'neutral',
    sourceUnavailable: 'warning',
} as const satisfies Record<ProviderConnectionPresentationStatus, 'success' | 'warning' | 'danger' | 'neutral'>);

export const PROVIDER_CONNECTION_STATUS_KEY = Object.freeze({
    available: 'settingsProviders.status.available',
    partial: 'settingsProviders.status.partial',
    notChecked: 'settingsProviders.status.notChecked',
    needsAttention: 'settingsProviders.status.needsAttention',
    unreachable: 'settingsProviders.status.unreachable',
    disabled: 'settingsProviders.status.disabled',
    sourceUnavailable: 'settingsProviders.status.sourceUnavailable',
} as const);

export function presentProviderConnection(connection: DaemonProviderConnectionViewV1): Readonly<{
    title: string;
    subtitle: string;
    modelCount: number | null;
    status: ProviderConnectionPresentationStatus;
}> {
    const collapsesToProvider = connection.role === 'default' && connection.displayNameMode === 'automatic';
    const title = collapsesToProvider ? connection.providerName : connection.displayName;
    const provenance = collapsesToProvider ? '' : connection.providerName;
    const status: ProviderConnectionPresentationStatus = connection.sourceStatus === 'unavailable'
        ? 'sourceUnavailable'
        : connection.authorizationError?.code === 'provider_endpoint_unreachable'
            ? 'unreachable'
            : !connection.grants.accountEnabled && connection.grants.enabledMachineIds.length === 0
                ? 'disabled'
                : connection.runtime.health === 'available'
                    ? 'available'
                    : connection.runtime.health === 'partial'
                        ? 'partial'
                    : connection.runtime.health === 'unreachable'
                        ? 'unreachable'
                        : connection.runtime.health === 'not_checked'
                            ? 'notChecked'
                            : 'needsAttention';
    return {
        title,
        subtitle: provenance,
        modelCount: connection.runtime.modelCount,
        status,
    };
}
