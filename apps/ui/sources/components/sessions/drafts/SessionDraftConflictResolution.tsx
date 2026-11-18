import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { SessionDraftAddressV2} from '@happier-dev/protocol/drafts/sessionDraftsV2';
import type { JsonValue  as StrictJsonValue} from '@happier-dev/protocol/json/strictJsonValue';

import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    resolveSessionDraftConflict,
    type SessionDraftConflict,
    type SessionDraftConflictField,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';
import { WarningActionBanner } from '@/components/sessions/shell/view/WarningActionBanner';
import { Icon } from '@/components/ui/icons/Icon';
import type { AgentInputStatusBadge } from '@/components/sessions/agentInput/agentInputContracts';
import { useComposerBannerCollapse } from '@/components/sessions/composerBanners/ComposerBannerCollapseProvider';
import { buildCollapsedComposerBannerBadge, buildComposerBannerHideAction } from '@/components/sessions/composerBanners/composerBannerCollapse';

const stylesheet = StyleSheet.create((theme) => ({
    container: { gap: theme.space.s8 },
    comparison: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s8, marginTop: theme.space.s8 },
    value: { flexBasis: 180, flexGrow: 1, gap: 3 },
    valueLabel: { color: theme.colors.state.warning.textForeground, ...Typography.default('semiBold') },
    valueText: { color: theme.colors.text.primary },
}));

function presentConflictValue(value: StrictJsonValue | null): string {
    if (typeof value === 'string') return value;
    if (value === null) return '';
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

export function useSessionDraftConflictComposerBanner(conflict: SessionDraftConflict | null): Readonly<{
    collapsed: boolean;
    statusBadge: AgentInputStatusBadge | null;
    /** The expanded conflict's own Hide; the same toggle the collapsed badge uses to bring it back. */
    hide: () => void;
}> {
    const collapse = useComposerBannerCollapse('draftConflict', { persistence: 'ephemeral' });
    const signature = React.useMemo(() => conflict ? JSON.stringify(conflict.fields) : null, [conflict]);
    const previousSignatureRef = React.useRef(signature);

    React.useEffect(() => {
        if (previousSignatureRef.current === signature) return;
        previousSignatureRef.current = signature;
        if (collapse.collapsed) collapse.toggle();
    }, [collapse, signature]);

    const statusBadge = React.useMemo<AgentInputStatusBadge | null>(() => conflict ? buildCollapsedComposerBannerBadge({
        collapsed: collapse.collapsed,
        statusLabel: t('sessionDrafts.conflict.title'),
        expandHint: t('session.composerBanners.showBannerAction'),
        badge: {
            key: 'draft-conflict',
            label: t('sessionDrafts.conflict.title'),
            testID: 'session-draft-conflict-status-badge',
            tone: 'warning',
            emphasis: 'prominent',
            icon: (tint: string) => <Icon name="warning" size={14} color={tint} />,
            onPress: collapse.toggle,
        },
    }) : null, [collapse.collapsed, collapse.toggle, conflict]);

    return { collapsed: collapse.collapsed, statusBadge, hide: collapse.toggle };
}

const SessionDraftConflictFieldView = React.memo(function SessionDraftConflictFieldView(props: Readonly<{
    scope: ServerAccountScope;
    address: SessionDraftAddressV2;
    field: SessionDraftConflictField;
    onHide?: () => void;
}>) {
    const [pendingAction, setPendingAction] = React.useState<'useSynced' | 'keepDevice' | null>(null);
    const [copied, setCopied] = React.useState(false);
    const mine = presentConflictValue(props.field.mine);
    const writeClipboard = useClipboardWrite(props.scope);
    const synced = presentConflictValue(props.field.synced);

    const resolve = React.useCallback(async (action: 'useSynced' | 'keepDevice') => {
        if (pendingAction) return;
        setPendingAction(action);
        try {
            await resolveSessionDraftConflict({
                scope: props.scope,
                address: props.address,
                fieldId: props.field.fieldId,
                action,
            });
        } catch {
            Modal.alert(t('common.error'), t('errors.unknownError'));
        } finally {
            setPendingAction(null);
        }
    }, [pendingAction, props.address, props.field.fieldId, props.scope]);

    const copyMine = React.useCallback(async () => {
        const didCopy = await writeClipboard(mine);
        setCopied(didCopy);
        if (!didCopy) Modal.alert(t('common.error'), t('sessionDrafts.conflict.copyFailed'));
    }, [mine, writeClipboard]);

    return (
        <WarningActionBanner
            testID={`session-draft-conflict:${props.field.fieldId}`}
            title={t('sessionDrafts.conflict.title')}
            body={t('sessionDrafts.conflict.description')}
            actionsPlacement="title"
            content={(
                <View style={stylesheet.comparison}>
                    <View style={stylesheet.value}>
                        <Text style={stylesheet.valueLabel}>{t('sessionDrafts.conflict.mine')}</Text>
                        <Text style={stylesheet.valueText} numberOfLines={4}>{mine}</Text>
                    </View>
                    <View style={stylesheet.value}>
                        <Text style={stylesheet.valueLabel}>{t('sessionDrafts.conflict.synced')}</Text>
                        <Text style={stylesheet.valueText} numberOfLines={4}>{synced}</Text>
                    </View>
                </View>
            )}
            actionTestID={`session-draft-conflict-action:${props.field.fieldId}:use-synced`}
            actionLabel={t('sessionDrafts.conflict.useSynced')}
            actionAccessibilityLabel={t('sessionDrafts.conflict.useSynced')}
            actionBusy={pendingAction === 'useSynced'}
            disabled={pendingAction !== null}
            onActionPress={() => resolve('useSynced')}
            secondaryActions={[...(props.onHide ? [buildComposerBannerHideAction({
                bannerTestID: `session-draft-conflict:${props.field.fieldId}`,
                accessibilityLabel: t('session.composerBanners.hideBannerAction'),
                onPress: props.onHide,
            })] : []), {
                key: 'keep-device',
                testID: `session-draft-conflict-action:${props.field.fieldId}:keep-device`,
                label: t('sessionDrafts.conflict.keepDevice'),
                accessibilityLabel: t('sessionDrafts.conflict.keepDevice'),
                disabled: pendingAction !== null,
                onPress: () => resolve('keepDevice'),
            }, {
                key: 'copy-mine',
                testID: `session-draft-conflict-action:${props.field.fieldId}:copy-mine`,
                label: copied ? t('sessionDrafts.conflict.copied') : t('sessionDrafts.conflict.copyMine'),
                accessibilityLabel: t('sessionDrafts.conflict.copyMine'),
                variant: 'quiet',
                onPress: copyMine,
            }]}
        />
    );
});

export function SessionDraftConflictResolution(props: Readonly<{
    scope: ServerAccountScope;
    address: SessionDraftAddressV2;
    conflict: SessionDraftConflict;
    /** Present where the conflict is a collapsible composer banner; its collapsed badge brings it back. */
    onHide?: () => void;
}>): React.ReactNode {
    if (props.conflict.fields.length === 0) return null;
    return (
        <View style={stylesheet.container}>
            {props.conflict.fields.map((field) => (
                <SessionDraftConflictFieldView key={field.fieldId} scope={props.scope} address={props.address} field={field} onHide={props.onHide} />
            ))}
        </View>
    );
}
