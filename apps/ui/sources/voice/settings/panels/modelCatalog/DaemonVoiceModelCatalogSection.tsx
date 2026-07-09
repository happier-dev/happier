import * as React from 'react';

import { Ionicons } from '@expo/vector-icons';
import { Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type { ModelPackKind } from '@happier-dev/protocol';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { DaemonVoiceInferenceClient } from '@/voice/runtime/daemonInference/DaemonVoiceInferenceClient';

import type { ModelCatalogRow } from './buildModelCatalogRows';
import { buildModelCatalogRows } from './buildModelCatalogRows';
import { formatModelCatalogRowDetail } from './formatModelCatalogRowDetail';
import type { DaemonVoiceModelCatalogErrorCode } from './useDaemonVoiceModelCatalogState';
import { useDaemonVoiceModelCatalogState } from './useDaemonVoiceModelCatalogState';

type ModelCatalogClient = Pick<
    DaemonVoiceInferenceClient,
    'getModelsStatus' | 'installModel' | 'removeModel'
>;

export type DaemonVoiceModelCatalogController = ReturnType<typeof useDaemonVoiceModelCatalogState>;

const REMOVE_BUTTON_STYLE = {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
} as const;

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
            return t('settingsVoice.local.daemonInference.states.runtimeUnavailable');
        case 'request_timeout':
            return t('settingsVoice.local.daemonInference.states.requestTimeout');
        case 'internal_error':
            return t('settingsVoice.local.daemonInference.states.unavailable');
        default:
            return t('settingsVoice.local.daemonInference.states.ready');
    }
}

function ModelCatalogRowItem(props: Readonly<{
    row: ModelCatalogRow;
    actionInFlight: boolean;
    onSetDefault: (packId: string) => void;
    onInstall: (packId: string) => void;
    onRemove: (row: ModelCatalogRow) => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const { row } = props;
    const canPromoteToDefault = row.canRemove && !row.isDefault;

    const rightElement = row.isDefault ? (
        <Ionicons
            name="checkmark-circle"
            size={22}
            color={theme.colors.text.link}
            accessibilityLabel={t('settingsVoice.local.models.defaultBadge')}
        />
    ) : row.canRemove ? (
        <Pressable
            testID={`voice-model-remove-${row.packId}`}
            accessibilityRole="button"
            accessibilityLabel={t('common.remove')}
            hitSlop={4}
            style={REMOVE_BUTTON_STYLE}
            onPress={(event: any) => {
                event?.stopPropagation?.();
                if (props.actionInFlight) {
                    return;
                }
                props.onRemove(row);
            }}
        >
            <Ionicons
                name="trash-outline"
                size={20}
                color={theme.colors.text.secondary}
            />
        </Pressable>
    ) : row.canInstall ? (
        <Ionicons
            name="download-outline"
            size={20}
            color={theme.colors.text.secondary}
        />
    ) : undefined;

    // When the daemon status is unknown the row carries no actionable state:
    // no install (would fire against an unreachable/unhealthy daemon), no remove,
    // no default promotion. Leave it inert until status is known.
    const isUnknown = row.state === 'unknown';

    // Primary tap: install/retry when not ready; installed rows promote to
    // default. Removal is a separate right-side button so a row tap never
    // deletes an installed model by surprise.
    const onPress = isUnknown ? undefined : () => {
        if (props.actionInFlight) {
            return;
        }
        if (row.canInstall) {
            props.onInstall(row.packId);
            return;
        }
        if (canPromoteToDefault) {
            props.onSetDefault(row.packId);
            return;
        }
    };

    return (
        <Item
            testID={`voice-model-row-${row.packId}`}
            title={row.displayName}
            subtitle={isUnknown
                ? t('settingsVoice.local.models.unknownSubtitle')
                : row.isDefault
                    ? t('settingsVoice.local.models.defaultSubtitle')
                    : row.canInstall
                        ? t('settingsVoice.local.models.installSubtitle')
                        : canPromoteToDefault
                            ? t('settingsVoice.local.models.setDefaultSubtitle')
                            : undefined}
            detail={formatModelCatalogRowDetail(row)}
            rightElement={isUnknown ? undefined : rightElement}
            onPress={onPress}
            loading={props.actionInFlight}
            selected={row.isDefault}
            showChevron={false}
            destructive={row.state === 'error'}
            accessibilityLabel={`${row.displayName}. ${formatModelCatalogRowDetail(row)}`}
        />
    );
}

function ModelCatalogGroup(props: Readonly<{
    title: string;
    footer?: string;
    rows: readonly ModelCatalogRow[];
    actionPackId: string | null;
    onSetDefault: (packId: string) => void;
    onInstall: (packId: string) => void;
    onRemove: (row: ModelCatalogRow) => void;
}>): React.ReactElement {
    return (
        <ItemGroup title={props.title} footer={props.footer}>
            {props.rows.map((row) => (
                <ModelCatalogRowItem
                    key={row.packId}
                    row={row}
                    actionInFlight={props.actionPackId === row.packId}
                    onSetDefault={props.onSetDefault}
                    onInstall={props.onInstall}
                    onRemove={props.onRemove}
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
    const { state, refresh, install, remove } = props.catalogController ?? ownedCatalog;

    // The daemon health is unknown whenever the status request failed. Forces
    // every row uninstallable so an install/remove can never fire against an
    // unreachable/unhealthy daemon.
    const statusUnavailable = state.errorCode !== null;

    const groups = React.useMemo(
        () => buildModelCatalogRows({
            statuses: state.statuses,
            statusUnavailable,
            selectedSttPackId: props.selectedSttPackId,
            selectedTtsPackId: props.selectedTtsPackId,
        }),
        [props.selectedSttPackId, props.selectedTtsPackId, state.statuses, statusUnavailable],
    );

    const handleRetryStatus = React.useCallback(() => {
        fireAndForget(refresh(), { tag: 'DaemonVoiceModelCatalogSection.retryStatus' });
    }, [refresh]);

    const handleInstall = React.useCallback((packId: string) => {
        fireAndForget(install(packId), { tag: 'DaemonVoiceModelCatalogSection.install' });
    }, [install]);

    const handleRemove = React.useCallback((row: ModelCatalogRow) => {
        fireAndForget((async () => {
            const confirmed = await Modal.confirm(
                t('settingsVoice.local.models.removeConfirmTitle'),
                t('settingsVoice.local.models.removeConfirmBody', { name: row.displayName }),
                { confirmText: t('common.remove'), destructive: true },
            );
            if (!confirmed) {
                return;
            }
            await remove(row.packId);
        })(), { tag: 'DaemonVoiceModelCatalogSection.remove' });
    }, [remove]);

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
            />
            <ModelCatalogGroup
                title={t('settingsVoice.local.models.ttsGroupTitle')}
                rows={groups.tts}
                actionPackId={state.actionPackId}
                onSetDefault={(packId) => props.onSelectDefault('tts_sherpa', packId)}
                onInstall={handleInstall}
                onRemove={handleRemove}
            />
        </>
    );
}
