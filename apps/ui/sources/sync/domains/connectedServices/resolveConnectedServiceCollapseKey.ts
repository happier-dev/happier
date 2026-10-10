import { QualifiedConnectedDisclosureSubjectSchema } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

/** Device-local disclosure in LocalSettings.collapsedGroupKeysV1, qualified by its Home and Account. */

export type ConnectedServiceCollapseKeyParams = Readonly<{
    scope: ServerAccountScope;
    service: PluginContributionIdentityV1;
    profileId: string;
    /** When present, the key namespaces a pool member; otherwise a standalone account. */
    groupId?: string | null;
}>;

export function resolveConnectedServiceCollapseKey(params: ConnectedServiceCollapseKeyParams): string {
    const { scope, service, profileId, groupId } = params;
    const subject = QualifiedConnectedDisclosureSubjectSchema.parse(groupId != null && groupId !== ''
        ? { kind: 'group-member', group: { service, groupId }, accountId: profileId }
        : { kind: 'account', account: { service, accountId: profileId } });
    const address = subject.kind === 'account'
        ? [scope.serverId, scope.accountId, subject.account.service.pluginId,
            subject.account.service.localId, 'account', subject.account.accountId]
        : [scope.serverId, scope.accountId, subject.group.service.pluginId,
            subject.group.service.localId, 'pool', subject.group.groupId, subject.accountId];
    return `connectedServices:${JSON.stringify(address)}`;
}

/**
 * Reads collapse state for a key from the sparse persisted map, applying the
 * per-variant default when the key is absent.
 *
 * @param keys              the persisted sparse `Record<string, boolean>`
 * @param key               the namespaced collapse key
 * @param defaultCollapsed  variant default — `false` for accounts (expanded),
 *                          `true` for pool members (collapsed)
 */
export function isConnectedServiceItemCollapsed(
    keys: Readonly<Record<string, boolean>> | null | undefined,
    key: string,
    defaultCollapsed: boolean,
): boolean {
    const stored = keys?.[key];
    return typeof stored === 'boolean' ? stored : defaultCollapsed;
}

/**
 * Produces the next sparse map after toggling/setting a key's collapse state.
 * Persists only deviations from the variant default: a value equal to the
 * default is removed so the device-local map stays sparse.
 */
export function setConnectedServiceItemCollapsed(
    keys: Readonly<Record<string, boolean>> | null | undefined,
    key: string,
    collapsed: boolean,
    defaultCollapsed: boolean,
): Record<string, boolean> {
    const next: Record<string, boolean> = { ...(keys ?? {}) };
    if (collapsed === defaultCollapsed) {
        delete next[key];
    } else {
        next[key] = collapsed;
    }
    return next;
}
