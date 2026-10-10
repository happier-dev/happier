import type { InboxWorkItem } from '@/activity/presentation/buildInboxWorkGroups';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { readWorkflowInvocationId } from '@/sync/domains/workflows/workflowRunRoute';

/**
 * The Inbox route's one focus parameter (`session:<Home>:<id>`, `run:<Home>:<id>` or
 * `approval:<Home>:<artifact id>`, URI-encoded): the needs-you item that is selected. It is what a
 * person came to see from elsewhere (a Boards card, INT §5.1), and, beside the list on wide screens,
 * the item whose detail is open (lab `inbox-I1`). A bare legacy id is ambiguous across Homes. An
 * approval's Home may be empty: a request that names none is opened on the active Home, as its own
 * route does.
 */
export type InboxItemFocus = Readonly<{ serverId: string; id: string } & (
    | { kind: 'session' | 'approval' }
    | { kind: 'workflow_run'; invocationId?: string }
)>;

const PREFIX: Readonly<Record<InboxItemFocus['kind'], string>> = { session: 'session:', workflow_run: 'run:', approval: 'approval:' };

export function createInboxItemRoute(focus: InboxItemFocus) {
    return { pathname: '/inbox', params: {
        item: `${PREFIX[focus.kind]}${encodeURIComponent(focus.serverId)}:${encodeURIComponent(focus.id)}`,
        ...(focus.kind === 'workflow_run' && focus.invocationId ? { invocationId: focus.invocationId } : {}),
    } } as const;
}

export function readInboxItemFocus(raw: string | string[] | undefined, rawInvocationId?: string | string[]): InboxItemFocus | null {
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!value) return null;
    for (const kind of ['session', 'workflow_run', 'approval'] as const) {
        if (!value.startsWith(PREFIX[kind])) continue;
        const parts = value.slice(PREFIX[kind].length).split(':');
        if (parts.length !== 2) return null;
        try {
            const serverId = decodeURIComponent(parts[0]!).trim();
            const id = decodeURIComponent(parts[1]!).trim();
            if (!(serverId || kind === 'approval') || !id) return null;
            const invocationId = kind === 'workflow_run' ? readWorkflowInvocationId(rawInvocationId) : null;
            return { kind, serverId, id, ...(invocationId ? { invocationId } : {}) };
        } catch { return null; }
    }
    return null;
}

/** Whether a needs-you row is the focused item: a Session's row in any of its forms, or the run's own row. */
export function isFocusedInboxWorkItem(item: InboxWorkItem, focus: InboxItemFocus | null, servedRunServerId?: string | null): boolean {
    if (!focus) return false;
    const sameHome = (serverId: string | null | undefined) => Boolean(serverId)
        && areServerProfileIdentifiersEquivalent(serverId, focus.serverId);
    if (focus.kind === 'approval') return false;
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

/** The approval artifact's own Home, as its header names it (`serverIdentityId`, else `serverId`), or ''. */
export function readInboxApprovalServerId(header: Readonly<Record<string, unknown>> | null | undefined): string {
    const identity = typeof header?.serverIdentityId === 'string' ? header.serverIdentityId.trim() : '';
    if (identity) return identity;
    return typeof header?.serverId === 'string' ? header.serverId.trim() : '';
}

/** Whether an approval row is the selected item. */
export function isFocusedInboxApproval(artifactId: string, serverId: string, focus: InboxItemFocus | null): boolean {
    if (focus?.kind !== 'approval' || focus.id !== artifactId) return false;
    return focus.serverId === '' ? serverId === '' : areServerProfileIdentifiersEquivalent(serverId, focus.serverId);
}
