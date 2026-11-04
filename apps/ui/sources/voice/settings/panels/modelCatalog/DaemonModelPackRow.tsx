import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { resolveCanonicalModelPackId } from '@happier-dev/protocol/voice/modelPacks/catalog';
import type { ModelPackKind } from '@happier-dev/protocol/voice/modelPacks/manifest';

import type { ModelCatalogRow } from './buildModelCatalogRows';
import { buildModelCatalogRows } from './buildModelCatalogRows';
import { formatModelCatalogRowDetail } from './formatModelCatalogRowDetail';
import { useDaemonVoiceModelCatalogController } from './DaemonVoiceModelCatalogContext';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import type { SettingRef } from '@/components/settings/catalog/settingDeclarations';

const REMOVE_TARGET_SIZE = resolveMinimumInteractiveTargetSize(Platform.OS);

export function DaemonModelPackRow(props: Readonly<{
    row: ModelCatalogRow;
    actionInFlight: boolean;
    /** The catalog has one mutation owner, so every competing row is inert. */
    actionsDisabled?: boolean;
    onSetDefault: (packId: string) => Promise<void> | void;
    onInstall: (packId: string) => void;
    onRemove: (packId: string) => Promise<void> | void;
    onCancel?: () => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const { row } = props;
    const canPromoteToDefault = row.canSetDefault && !row.isDefault;
    const isUnsupported = row.state === 'unsupported';
    const showRemove = row.canRemove;
    const installed = row.state === 'installed' || row.state === 'ready' || row.state === 'warming' || row.state === 'evicted';
    const isDiscard = row.state === 'error';
    const actionLabel = isDiscard ? t('common.discard') : t('common.remove');

    const installLabel = row.state === 'error' ? t('common.retry')
        : installed ? t('common.update') : t('settingsVoice.local.models.download');

    const install = (event?: { stopPropagation?: () => void }) => {
        event?.stopPropagation?.();
        if (props.actionsDisabled || props.actionInFlight) return;
        props.onInstall(row.packId);
    };
    const removeButton = showRemove ? (
        <IconButton
            testID={`voice-model-remove-${row.packId}`}
            accessibilityLabel={`${actionLabel}: ${row.displayName}`}
            disabled={props.actionsDisabled === true}
            variant="plain"
            minimumInteractiveTargetSize={REMOVE_TARGET_SIZE}
            onPress={(event) => {
                event?.stopPropagation?.();
                if (props.actionsDisabled || props.actionInFlight) return;
                fireAndForget(Promise.resolve(props.onRemove(row.packId)), { tag: 'DaemonModelPackRow.remove' });
            }}
            icon={<Icon name="trash" size={20} color={theme.colors.text.secondary} />}
        />
    ) : null;
    // The existing installer also refreshes an installed pack's manifest.
    const installButton = row.canInstall ? (
        <RoundButton
            testID={`voice-model-install-${row.packId}`}
            size="small"
            display="secondary"
            title={installLabel}
            accessibilityLabel={`${installLabel}: ${row.displayName}`}
            disabled={props.actionsDisabled === true}
            onPress={install}
        />
    ) : null;


    const rightElement = props.actionInFlight && props.onCancel ? (
        <IconButton
            testID={`voice-model-cancel-${row.packId}`}
            accessibilityLabel={`${t('common.cancel')}: ${row.displayName}`}
            variant="plain"
            minimumInteractiveTargetSize={REMOVE_TARGET_SIZE}
            onPress={(event) => {
                event?.stopPropagation?.();
                props.onCancel?.();
            }}
            icon={<Icon name="x" size={20} color={theme.colors.text.secondary} />}
        />
    ) : installButton || removeButton ? (
        <View style={styles.actions}>{installButton}{removeButton}</View>
    ) : row.isDefault ? (
        <Icon name="check-circle" size={20} color={theme.colors.text.link} accessibilityLabel={t('settingsVoice.local.models.defaultBadge')} />
    ) : undefined;

    const isUnknown = row.state === 'unknown';
    const onPress = isUnknown || isUnsupported || props.actionsDisabled ? undefined : () => {
        if (props.actionInFlight) return;
        if (row.canInstall && !installed) props.onInstall(row.packId);
        else if (canPromoteToDefault) {
            const pending = props.onSetDefault(row.packId);
            if (pending) fireAndForget(pending, { tag: 'DaemonModelPackRow.default' });
            return pending;
        }
    };

    return (
        <Item
            testID={`voice-model-row-${row.packId}`}
            title={row.displayName}
            // An unknown status is already the row's value; the description stays empty rather than repeat it.
            subtitle={isUnknown
                ? undefined
                : row.isDefault
                    ? t('settingsVoice.local.models.defaultSubtitle')
                    : row.canInstall && !installed
                        ? t('settingsVoice.local.models.installSubtitle')
                        : canPromoteToDefault
                            ? t('settingsVoice.local.models.setDefaultSubtitle')
                            : undefined}
            detail={formatModelCatalogRowDetail(row)}
            rightElement={isUnknown ? undefined : rightElement}
            rightElementOutsidePressable={showRemove || row.canInstall || props.actionInFlight}
            onPress={onPress}
            disabled={props.actionsDisabled === true}
            loading={props.actionInFlight}
            selected={row.isDefault}
            showChevron={false}
            destructive={row.state === 'error'}
            accessibilityLabel={`${row.displayName}. ${formatModelCatalogRowDetail(row)}`}
        />
    );
}

const styles = StyleSheet.create((theme) => ({
    actions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
}));

export function SelectedDaemonModelPackRow(props: Readonly<{
    packId: string | null;
    kind: ModelPackKind;
    setting?: SettingRef;
}>): React.ReactElement | null {
    const controller = useDaemonVoiceModelCatalogController();
    if (!controller || !props.packId) return null;
    const canonicalPackId = resolveCanonicalModelPackId(props.packId);
    const groups = buildModelCatalogRows({
        statuses: controller.state.statuses,
        statusUnavailable: controller.state.errorCode !== null,
        actionError: controller.state.actionError,
        selectedSttPackId: props.kind === 'stt_sherpa' ? canonicalPackId : null,
        selectedTtsPackId: props.kind === 'tts_sherpa' ? canonicalPackId : null,
    });
    const rows = props.kind === 'stt_sherpa' ? groups.stt : groups.tts;
    const row = rows.find((candidate) => candidate.packId === canonicalPackId);
    if (!row) return null;
    const item = (
        <DaemonModelPackRow
            row={row}
            actionInFlight={controller.state.actionPackId === row.packId}
            actionsDisabled={controller.state.actionPackId !== null}
            onSetDefault={() => undefined}
            onInstall={controller.install}
            onRemove={controller.remove}
            onCancel={controller.cancel}
        />
    );
    return props.setting ? <SettingAnchor setting={props.setting}>{item}</SettingAnchor> : item;
}
