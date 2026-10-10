import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol';

export type TeamCredentialConnectedAccountSourceHint = Readonly<{
    kind: 'connected_account';
    serverId: string;
    account: QualifiedConnectedAccountRef;
}>;

export type TeamCredentialPoolSourceHint = Readonly<{
    kind: 'connected_pool';
    serverId: string;
    service: QualifiedConnectedAccountRef['service'];
    groupId: string;
}>;

export type TeamCredentialProviderConnectionSourceHint = Readonly<{
    kind: 'provider_connection';
    serverId: string;
    machineId: string;
    connectionId: string;
    credentialSlotId: string;
    connectionSecurityFingerprint: string;
}>;

export type TeamCredentialSourceHint =
    | TeamCredentialConnectedAccountSourceHint
    | TeamCredentialPoolSourceHint
    | TeamCredentialProviderConnectionSourceHint;

/**
 * Team destinations.
 *
 * Every Team path carries its Home's own id alongside the Team id, so a screen
 * opened here stays bound to that exact Home for its whole lifetime: two Homes
 * may legitimately hold the same Team id, and focusing another Home elsewhere in
 * the app must never retarget an open Team screen or a mutation started from it.
 *
 * Opening any of these destinations does not change the focused Home.
 */
export function teamsDirectoryPath(): string {
    return '/settings/teams';
}

/** Opens Team selection for an exact connected-account source. */
export function teamsDirectoryShareCredentialPath(source: TeamCredentialSourceHint): string {
    const query = new URLSearchParams({
        credentialSourceKind: source.kind,
        credentialSourceServerId: source.serverId,
        ...(source.kind === 'provider_connection'
            ? {
                credentialSourceConnectionId: source.connectionId,
                credentialSourceSlotId: source.credentialSlotId,
                credentialSourceMachineId: source.machineId,
                credentialSourceConnectionSecurityFingerprint: source.connectionSecurityFingerprint,
            }
            : {
                credentialSourcePluginId: source.kind === 'connected_account' ? source.account.service.pluginId : source.service.pluginId,
                credentialSourceLocalId: source.kind === 'connected_account' ? source.account.service.localId : source.service.localId,
                ...(source.kind === 'connected_account'
                    ? { credentialSourceAccountId: source.account.accountId }
                    : { credentialSourceGroupId: source.groupId }),
            }),
    });
    return `${teamsDirectoryPath()}?${query.toString()}`;
}

export function teamsCreatePath(options?: Readonly<{ administrationServerId?: string }>): string {
    const serverId = options?.administrationServerId?.trim();
    const base = `${teamsDirectoryPath()}/new`;
    return serverId
        ? `${base}?administrationServerId=${encodeURIComponent(serverId)}`
        : base;
}

export function teamDetailPath(address: TeamAddress): string {
    return `${teamsDirectoryPath()}/${encodeURIComponent(address.serverId)}/${encodeURIComponent(address.teamId)}`;
}

/**
 * The Team's daily-work destination: the one canonical Sessions surface, entered
 * with this Team's audience preselected.
 *
 * It sits outside `/settings` because it is work, not administration, but it still
 * carries the Home so two Homes holding the same Team id open distinct surfaces
 * with their own filters, scroll and Back behaviour.
 */
export function teamSessionsPath(address: TeamAddress): string {
    return `/teams/${encodeURIComponent(address.teamId)}/sessions?serverId=${encodeURIComponent(address.serverId)}`;
}

export function teamMembersPath(address: TeamAddress): string {
    return `${teamDetailPath(address)}/members`;
}

/**
 * One membership lifetime. The id is the immutable lifetime, so a link stays
 * meaningful across a rename or a provider Account replacement, and a rejoined
 * person is a different destination rather than a resurrected one.
 */
export function teamMemberDetailPath(
    address: TeamAddress,
    membershipId: string,
    /**
     * Set only by the add journey that explicitly chose to include existing
     * history. It is why the destination may start preparing on arrival instead of
     * waiting to be asked; opening the same detail any other way stays passive.
     */
    options?: Readonly<{ prepareHistory?: boolean }>,
): string {
    const path = `${teamMembersPath(address)}/${encodeURIComponent(membershipId)}`;
    return options?.prepareHistory === true ? `${path}?prepareHistory=1` : path;
}

/**
 * Group membership detail keeps the Group address in the URL so the shared
 * member-detail host can prepare the Group's history horizon rather than
 * silently falling back to the Team membership resource.
 */
export function teamGroupMemberDetailPath(
    address: TeamAddress,
    membershipId: string,
    groupId: string,
    accountId: string,
    options?: Readonly<{ prepareHistory?: boolean }>,
): string {
    const query = `?groupId=${encodeURIComponent(groupId)}&accountId=${encodeURIComponent(accountId)}`;
    return `${teamMemberDetailPath(address, membershipId)}${query}`
        + (options?.prepareHistory === true ? '&prepareHistory=1' : '');
}

export function teamMemberAddPath(address: TeamAddress): string {
    return `${teamMembersPath(address)}/add`;
}

export function teamGroupsPath(address: TeamAddress): string {
    return `${teamDetailPath(address)}/groups`;
}

export function teamInvitationsPath(address: TeamAddress): string {
    return `${teamDetailPath(address)}/invitations`;
}

export function teamSettingsPath(address: TeamAddress): string {
    return `${teamDetailPath(address)}/settings`;
}

/**
 * Lane 03 contributes the Authentication destination under the Team's own path
 * rather than adding a second Team root; the path owner still lives here so the
 * Team route shape has one definition.
 */
export function teamAuthenticationPath(address: TeamAddress): string {
    return `${teamDetailPath(address)}/authentication`;
}

