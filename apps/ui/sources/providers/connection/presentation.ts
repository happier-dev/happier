import type { DaemonProviderConnectionViewV1 } from '@happier-dev/protocol/rpc';
import type { CollectionRowStatus } from '@/components/ui/lists/collection/CollectionStatusGlyph';

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

/** Configuration columns draw this state in their shared icon-only slot; health stays domain-owned. */
export const PROVIDER_CONNECTION_COLLECTION_STATUS = Object.freeze({
    available: null,
    partial: 'review',
    notChecked: null,
    needsAttention: 'review',
    unreachable: 'failed',
    disabled: 'off',
    sourceUnavailable: 'review',
} as const satisfies Record<ProviderConnectionPresentationStatus, CollectionRowStatus | null>);

/** Collection and cross-kind attention consume the same native eligibility. */
export function providerConnectionNeedsAttention(status: ProviderConnectionPresentationStatus): boolean {
    return PROVIDER_CONNECTION_COLLECTION_STATUS[status] === 'review' || PROVIDER_CONNECTION_COLLECTION_STATUS[status] === 'failed';
}

/** Source provenance distinguishes a named connection only when it adds an identity. */
export function presentProviderConnectionIdentity(connection: Pick<DaemonProviderConnectionViewV1,
    'role' | 'displayNameMode' | 'providerName' | 'displayName'>): Readonly<{ title: string; subtitle: string; sourceLabel: string }> {
    const collapsesToProvider = connection.role === 'default' && connection.displayNameMode === 'automatic';
    const title = collapsesToProvider ? connection.providerName : connection.displayName;
    const subtitle = title.trim().toLocaleLowerCase() === connection.providerName.trim().toLocaleLowerCase()
        ? '' : connection.providerName;
    // A name that already says its provider ("Work Vercel AI Gateway") identifies the source alone.
    const nameSaysProvider = title.trim().toLocaleLowerCase().includes(connection.providerName.trim().toLocaleLowerCase());
    return { title, subtitle, sourceLabel: !subtitle ? connection.providerName : nameSaysProvider ? title.trim() : `${subtitle} · ${title.trim()}` };
}

export function presentProviderConnection(connection: DaemonProviderConnectionViewV1): Readonly<{
    title: string;
    subtitle: string;
    enabled: boolean;
    status: ProviderConnectionPresentationStatus;
}> {
    const identity = presentProviderConnectionIdentity(connection);
    // Connection-wide controls admit Account access or clear all grants. The
    // inspected machine's effective access and on-demand process are separate facts.
    const enabled = connection.grants.accountEnabled || connection.grants.enabledMachineIds.length > 0;
    const status: ProviderConnectionPresentationStatus = connection.sourceStatus === 'unavailable'
        ? 'sourceUnavailable'
        : connection.authorizationError?.code === 'provider_endpoint_unreachable'
            ? 'unreachable'
            : !enabled
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
        title: identity.title,
        subtitle: identity.subtitle,
        enabled,
        status,
    };
}
