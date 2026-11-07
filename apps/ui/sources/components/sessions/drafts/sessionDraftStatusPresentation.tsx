import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { TranslationKey } from '@/text';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { AgentInputStatusBadge } from '@/components/sessions/agentInput/agentInputContracts';
import { AgentInputContentPopover } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import type { SessionDraftErrorReason, SessionDraftStatus } from '@/sync/ops/sessionDrafts/sessionDraftRepository';

export function resolveSessionDraftStatusKey(status: SessionDraftStatus): TranslationKey | null {
    switch (status) {
        case 'pending': return 'sessionDrafts.status.syncing';
        case 'offline': return 'sessionDrafts.status.offline';
        case 'conflict': return 'sessionDrafts.status.conflict';
        case 'error': return 'common.error';
        case 'clean': return null;
    }
}

function resolveSessionDraftErrorDescriptionKey(reason: SessionDraftErrorReason): TranslationKey {
    switch (reason) {
        case 'storage': return 'sessionDrafts.error.storageDescription';
        case 'encryption': return 'sessionDrafts.error.encryptionDescription';
    }
}

const stylesheet = StyleSheet.create((theme) => ({
    details: {
        gap: 6,
        paddingHorizontal: 14,
        paddingVertical: 12,
    },
    title: {
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    description: {
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
}));

/** The explanation behind the composer's draft "Error" badge, selectable so it can be copied into a report. */
export function SessionDraftSyncErrorDetails(props: Readonly<{ reason: SessionDraftErrorReason }>) {
    const styles = stylesheet;
    return (
        <View testID={`session-draft-sync-error-details:${props.reason}`} style={styles.details}>
            <Text selectable style={styles.title}>{t('sessionDrafts.error.title')}</Text>
            <Text selectable style={styles.description}>{t(resolveSessionDraftErrorDescriptionKey(props.reason))}</Text>
        </View>
    );
}

export function buildSessionDraftSyncStatusBadge(
    status: SessionDraftStatus,
    details?: Readonly<{
        /** Read when the badge is opened, so the closed badge never subscribes to failure detail. */
        readErrorReason: () => SessionDraftErrorReason | null;
    }>,
): AgentInputStatusBadge | null {
    if (status === 'clean' || status === 'pending' || status === 'conflict') return null;
    const statusKey = resolveSessionDraftStatusKey(status);
    if (!statusKey) return null;
    const label = t(statusKey);
    const readErrorReason = status === 'error' ? details?.readErrorReason : undefined;
    return {
        key: 'draft-sync-status',
        label,
        accessibilityLabel: label,
        testID: 'session-draft-sync-status-badge',
        tone: status === 'offline' ? 'paused' : 'danger',
        emphasis: status === 'error' ? 'prominent' : 'quiet',
        icon: (tint: string) => (
            <Icon
                name={status === 'offline' ? 'cloud' : 'warning-circle'}
                size={14}
                color={tint}
            />
        ),
        ...(readErrorReason ? {
            accessibilityHint: t('sessionDrafts.error.showDetailsHint'),
            renderPopover: ({ open, anchorRef, onRequestClose }) => {
                const reason = readErrorReason();
                if (!open || !reason) return null;
                return (
                    <AgentInputContentPopover
                        open={open}
                        anchorRef={anchorRef}
                        onRequestClose={onRequestClose}
                        maxWidthCap={360}
                        testID="session-draft-sync-error-popover"
                        content={<SessionDraftSyncErrorDetails reason={reason} />}
                    />
                );
            },
        } satisfies Partial<AgentInputStatusBadge> : null),
    };
}
