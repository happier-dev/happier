import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { SessionDraftAddressV1, StrictJsonValue } from '@happier-dev/protocol';

import { Text } from '@/components/ui/text/Text';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    resolveSessionDraftConflict,
    type SessionDraftConflict,
    type SessionDraftConflictField,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { t } from '@/text';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { Modal } from '@/modal';
import { Typography } from '@/constants/Typography';
import { SessionWarningActionBanner } from '@/components/sessions/shell/SessionWarningActionBanner';
import { Icon } from '@/components/ui/icons/Icon';
import type { AgentInputStatusBadge } from '@/components/sessions/agentInput/agentInputContracts';
import { useComposerBannerCollapse } from '@/components/sessions/composerBanners/ComposerBannerCollapseProvider';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        gap: 8,
    },
    comparison: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        marginTop: 8,
    },
    value: {
        flexBasis: 180,
        flexGrow: 1,
        gap: 3,
    },
    valueLabel: {
        color: theme.colors.state.warning.onTint,
        ...Typography.default('semiBold'),
    },
    valueText: {
        color: theme.colors.text.primary,
    },
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

function resolveFieldLabel(field: SessionDraftConflictField): string {
    switch (field.fieldId) {
        case 'composer.text': return t('sessionDrafts.conflict.field.text');
        case 'composer.mentions': return t('sessionDrafts.conflict.field.mentions');
        case 'composer.attachments': return t('sessionDrafts.conflict.field.attachments');
        case 'target.routing.recipient': return t('sessionDrafts.conflict.field.recipient');
        case 'target.routing.agentContinuation': return t('sessionDrafts.conflict.field.agentContinuation');
        case 'target.routing.executionRunDelivery': return t('sessionDrafts.conflict.field.executionRunDelivery');
        default: return field.fieldId;
    }
}

export function useSessionDraftConflictComposerBanner(conflict: SessionDraftConflict | null): Readonly<{
    collapsed: boolean;
    statusBadge: AgentInputStatusBadge | null;
}> {
    const collapse = useComposerBannerCollapse('draftConflict', { persistence: 'ephemeral' });
    const signature = React.useMemo(() => conflict ? JSON.stringify(conflict.fields) : null, [conflict]);
    const previousSignatureRef = React.useRef(signature);

    React.useEffect(() => {
        if (previousSignatureRef.current === signature) return;
        previousSignatureRef.current = signature;
        if (collapse.collapsed) collapse.toggle();
    }, [collapse, signature]);

    const statusBadge = React.useMemo<AgentInputStatusBadge | null>(() => conflict ? ({
        key: 'draft-conflict',
        label: t('sessionDrafts.conflict.title'),
        testID: 'session-draft-conflict-status-badge',
        accessibilityLabel: t('sessionDrafts.conflict.title'),
        accessibilityState: { expanded: !collapse.collapsed },
        tone: 'warning',
        emphasis: 'prominent',
        icon: (tint: string) => <Icon name="warning" size={14} color={tint} />,
        onPress: collapse.toggle,
    }) : null, [collapse.collapsed, collapse.toggle, conflict]);

    return { collapsed: collapse.collapsed, statusBadge };
}

const SessionDraftConflictFieldView = React.memo(function SessionDraftConflictFieldView(props: Readonly<{
    scope: ServerAccountScope;
    address: SessionDraftAddressV1;
    field: SessionDraftConflictField;
}>) {
    const styles = stylesheet;
    const [pendingAction, setPendingAction] = React.useState<'useSynced' | 'keepDevice' | null>(null);
    const [copied, setCopied] = React.useState(false);
    const fieldId = props.field.fieldId;
    const mine = presentConflictValue(props.field.mine);
    const synced = presentConflictValue(props.field.synced);

    const resolve = React.useCallback(async (action: 'useSynced' | 'keepDevice') => {
        if (pendingAction) return;
        setPendingAction(action);
        try {
            await resolveSessionDraftConflict({
                scope: props.scope,
                address: props.address,
                fieldId,
                action,
            });
        } catch {
            Modal.alert(t('common.error'), t('errors.unknownError'));
        } finally {
            setPendingAction(null);
        }
    }, [fieldId, pendingAction, props.address, props.scope]);

    const copyMine = React.useCallback(async () => {
        const didCopy = await setClipboardStringSafe(mine);
        setCopied(didCopy);
        if (!didCopy) Modal.alert(t('common.error'), t('sessionDrafts.conflict.copyFailed'));
    }, [mine]);

    return (
        <SessionWarningActionBanner
            testID={`session-draft-conflict:${fieldId}`}
            title={t('sessionDrafts.conflict.title')}
            body={t('sessionDrafts.conflict.description')}
            actionsPlacement="title"
            content={<View style={styles.comparison}>
                <View style={styles.value}>
                    <Text style={styles.valueLabel}>{t('sessionDrafts.conflict.mine')}</Text>
                    <Text style={styles.valueText} numberOfLines={4}>{mine}</Text>
                </View>
                <View style={styles.value}>
                    <Text style={styles.valueLabel}>{t('sessionDrafts.conflict.synced')}</Text>
                    <Text style={styles.valueText} numberOfLines={4}>{synced}</Text>
                </View>
            </View>}
            actionTestID={`session-draft-conflict-action:${fieldId}:use-synced`}
            actionLabel={t('sessionDrafts.conflict.useSynced')}
            actionAccessibilityLabel={t('sessionDrafts.conflict.useSynced')}
            actionBusy={pendingAction === 'useSynced'}
            disabled={pendingAction !== null}
            onActionPress={() => resolve('useSynced')}
            secondaryActions={[
                {
                    key: 'keep-device',
                    testID: `session-draft-conflict-action:${fieldId}:keep-device`,
                    label: t('sessionDrafts.conflict.keepDevice'),
                    accessibilityLabel: t('sessionDrafts.conflict.keepDevice'),
                    disabled: pendingAction !== null,
                    onPress: () => resolve('keepDevice'),
                },
                {
                    key: 'copy-mine',
                    testID: `session-draft-conflict-action:${fieldId}:copy-mine`,
                    label: copied ? t('sessionDrafts.conflict.copied') : t('sessionDrafts.conflict.copyMine'),
                    accessibilityLabel: t('sessionDrafts.conflict.copyMine'),
                    variant: 'quiet',
                    onPress: copyMine,
                },
            ]}
        />
    );
});

export function SessionDraftConflictResolution(props: Readonly<{
    scope: ServerAccountScope;
    address: SessionDraftAddressV1;
    conflict: SessionDraftConflict;
}>): React.ReactNode {
    const styles = stylesheet;
    if (props.conflict.fields.length === 0) return null;
    return (
        <View style={styles.container}>
            {props.conflict.fields.map((field) => (
                <SessionDraftConflictFieldView
                    key={field.fieldId}
                    scope={props.scope}
                    address={props.address}
                    field={field}
                />
            ))}
        </View>
    );
}
