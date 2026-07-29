import type { ProviderErrorV1 } from '@happier-dev/protocol';
import type {
    DaemonProviderModelProjectionGroupV1,
    DaemonProviderModelProjectionRowV1,
} from '@happier-dev/protocol/rpc';

import { t } from '@/text';
import { presentProviderError } from '@/providers/connection/errorPresentation';

export type ProviderModelRowPrimaryStatusKind =
    | 'authorization'
    | 'compatibility'
    | 'endpoint'
    | 'catalog'
    | 'load'
    | 'visibility';

export type ProviderModelRowVisibilityPresentation =
    | 'visible'
    | 'hidden'
    | 'hidden_for_all_agents'
    | 'hidden_current_selection';

type ProviderModelProjectionAuthorization = DaemonProviderModelProjectionGroupV1['authorization'];
type ProviderModelProjectionCompatibility = DaemonProviderModelProjectionRowV1['compatibility'];
type ProviderModelProjectionEndpointHealth = DaemonProviderModelProjectionRowV1['endpointHealth'];
type ProviderModelProjectionLoadState = DaemonProviderModelProjectionRowV1['loadState'];

export type ProviderModelRowPresentation = Readonly<{
    label: string;
    description: string | undefined;
    primaryStatus: Readonly<{
        kind: ProviderModelRowPrimaryStatusKind;
        label: string;
        error: ProviderErrorV1 | null;
    }> | null;
    selectionDisabled: boolean;
}>;

function endpointStatusLabel(status: ProviderModelProjectionEndpointHealth | undefined): string | null {
    switch (status) {
        case undefined:
        case 'available':
            return null;
        case 'not_checked':
            return t('settingsProviders.status.notChecked');
        case 'unreachable':
            return t('settingsProviders.status.unreachable');
        case 'temporarily_unavailable':
        case 'rate_limited':
        case 'unauthorized':
        case 'invalid_response':
            return t('settingsProviders.status.needsAttention');
    }
}

function visibilityStatusLabel(
    visibility: ProviderModelRowVisibilityPresentation | undefined,
): string | null {
    switch (visibility) {
        case undefined:
        case 'visible':
            return null;
        case 'hidden_for_all_agents':
            return t('settingsProviders.models.hiddenForAllAgents');
        case 'hidden':
        case 'hidden_current_selection':
            return t('settingsProviders.models.hidden');
    }
}

/**
 * Presents already-resolved Provider row facts. This is deliberately a view
 * decision only: authorization, compatibility, health, catalog, load, and
 * visibility remain owned by their daemon/protocol domains.
 */
export function presentProviderModelRow(input: Readonly<{
    modelId: string;
    name?: string;
    description?: string;
    contextLabel?: string;
    authorization?: ProviderModelProjectionAuthorization;
    compatibility?: ProviderModelProjectionCompatibility;
    canConfirmExperimental?: boolean;
    endpointHealth?: ProviderModelProjectionEndpointHealth;
    stale?: boolean;
    loadState?: ProviderModelProjectionLoadState;
    visibility?: ProviderModelRowVisibilityPresentation;
}>): ProviderModelRowPresentation {
    const label = input.name || input.modelId;
    const authorizationError = input.authorization?.authorized === false
        ? input.authorization.error
        : null;
    const compatibilityStatus = input.compatibility?.result.status;
    const compatibilityBlocksSelection = compatibilityStatus === 'incompatible'
        || (compatibilityStatus === 'experimental'
            && input.compatibility?.confirmed !== true
            && input.canConfirmExperimental !== true);
    const endpointLabel = endpointStatusLabel(input.endpointHealth);
    const visibilityLabel = visibilityStatusLabel(input.visibility);

    const primaryStatus: ProviderModelRowPresentation['primaryStatus'] = authorizationError
        ? {
            kind: 'authorization',
            label: t(presentProviderError(authorizationError).titleKey),
            error: authorizationError,
        }
        : compatibilityBlocksSelection
            ? {
                kind: 'compatibility',
                label: compatibilityStatus === 'incompatible'
                    ? t('settingsProviders.compatibility.incompatible')
                    : t('settingsProviders.errors.unverifiedTitle'),
                error: null,
            }
            : endpointLabel
                ? { kind: 'endpoint', label: endpointLabel, error: null }
                : input.stale
                    ? { kind: 'catalog', label: t('settingsProviders.models.stale'), error: null }
                    : input.loadState === 'unloaded'
                        ? { kind: 'load', label: t('settingsProviders.models.notLoaded'), error: null }
                        : visibilityLabel
                            ? { kind: 'visibility', label: visibilityLabel, error: null }
                            : null;

    const details: string[] = [];
    const pushDetail = (value: string | null | undefined) => {
        const normalized = value?.trim();
        if (normalized && normalized !== label && !details.includes(normalized)) details.push(normalized);
    };
    pushDetail(input.contextLabel);
    if (label !== input.modelId) pushDetail(input.modelId);
    pushDetail(input.description);
    pushDetail(primaryStatus?.label);
    if (compatibilityStatus === 'experimental') pushDetail(t('settingsProviders.models.experimental'));
    if (input.stale) pushDetail(t('settingsProviders.models.stale'));
    if (input.loadState === 'unloaded') pushDetail(t('settingsProviders.models.notLoaded'));

    return {
        label,
        description: details.length > 0 ? details.join(' · ') : undefined,
        primaryStatus,
        selectionDisabled: authorizationError !== null
            || compatibilityBlocksSelection
            || input.visibility === 'hidden_current_selection',
    };
}
