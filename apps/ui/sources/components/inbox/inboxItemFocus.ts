import type { InboxWorkItem } from '@/activity/presentation/buildInboxWorkGroups';
import { buildDeploymentEnvironmentHref } from '@/components/projects/deployments/deploymentNavigation';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { createActivitySurfaceSessionRoute } from '@/activity/actions/activitySurfaceTargets';
import { createMachineExecutionRunRoute, createWorkflowInvocationRoute, createWorkflowRunRoute, readWorkflowInvocationId } from '@/sync/domains/workflows/workflowRunRoute';
import { buildPluginAppPageRoutePath } from '@/components/plugins/pages/pluginPageRoute';
import type { AccountNoticeArtifactHeaderV1, UsageNoticeArtifactHeaderV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { inboxNoticeFocusKeyV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { machinePageHref, machineVitalsNoticeHref } from '@/components/machines/page/machinePageHref';
import { buildDiscussionRouteHref } from '@/components/discussions/discussionRoutes';
import type { InboxItemView } from './inboxItemProjection';
import { buildSessionExecutionRunRouteHref } from '@/components/sessions/agents/navigation/buildSessionExecutionRunRouteHref';

/** The selected Inbox view travels with its destination, including phone Back. */
export function readInboxView(raw: string | string[] | undefined): InboxItemView | null {
    const value = Array.isArray(raw) ? raw[0] : raw;
    return value === 'needs_you' || value === 'updates' || value === 'mentions' ? value : null;
}

/**
 * The Inbox route's one focus parameter (`session:<Home>:<id>`, `run:<Home>:<id>` or
 * `approval:<Home>:<artifact id>`, URI-encoded): the needs-you item that is selected. It is what a
 * person came to see from elsewhere (a Boards card, INT §5.1), and, beside the list on wide screens,
 * the item whose detail is open (lab `inbox-I1`). A bare legacy id is ambiguous across Homes. An
 * approval's Home may be empty: a request that names none is opened on the active Home, as its own
 * route does.
 */
export type InboxItemFocus = Readonly<{ serverId: string; id: string } & (
    | { kind: 'session'; jumpSeq?: number }
    | { kind: 'approval' | 'notice' }
    | { kind: 'managed_machine' }
    | { kind: 'workflow_run'; invocationId?: string }
    | { kind: 'execution_run'; sessionId: string; machineId?: never }
    | { kind: 'execution_run'; machineId: string; sessionId?: never }
    | { kind: 'automation_run'; automationId: string }
    | { kind: 'discussion'; messageId: string }
)>;

export type InboxItemDetailContext = Readonly<{ notice?: AccountNoticeArtifactHeaderV1 | UsageNoticeArtifactHeaderV1 | null }>;
type InboxNoticePageSource = Pick<AccountNoticeArtifactHeaderV1, 'kind' | 'source' | 'page' | 'notice'>
    | Pick<UsageNoticeArtifactHeaderV1, 'kind' | 'notice'>;

/** Source kinds choose one detail adapter and their real page here; plugins use the existing page host. */
export const INBOX_ITEM_DETAIL_REGISTRY = {
    managed_machine: { prefix: 'managed-machine:', detail: 'page', openLabel: 'common.open',
        route: (focus: InboxItemFocus) => `/settings/machines/managed/${encodeURIComponent(focus.id)}?serverId=${encodeURIComponent(focus.serverId)}` },
    execution_run: { prefix: 'execution:', detail: 'page', openLabel: 'inbox.work.groups.openRun',
        route: (focus: InboxItemFocus) => focus.kind === 'execution_run' ? (focus.machineId !== undefined
            ? createMachineExecutionRunRoute(focus.serverId, focus.machineId, focus.id)
            : buildSessionExecutionRunRouteHref({ serverId: focus.serverId, sessionId: focus.sessionId, runId: focus.id })) ?? '/inbox' : '/inbox' },
    discussion: { prefix: 'discussion:', detail: 'page', openLabel: 'common.open',
        route: (focus: InboxItemFocus) => focus.kind === 'discussion' ? buildDiscussionRouteHref({ target: {
            kind: 'discussion', address: { serverId: focus.serverId }, discussionId: focus.id, messageId: focus.messageId,
        } }) : '/inbox' },
    session: { prefix: 'session:', detail: 'session', openLabel: 'inbox.work.groups.openSession',
        route: (focus: InboxItemFocus) => createActivitySurfaceSessionRoute(focus.id, focus.serverId,
            focus.kind === 'session' && readInboxJumpSeq(focus.jumpSeq) !== null ? { jumpSeq: String(focus.jumpSeq) } : undefined) },
    workflow_run: { prefix: 'run:', detail: 'workflow_run', openLabel: 'inbox.work.groups.openRun',
        route: (focus: InboxItemFocus) => focus.kind === 'workflow_run' && focus.invocationId
            ? createWorkflowInvocationRoute(focus.id, focus.invocationId, focus.serverId) : createWorkflowRunRoute(focus.id, focus.serverId) },
    approval: { prefix: 'approval:', detail: 'approval', openLabel: 'inbox.work.detail.openApproval',
        route: (focus: InboxItemFocus) => `/inbox/approvals/${encodeURIComponent(focus.id)}${focus.serverId ? `?serverId=${encodeURIComponent(focus.serverId)}` : ''}` },
    notice: { prefix: 'notice:', detail: 'notice', openLabel: 'common.open',
        route: (focus: InboxItemFocus, context?: InboxItemDetailContext) => resolveInboxNoticePageRoute(focus.id, context?.notice, focus.serverId) },
    automation_run: { prefix: 'automation:', detail: 'page', openLabel: 'inbox.work.groups.openRun',
        route: (focus: InboxItemFocus) => focus.kind === 'automation_run'
            ? createWorkflowRunRoute({ kind: 'occurrence', automationId: focus.automationId, runId: focus.id }, focus.serverId) : '/inbox' },
} as const;

/**
 * A notice that points nowhere is its own content, so its page is its Inbox item: a phone pushes the
 * same selected notice the wide pane shows, never the stored document page with its JSON.
 */
export function resolveInboxNoticePageRoute(id: string, notice?: InboxNoticePageSource | null, serverId?: string): string {
    return resolveInboxNoticeOwnPageRoute(notice, serverId)
        ?? `/inbox?item=${encodeURIComponent(inboxNoticeFocusKeyV1(serverId ?? '', id))}`;
}

/** The page a notice points at (a plugin page, usage or a machine), or null when the notice is its own content. */
export function resolveInboxNoticeOwnPageRoute(notice?: InboxNoticePageSource | null, serverId?: string): string | null {
    if (notice?.kind === 'account_notice.v1' && notice.source.kind === 'host' && notice.page
        && 'kind' in notice.page && notice.page.page === 'environment' && notice.page.deploymentId) {
        return buildDeploymentEnvironmentHref({ ...notice.page.environment, deploymentId: notice.page.deploymentId });
    }
    if (notice?.kind === 'account_notice.v1' && notice.source.kind === 'plugin' && notice.page && !('kind' in notice.page)) {
        return buildPluginAppPageRoutePath({ pluginId: notice.source.pluginId, localId: notice.page.pageId,
            ...(notice.page.subPath === undefined ? {} : { subPath: notice.page.subPath }) });
    }
    if (notice?.notice?.topic === 'connected_service_usage') return '/settings/usage';
    if (notice?.notice?.topic === 'resource_limit') return machineVitalsNoticeHref(notice.notice, serverId);
    return null;
}

/**
 * Where a service-health notice's cause lives (COR5B #162): its Environment, or its service on the Machine. The detail
 * links it; the notice itself stays the Inbox item. Null for every other notice.
 */
export function resolveInboxNoticeSubjectRoute(notice?: Pick<AccountNoticeArtifactHeaderV1, 'kind' | 'source' | 'page'> | null): string | null {
    if (notice?.kind !== 'account_notice.v1' || notice.source.kind !== 'host' || !notice.page || !('kind' in notice.page)) return null;
    const page = notice.page;
    if (page.page === 'environment') return buildDeploymentEnvironmentHref(page.environment);
    return machinePageHref({ door: 'rail', target: { machineId: page.machine.machineId, serverId: page.machine.serverId },
        tab: { id: 'services', page: 'service', service: page.service.serviceId } });
}

export function createInboxItemRoute(focus: InboxItemFocus, view?: InboxItemView) {
    return { pathname: '/inbox', params: {
        item: focus.kind === 'notice' ? inboxNoticeFocusKeyV1(focus.serverId, focus.id)
            : `${INBOX_ITEM_DETAIL_REGISTRY[focus.kind].prefix}${encodeURIComponent(focus.serverId)}:${encodeURIComponent(focus.id)}${focus.kind === 'automation_run' ? `:${encodeURIComponent(focus.automationId)}` : focus.kind === 'discussion' ? `:${encodeURIComponent(focus.messageId)}` : focus.kind === 'execution_run' ? focus.machineId !== undefined ? `:machine:${encodeURIComponent(focus.machineId)}` : `:${encodeURIComponent(focus.sessionId)}` : ''}`,
        ...(focus.kind === 'workflow_run' && focus.invocationId ? { invocationId: focus.invocationId } : {}),
        ...(focus.kind === 'session' && readInboxJumpSeq(focus.jumpSeq) !== null ? { jumpSeq: String(focus.jumpSeq) } : {}),
        ...(view ? { view } : {}),
    } } as const;
}

/** The selected item's own page, which "open" leaves for: the same place a phone pushes. */
export function resolveInboxItemPageRoute(focus: InboxItemFocus, context?: InboxItemDetailContext): string {
    return INBOX_ITEM_DETAIL_REGISTRY[focus.kind].route(focus, context);
}

function readInboxJumpSeq(raw: number | string | string[] | undefined): number | null {
    const value = Array.isArray(raw) ? raw[0] : raw;
    const seq = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    return Number.isSafeInteger(seq) && seq > 0 ? seq : null;
}

export function readInboxItemFocus(raw: string | string[] | undefined, rawInvocationId?: string | string[], rawJumpSeq?: string | string[]): InboxItemFocus | null {
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!value) return null;
    for (const kind of Object.keys(INBOX_ITEM_DETAIL_REGISTRY) as InboxItemFocus['kind'][]) {
        const prefix = INBOX_ITEM_DETAIL_REGISTRY[kind].prefix;
        if (!value.startsWith(prefix)) continue;
        const parts = value.slice(prefix.length).split(':');
        if (parts.length !== (kind === 'automation_run' || kind === 'discussion' || kind === 'execution_run' ? 3 : 2)
            && !(kind === 'execution_run' && parts.length === 4 && parts[2] === 'machine')) return null;
        try {
            const serverId = decodeURIComponent(parts[0]!).trim();
            const id = decodeURIComponent(parts[1]!).trim();
            if (!(serverId || kind === 'approval') || !id) return null;
            if (kind === 'automation_run') {
                const automationId = decodeURIComponent(parts[2]!).trim();
                return automationId ? { kind, serverId, id, automationId } : null;
            }
            if (kind === 'discussion') {
                const messageId = decodeURIComponent(parts[2]!).trim();
                return messageId ? { kind, serverId, id, messageId } : null;
            }
            if (kind === 'execution_run') {
                if (parts.length === 4) {
                    const machineId = decodeURIComponent(parts[3]!).trim();
                    return machineId ? { kind, serverId, id, machineId } : null;
                }
                const sessionId = decodeURIComponent(parts[2]!).trim();
                return sessionId ? { kind, serverId, id, sessionId } : null;
            }
            const invocationId = kind === 'workflow_run' ? readWorkflowInvocationId(rawInvocationId) : null;
            const jumpSeq = kind === 'session' ? readInboxJumpSeq(rawJumpSeq) : null;
            return { kind, serverId, id, ...(invocationId ? { invocationId } : {}), ...(jumpSeq === null ? {} : { jumpSeq }) };
        } catch { return null; }
    }
    return null;
}

/** Whether a needs-you row is the focused item: a Session's row in any of its forms, or the run's own row. */
export function isFocusedInboxWorkItem(item: InboxWorkItem, focus: InboxItemFocus | null, servedRunServerId?: string | null, servedAutomationServerId?: string | null): boolean {
    if (!focus) return false;
    const sameHome = (serverId: string | null | undefined) => Boolean(serverId)
        && areServerProfileIdentifiersEquivalent(serverId, focus.serverId);
    if (item.kind === 'approval') {
        return isFocusedInboxApproval(item.artifact.id,
            readInboxApprovalServerId(item.artifact.header as Readonly<Record<string, unknown>> | undefined), focus);
    }
    if (item.kind === 'automation_run') return focus.kind === 'automation_run' && item.row.id === focus.id
        && item.row.automation?.automationId === focus.automationId && sameHome(servedAutomationServerId);
    if (focus.kind === 'approval' || focus.kind === 'notice' || focus.kind === 'automation_run') return false;
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
