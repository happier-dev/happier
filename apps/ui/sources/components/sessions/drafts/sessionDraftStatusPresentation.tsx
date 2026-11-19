import type { TranslationKey } from '@/text';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import type { AgentInputStatusBadge } from '@/components/sessions/agentInput/agentInputContracts';
import { Popover } from '@/components/ui/popover/Popover';
import { Text } from '@/components/ui/text/Text';
import { StyleSheet } from 'react-native-unistyles';
import type { SessionDraftErrorReason, SessionDraftSnapshot, SessionDraftStatus } from '@/sync/ops/sessionDrafts/sessionDraftRepository';

export function resolveSessionDraftStatusKey(status: SessionDraftStatus): TranslationKey | null {
    switch (status) {
        case 'pending': return 'sessionDrafts.status.syncing';
        case 'offline': return 'sessionDrafts.status.offline';
        case 'conflict': return 'sessionDrafts.status.conflict';
        case 'error': return 'common.error';
        case 'unsupported': return 'sessionDrafts.status.unsupported';
        case 'clean': return null;
    }
}

/**
 * The draft status the composer badge shows, or null when it shows none. `pending` is the normal
 * state of every edit until its remote flush and `conflict` has its own banner, so a host that
 * selects this instead of the raw status does not render for each sync of a typing burst.
 */
const errorExplanations = {
    storage: 'sessionDrafts.status.storageError',
    crypto: 'sessionDrafts.status.cryptoError',
    transport: 'sessionDrafts.status.transportError',
    cleanup: 'sessionDrafts.status.cleanupError',
    unknown: 'sessionDrafts.status.unknownError',
} as const satisfies Record<SessionDraftErrorReason | 'unknown', TranslationKey>;

export type SessionDraftSyncBadgeStatus = 'offline' | 'unsupported' | typeof errorExplanations[keyof typeof errorExplanations];

export function selectSessionDraftSyncBadgeStatus(
    snapshot: Pick<SessionDraftSnapshot, 'status' | 'errorReason'> | null | undefined,
): SessionDraftSyncBadgeStatus | null {
    if (snapshot?.status === 'error') return errorExplanations[snapshot.errorReason ?? 'unknown'];
    return snapshot?.status === 'offline' || snapshot?.status === 'unsupported' ? snapshot.status : null;
}

export function buildSessionDraftSyncStatusBadge(input: SessionDraftSyncBadgeStatus | null): AgentInputStatusBadge | null {
    if (input === null) return null;
    const explanation = input === 'offline' || input === 'unsupported' ? null : t(input);
    const status = input === 'offline' || input === 'unsupported' ? input : 'error';
    const statusKey = resolveSessionDraftStatusKey(status);
    if (!statusKey) return null;
    const label = t(statusKey);
    return {
        key: 'draft-sync-status',
        label,
        accessibilityLabel: label,
        ...(explanation ? {
            accessibilityHint: explanation,
            renderPopover: ({ open, anchorRef, onRequestClose }) => (
                <Popover open={open} anchorRef={anchorRef} onRequestClose={onRequestClose} placement="top"
                    containerStyle={styles.explanation}>
                    {() => <Text variant="body">{explanation}</Text>}
                </Popover>
            ),
        } satisfies Pick<AgentInputStatusBadge, 'accessibilityHint' | 'renderPopover'> : {}),
        testID: 'session-draft-sync-status-badge',
        // A Home that cannot sync this draft is a standing condition, not a
        // failure to retry, so it reads like `offline` rather than an error.
        tone: status === 'offline' || status === 'unsupported' ? 'paused' : 'warning',
        emphasis: status === 'error' ? 'prominent' : 'quiet',
        icon: (tint: string) => (
            <Icon
                name={status === 'offline' || status === 'unsupported' ? 'cloud' : 'warning-circle'}
                size={14}
                color={tint}
            />
        ),
    };
}

const styles = StyleSheet.create(theme => ({
    explanation: { padding: theme.space.s3 },
}));
