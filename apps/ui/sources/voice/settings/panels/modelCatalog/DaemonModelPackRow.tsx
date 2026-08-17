import * as React from 'react';
import { Platform, Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { Modal } from '@/modal';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { resolveCanonicalModelPackId, type ModelPackKind } from '@happier-dev/protocol';

import type { ModelCatalogRow } from './buildModelCatalogRows';
import { buildModelCatalogRows } from './buildModelCatalogRows';
import { formatModelCatalogRowDetail } from './formatModelCatalogRowDetail';
import { useDaemonVoiceModelCatalogController } from './DaemonVoiceModelCatalogContext';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';

const REMOVE_TARGET_SIZE = resolveMinimumInteractiveTargetSize(Platform.OS);
const REMOVE_BUTTON_STYLE = {
    width: REMOVE_TARGET_SIZE,
    height: REMOVE_TARGET_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
} as const;

export function DaemonModelPackRow(props: Readonly<{
    row: ModelCatalogRow;
    actionInFlight: boolean;
    onSetDefault: (packId: string) => void;
    onInstall: (packId: string) => void;
    onRemove: (packId: string) => Promise<void> | void;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const { row } = props;
    const canPromoteToDefault = row.canRemove && !row.isDefault;
    const isUnsupported = row.state === 'unsupported';
    const showRemove = row.canRemove;

    const rightElement = showRemove ? (
        <Pressable
            testID={`voice-model-remove-${row.packId}`}
            accessibilityRole="button"
            accessibilityLabel={`${t('common.remove')}: ${row.displayName}`}
            style={REMOVE_BUTTON_STYLE}
            onPress={(event: any) => {
                event?.stopPropagation?.();
                if (props.actionInFlight) return;
                fireAndForget((async () => {
                    const confirmed = await Modal.confirm(
                        t('settingsVoice.local.models.removeConfirmTitle'),
                        t('settingsVoice.local.models.removeConfirmBody', { name: row.displayName }),
                        { confirmText: t('common.remove'), destructive: true },
                    );
                    if (confirmed) await props.onRemove(row.packId);
                })(), { tag: 'DaemonModelPackRow.remove' });
            }}
        >
            <Icon name="trash" size={20} color={theme.colors.text.secondary} />
        </Pressable>
    ) : row.isDefault ? (
        <Icon name="check-circle" size={20} color={theme.colors.text.link} accessibilityLabel={t('settingsVoice.local.models.defaultBadge')} />
    ) : row.canInstall ? (
        <Icon name="download" size={20} color={theme.colors.text.secondary} />
    ) : undefined;

    const isUnknown = row.state === 'unknown';
    const onPress = isUnknown || isUnsupported ? undefined : () => {
        if (props.actionInFlight) return;
        if (row.canInstall) props.onInstall(row.packId);
        else if (canPromoteToDefault) props.onSetDefault(row.packId);
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
            rightElementOutsidePressable={showRemove}
            onPress={onPress}
            loading={props.actionInFlight}
            selected={row.isDefault}
            showChevron={false}
            destructive={row.state === 'error'}
            accessibilityLabel={`${row.displayName}. ${formatModelCatalogRowDetail(row)}`}
        />
    );
}

export function SelectedDaemonModelPackRow(props: Readonly<{
    packId: string | null;
    kind: ModelPackKind;
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
    return (
        <DaemonModelPackRow
            row={row}
            actionInFlight={controller.state.actionPackId === row.packId}
            onSetDefault={() => undefined}
            onInstall={controller.install}
            onRemove={controller.remove}
        />
    );
}
