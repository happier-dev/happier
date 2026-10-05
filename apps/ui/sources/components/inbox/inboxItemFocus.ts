import type { InboxWorkItem } from '@/activity/presentation/buildInboxWorkGroups';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

/**
 * The Inbox route's one focus parameter (`session:<Home>:<id>` or `run:<Home>:<id>`, URI-encoded): the needs-you item
 * a person came to see from elsewhere (a Boards card, INT §5.1). The Inbox view opens on Needs you
 * with that item's qualified row selected. A bare legacy id is ambiguous across Homes.
 */
export type InboxItemFocus = Readonly<{ kind: 'session' | 'workflow_run'; serverId: string; id: string }>;

const PREFIX: Readonly<Record<InboxItemFocus['kind'], string>> = { session: 'session:', workflow_run: 'run:' };

export function createInboxItemRoute(focus: InboxItemFocus) {
    return { pathname: '/inbox', params: { item: `${PREFIX[focus.kind]}${encodeURIComponent(focus.serverId)}:${encodeURIComponent(focus.id)}` } } as const;
}

export function readInboxItemFocus(raw: string | string[] | undefined): InboxItemFocus | null {
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!value) return null;
    for (const kind of ['session', 'workflow_run'] as const) {
        if (!value.startsWith(PREFIX[kind])) continue;
        const parts = value.slice(PREFIX[kind].length).split(':');
        if (parts.length !== 2) return null;
        try {
            const serverId = decodeURIComponent(parts[0]!).trim();
            const id = decodeURIComponent(parts[1]!).trim();
            return serverId && id ? { kind, serverId, id } : null;
        } catch { return null; }
    }
    return null;
}

/** Whether a needs-you row is the focused item: a Session's row in any of its forms, or the run's own row. */
export function isFocusedInboxWorkItem(item: InboxWorkItem, focus: InboxItemFocus | null, servedRunServerId?: string | null): boolean {
    if (!focus) return false;
    const sameHome = (serverId: string | null | undefined) => Boolean(serverId)
        && areServerProfileIdentifiersEquivalent(serverId, focus.serverId);
    switch (item.kind) {
        case 'session':
            return focus.kind === 'session' && item.entry.candidate.sessionId === focus.id
                && sameHome(item.entry.candidate.address?.serverId ?? item.entry.candidate.serverId);
        case 'workflow_run':
            return focus.kind === 'workflow_run' && item.runId === focus.id && sameHome(servedRunServerId);
        case 'stalled':
        case 'landing':
        case 'snoozed':
            return focus.kind === 'session' && item.session.id === focus.id && sameHome(item.session.serverId);
    }
}
