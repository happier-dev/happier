import * as React from 'react';

import type { ModelPackKind } from '@happier-dev/protocol/voice/modelPacks/manifest';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
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
    'listModels' | 'getModelsStatus'
>;

export type DaemonVoiceModelCatalogController = ReturnType<typeof useDaemonVoiceModelCatalogState>;

type CatalogStateLine = Readonly<{
    kind: 'loading' | 'unavailable' | 'error';
    title: string;
    retryable: boolean;
}>;

/**
 * What the section says while no model's state is known: one line naming the cause, in the person's
 * words, with a retry only when trying again can help. `loading` is the initial check (the hook keeps
 * last-known rows during a refresh), so a refresh never flashes this line over listed models.
 */
function resolveCatalogStateLine(
    loading: boolean,
    errorCode: DaemonVoiceModelCatalogErrorCode,
): CatalogStateLine | null {
    if (errorCode === null) {
        return loading
            ? { kind: 'loading', title: t('settingsVoice.pages.advanced.speechModelsChecking'), retryable: false }
            : null;
    }
    switch (errorCode) {
        case 'feature_disabled':
            return { kind: 'unavailable', title: t('settingsVoice.pages.advanced.speechModelsOff'), retryable: false };
        case 'machine_unreachable':
            return { kind: 'error', title: t('settingsVoice.pages.advanced.speechModelsUnreachable'), retryable: true };
        case 'unsupported_runtime_family':
            return { kind: 'unavailable', title: t('settingsVoice.pages.advanced.speechModelsUnsupported'), retryable: false };
        case 'request_timeout':
            return { kind: 'error', title: t('settingsVoice.pages.advanced.speechModelsTimeout'), retryable: true };
        default:
            return { kind: 'error', title: t('settingsVoice.pages.advanced.speechModelsFailed'), retryable: true };
    }
}

function ModelCatalogGroup(props: Readonly<{
    title: string;
    description?: string;
    rows: readonly ModelCatalogRow[];
    actionPackId: string | null;
    onSetDefault: (packId: string) => Promise<void> | void;
    onInstall: (packId: string) => void;
    onRemove: (packId: string) => Promise<void> | void;
    onCancel: () => void;
}>): React.ReactElement {
    return (
        <ItemGroup title={props.title} description={props.description}>
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
 * The parent admits default selection through its Settings Action. The operation
 * persists the canonical per-kind local-neural `assetId`, observed here through
 * `selectedSttPackId` / `selectedTtsPackId`.
 */
export function DaemonVoiceModelCatalogSection(props: Readonly<{
    selectedSttPackId: string | null;
    selectedTtsPackId: string | null;
    onSelectDefault: (kind: ModelPackKind, packId: string) => Promise<void> | void;
    client?: ModelCatalogClient;
    catalogController?: DaemonVoiceModelCatalogController;
}>): React.ReactElement {
    const ownedCatalog = useDaemonVoiceModelCatalogState({
        client: props.client,
        enabled: !props.catalogController,
    });
    const { state, refresh, install, remove, cancel } = props.catalogController ?? ownedCatalog;

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
        fireAndForget(install(packId), { tag: 'DaemonVoiceModelCatalogSection.install' });
    }, [install]);

    const handleRemove = React.useCallback((packId: string) => remove(packId), [remove]);

    // While the catalog's state is unknown, no model can be installed or removed, so none is listed:
    // the section says once why, instead of an unknown state on every model.
    const stateLine = resolveCatalogStateLine(state.loading, state.errorCode);
    if (stateLine) {
        return (
            <ItemGroup
                title={t('settingsVoice.pages.advanced.speechModelsTitle')}
                description={t('settingsVoice.local.models.footer')}
            >
                <SurfaceStateCard
                    testID="voice-model-catalog-status"
                    size="line"
                    kind={stateLine.kind}
                    title={stateLine.title}
                    detail={state.message}
                    action={stateLine.retryable
                        ? { label: t('common.retry'), onPress: handleRetryStatus, testID: 'voice-model-catalog-retry' }
                        : undefined}
                />
            </ItemGroup>
        );
    }

    return (
        <>
            <ModelCatalogGroup
                title={t('settingsVoice.local.models.sttGroupTitle')}
                description={t('settingsVoice.local.models.footer')}
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
