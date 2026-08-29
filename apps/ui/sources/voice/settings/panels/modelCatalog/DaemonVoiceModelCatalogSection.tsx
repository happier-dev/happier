import * as React from 'react';

import type { ModelPackKind } from '@happier-dev/protocol';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { DaemonVoiceInferenceClient } from '@/voice/runtime/daemonInference/DaemonVoiceInferenceClient';

import type { ModelCatalogRow } from './buildModelCatalogRows';
import { buildModelCatalogRows } from './buildModelCatalogRows';
import { DaemonModelPackRow } from './DaemonModelPackRow';
import type { DaemonVoiceModelCatalogErrorCode } from './useDaemonVoiceModelCatalogState';
import { useDaemonVoiceModelCatalogState } from './useDaemonVoiceModelCatalogState';

type ModelCatalogClient = Pick<
    DaemonVoiceInferenceClient,
    'listModels' | 'getModelsStatus' | 'installModel' | 'acceptModelPackLicense' | 'removeModel'
>;

export type DaemonVoiceModelCatalogController = ReturnType<typeof useDaemonVoiceModelCatalogState>;

/**
 * Service-level status copy for the catalog. Reuses the canonical daemon
 * inference state strings so the model manager and the single-pack section read
 * the same error language. `loading` wins over a stale error so a refresh does
 * not flash the previous failure.
 */
function resolveCatalogStatusDetail(
    loading: boolean,
    errorCode: DaemonVoiceModelCatalogErrorCode,
): string {
    if (loading) {
        return t('settingsVoice.local.daemonInference.states.loading');
    }
    switch (errorCode) {
        case 'machine_unreachable':
            return t('settingsVoice.local.daemonInference.states.machineUnreachable');
        case 'feature_disabled':
            return t('settingsVoice.local.daemonInference.states.unavailable');
        case 'runtime_unavailable':
        case 'unsupported_runtime_family':
            return t('settingsVoice.local.daemonInference.states.runtimeUnavailable');
        case 'request_timeout':
            return t('settingsVoice.local.daemonInference.states.requestTimeout');
        case 'internal_error':
            return t('settingsVoice.local.daemonInference.states.unavailable');
        default:
            return t('settingsVoice.local.daemonInference.states.ready');
    }
}

function ModelCatalogGroup(props: Readonly<{
    title: string;
    footer?: string;
    rows: readonly ModelCatalogRow[];
    actionPackId: string | null;
    onSetDefault: (packId: string) => void;
    onInstall: (packId: string) => void;
    onRemove: (packId: string) => Promise<void> | void;
    onCancel: () => void;
}>): React.ReactElement {
    return (
        <ItemGroup title={props.title} footer={props.footer}>
            {props.rows.map((row) => (
                <DaemonModelPackRow
                    key={row.packId}
                    row={row}
                    actionInFlight={props.actionPackId === row.packId}
                    actionsDisabled={props.actionPackId !== null}
                    onSetDefault={props.onSetDefault}
                    onInstall={props.onInstall}
                    onRemove={props.onRemove}
                    onCancel={props.onCancel}
                />
            ))}
        </ItemGroup>
    );
}

/**
 * Local voice models management surface. Lists every catalog model pack grouped
 * by kind (STT / TTS) with its derived install + readiness state, an install /
 * remove action, and per-kind default selection. State is consumed entirely
 * through the canonical catalog + daemon readiness hooks — no provider-name
 * branching; grouping and defaults come from the protocol catalog.
 *
 * Default selection is persisted by the parent through the canonical per-kind
 * default field (`stt`/`tts` local-neural `assetId`), supplied via
 * `selectedSttPackId` / `selectedTtsPackId` and written back via
 * `onSelectDefault`.
 */
export function DaemonVoiceModelCatalogSection(props: Readonly<{
    selectedSttPackId: string | null;
    selectedTtsPackId: string | null;
    onSelectDefault: (kind: ModelPackKind, packId: string) => void;
    client?: ModelCatalogClient;
    catalogController?: DaemonVoiceModelCatalogController;
}>): React.ReactElement {
    const ownedCatalog = useDaemonVoiceModelCatalogState({
        client: props.client,
        enabled: !props.catalogController,
    });
    const { state, refresh, install, acceptLicense, remove, cancel } = props.catalogController ?? ownedCatalog;

    // The daemon health is unknown whenever the status request failed. Forces
    // every row uninstallable so an install/remove can never fire against an
    // unreachable/unhealthy daemon.
    const statusUnavailable = state.errorCode !== null;

    const groups = React.useMemo(
        () => buildModelCatalogRows({
            statuses: state.statuses,
            statusUnavailable,
            actionError: state.actionError,
            selectedSttPackId: props.selectedSttPackId,
            selectedTtsPackId: props.selectedTtsPackId,
        }),
        [props.selectedSttPackId, props.selectedTtsPackId, state.actionError, state.statuses, statusUnavailable],
    );

    const handleRetryStatus = React.useCallback(() => {
        fireAndForget(refresh(), { tag: 'DaemonVoiceModelCatalogSection.retryStatus' });
    }, [refresh]);

    const handleInstall = React.useCallback((packId: string) => {
        const review = state.statuses.find((status) => status.packId === packId)?.licenseReview;
        fireAndForget(install(packId, review && !review.accepted ? async (isCurrent) => {
            const accepted = await Modal.confirm(
                review.licenseTitle,
                review.licenseText,
                { confirmText: t('common.continue') },
            );
            if (!accepted || !isCurrent()) return false;
            await acceptLicense(review);
            return isCurrent();
        } : undefined), { tag: 'DaemonVoiceModelCatalogSection.install' });
    }, [acceptLicense, install, state.statuses]);

    const handleRemove = React.useCallback((packId: string) => remove(packId), [remove]);

    const showStatusRow = state.loading || statusUnavailable;

    return (
        <>
            {showStatusRow ? (
                <ItemGroup>
                    <Item
                        testID="voice-model-catalog-status"
                        title={t('settingsVoice.local.models.statusTitle')}
                        detail={resolveCatalogStatusDetail(state.loading, state.errorCode)}
                        loading={state.loading}
                        destructive={statusUnavailable}
                        onPress={statusUnavailable ? handleRetryStatus : undefined}
                        showChevron={false}
                        selected={false}
                    />
                </ItemGroup>
            ) : null}

            <ModelCatalogGroup
                title={t('settingsVoice.local.models.sttGroupTitle')}
                footer={t('settingsVoice.local.models.footer')}
                rows={groups.stt}
                actionPackId={state.actionPackId}
                onSetDefault={(packId) => props.onSelectDefault('stt_sherpa', packId)}
                onInstall={handleInstall}
                onRemove={handleRemove}
                onCancel={cancel}
            />
            <ModelCatalogGroup
                title={t('settingsVoice.local.models.ttsGroupTitle')}
                rows={groups.tts}
                actionPackId={state.actionPackId}
                onSetDefault={(packId) => props.onSelectDefault('tts_sherpa', packId)}
                onInstall={handleInstall}
                onRemove={handleRemove}
                onCancel={cancel}
            />
        </>
    );
}