export function teamIdentityConnectionPath(address: TeamAddress, connectionId: string): string {
    return `${teamAuthenticationPath(address)}/${encodeURIComponent(connectionId)}`;
}

export function teamIdentityConnectionProviderEditPath(address: TeamAddress, connectionId: string, providerId: string): string {
    return `${teamIdentityConnectionPath(address, connectionId)}/edit?providerId=${encodeURIComponent(providerId)}`;
}

export function teamIdentityProviderSetupPath(
    address: TeamAddress,
    providerKind: 'oidc' | 'github_app_identity' | 'workos_sso',
): string {
    return `${teamAuthenticationPath(address)}/new?kind=${encodeURIComponent(providerKind)}`;
}

/**
 * One Team-owned GitHub App registration. It sits under Authentication because
 * a Team App reaches Happier as a sign-in identity; repository access for the
 * same App stays with the Connected Services owner.
 */
export function teamGitHubAppPath(address: TeamAddress, registrationId: string): string {
    return `${teamAuthenticationPath(address)}/github-apps/${encodeURIComponent(registrationId)}`;
}

export function teamGitHubAppEditPath(address: TeamAddress, registrationId: string): string {
    return `${teamGitHubAppPath(address, registrationId)}/edit`;
}

/**
 * Lane 10 contributes the shared-credential destinations under the Team's own
 * path, like Authentication before it, so there is still one Team route shape.
 *
 * A resource id is unique only within its Team, which is why the Home and Team
 * stay in the path: a link opened here addresses one exact resource on one exact
 * Home even when another Home holds a Team and a resource with the same ids.
 */
export function teamCredentialsPath(address: TeamAddress): string {
    return `${teamDetailPath(address)}/credentials`;
}

/**
 * Offering a source to this Team. It sits beside the list rather than under a
 * resource because no resource exists yet; the draft it owns belongs to this
 * route, so leaving and returning starts a new offer rather than resurrecting a
 * half-configured one.
 */
export function teamCredentialCreatePath(
    address: TeamAddress,
    source?: TeamCredentialSourceHint,
): string {
    const path = `${teamCredentialsPath(address)}/new`;
    if (!source) return path;
    const query = new URLSearchParams({
        credentialSourceKind: source.kind,
        ...(source.kind === 'provider_connection'
            ? {
                credentialSourceConnectionId: source.connectionId,
                credentialSourceSlotId: source.credentialSlotId,
                credentialSourceMachineId: source.machineId,
                credentialSourceConnectionSecurityFingerprint: source.connectionSecurityFingerprint,
            }
            : {
                credentialSourcePluginId: source.kind === 'connected_account' ? source.account.service.pluginId : source.service.pluginId,
                credentialSourceLocalId: source.kind === 'connected_account' ? source.account.service.localId : source.service.localId,
                ...(source.kind === 'connected_account'
                    ? { credentialSourceAccountId: source.account.accountId }
                    : { credentialSourceGroupId: source.groupId }),
            }),
    });
    return `${path}?${query.toString()}`;
}

export function teamCredentialDetailPath(address: TeamAddress, resourceId: string): string {
    return `${teamCredentialsPath(address)}/${encodeURIComponent(resourceId)}`;
}

export function teamCredentialEditPath(address: TeamAddress, resourceId: string): string {
    return `${teamCredentialDetailPath(address, resourceId)}/edit`;
}

/** Audience and delivery for one resource. */
export function teamCredentialAccessPath(address: TeamAddress, resourceId: string): string {
    return `${teamCredentialEditPath(address, resourceId)}?section=access`;
}

/**
 * The constraints the source owner puts on the actual Provider request.
 *
 * It is its own destination rather than a section of the editor because it is
 * the one part of a resource whose fields depend on what the selected source's
 * protocol can enforce, and because a person adjusting a ceiling should not have
 * to re-confirm a disclosure decision to reach Save.
 */
export function teamCredentialRequestPolicyPath(address: TeamAddress, resourceId: string): string {
    return `${teamCredentialEditPath(address, resourceId)}?section=request-policy`;
}

export function teamCredentialActivityPath(address: TeamAddress, resourceId: string): string {
    return `${teamCredentialDetailPath(address, resourceId)}/activity`;
}

export function teamCredentialLimitsPath(address: TeamAddress, resourceId: string): string {
    return `${teamCredentialEditPath(address, resourceId)}?section=limits`;
}

export function teamCredentialUsagePath(address: TeamAddress, resourceId: string): string {
    return `${teamCredentialDetailPath(address, resourceId)}/usage`;
}

export function teamCredentialExternalApiPath(address: TeamAddress, resourceId: string): string {
    return `${teamCredentialDetailPath(address, resourceId)}/external-api`;
}

export function teamDirectoryPath(address: TeamAddress): string {
    return `${teamAuthenticationPath(address)}/directory`;
}

export function teamDirectorySourcePath(address: TeamAddress, sourceId: string): string {
    return `${teamDirectoryPath(address)}/${encodeURIComponent(sourceId)}`;
}

/** One Group inside its Team. Group ids are unique only within their Team. */
export function teamGroupDetailPath(address: TeamAddress, groupId: string): string {
    return `${teamGroupsPath(address)}/${encodeURIComponent(groupId)}`;
}

export function teamGroupCreatePath(address: TeamAddress): string {
    return `${teamGroupsPath(address)}/new`;
}

/*
 * There is deliberately no client-side join-URL constructor. A join link is
 * issued by the Home that owns the invitation and arrives whole, so building
 * one here would be a second spelling of a bearer-carrying URL that this device
 * is never the source of. The `/join/:token` destination itself is owned by its
 * route file, and the redaction of that shape by the shared capability
 * redactor in `@happier-dev/protocol`.
 */
