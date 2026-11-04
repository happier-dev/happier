import type { ProviderErrorV1 } from '@happier-dev/protocol';
import type {
    DaemonProviderModelProjectionGroupV1,
    DaemonProviderModelProjectionRowV1,
} from '@happier-dev/protocol/rpc';

import { t, type TranslationKeyNoParams } from '@/text';
import { presentProviderError } from '@/providers/connection/errorPresentation';

export type ProviderModelRowPrimaryStatusKind =
    | 'authorization'
    | 'compatibility'
    | 'endpoint'
    | 'catalog'
    | 'load'
    | 'visibility';

export type ProviderModelRowVisibilityPresentation = DaemonProviderModelProjectionRowV1['visibility'];

type ProviderModelProjectionAuthorization = DaemonProviderModelProjectionGroupV1['authorization'];
type ProviderModelProjectionCompatibility = DaemonProviderModelProjectionRowV1['compatibility'];
type ProviderModelProjectionEndpointHealth = DaemonProviderModelProjectionRowV1['endpointHealth'];
type ProviderModelProjectionConfidence = DaemonProviderModelProjectionRowV1['confidence'];
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
        case 'hidden_all_agents':
            return t('settingsProviders.models.hiddenForAllAgents');
        case 'hidden_agent':
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
    confidence?: ProviderModelProjectionConfidence;
    /**
     * A one-line row: the description keeps only facts that need the user (authorization,
     * compatibility, health, staleness, load state). The id, catalog description and source
     * context are not repeated under a name the row already shows.
     */
    statusOnly?: boolean;
}>): ProviderModelRowPresentation {
    const label = input.name || input.modelId;
    const authorizationError = input.authorization?.authorized === false
        ? input.authorization.error
        : null;
    // An Account view has no computer to confirm against, so its unconfirmed "experimental" and
    // "not checked" are facts about the whole source (see presentProviderSourceStatus), not each row.
    const compatibility = input.confidence === 'account_unverified'
        && input.compatibility?.result.status === 'experimental'
        ? undefined
        : input.compatibility;
    const compatibilityStatus = compatibility?.result.status;
    const compatibilityBlocksSelection = compatibilityStatus === 'incompatible'
        || (compatibilityStatus === 'experimental'
            && compatibility?.confirmed !== true
            && input.canConfirmExperimental !== true);
    const endpointLabel = input.confidence === 'account_unverified' && input.endpointHealth === 'not_checked'
        ? null
        : endpointStatusLabel(input.endpointHealth);
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
    if (input.statusOnly !== true) {
        pushDetail(input.contextLabel);
        if (label !== input.modelId) pushDetail(input.modelId);
        pushDetail(input.description);
    }
    pushDetail(primaryStatus?.label);
    if (compatibilityStatus === 'experimental') pushDetail(t('settingsProviders.models.experimental'));
    // "May be unavailable" only repeats an endpoint status that already says the source cannot be reached.
    if (input.stale && primaryStatus?.kind !== 'endpoint') pushDetail(t('settingsProviders.models.stale'));
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

export type ProviderSourceStatusPresentation = Readonly<{
    /** Some model of the source is experimental for this Agent: said once, as a quiet pill. */
    experimental: boolean;
    /** The Account view cannot confirm this source: it needs a computer, stated once in the header. */
    needsComputer: boolean;
    /** A source that cannot be used says why, once in its header. */
    errorTitleKey: TranslationKeyNoParams | null;
}>;

/**
 * Presents the facts that hold for a whole source rather than one of its rows. An Account
 * projection marks every source unavailable and every row unconfirmed because it has no
 * computer to ask; that is "needs a computer", not a broken machine.
 */
export function presentProviderSourceStatus(group: Readonly<{
    authorization?: DaemonProviderModelProjectionGroupV1['authorization'];
    modelLoadAction: DaemonProviderModelProjectionGroupV1['modelLoadAction'];
    rows: readonly Readonly<{ compatibility?: ProviderModelProjectionCompatibility }>[];
}>): ProviderSourceStatusPresentation {
    const error = group.authorization?.authorized === false ? group.authorization.error : null;
    const needsComputer = error !== null
        && error.code === 'provider_machine_unavailable'
        && group.modelLoadAction === 'machine_required';
    return {
        experimental: group.rows.some(row => row.compatibility?.result.status === 'experimental'),
        needsComputer,
        errorTitleKey: error && !needsComputer ? presentProviderError(error).titleKey : null,
    };
}
