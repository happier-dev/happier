import type { TranslationKey } from '@/text';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import type { AgentInputStatusBadge } from '@/components/sessions/agentInput/agentInputContracts';
import type { SessionDraftStatus } from '@/sync/ops/sessionDrafts/sessionDraftRepository';

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
export function selectSessionDraftSyncBadgeStatus(status: SessionDraftStatus): SessionDraftStatus | null {
    return status === 'clean' || status === 'pending' || status === 'conflict' ? null : status;
}

export function buildSessionDraftSyncStatusBadge(input: SessionDraftStatus | null): AgentInputStatusBadge | null {
    const status = input === null ? null : selectSessionDraftSyncBadgeStatus(input);
    if (status === null) return null;
    const statusKey = resolveSessionDraftStatusKey(status);
    if (!statusKey) return null;
    const label = t(statusKey);
    return {
        key: 'draft-sync-status',
        label,
        accessibilityLabel: label,
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
