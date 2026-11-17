import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';

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
export function teamsDirectoryPath(): '/settings/teams' {
    return '/settings/teams';
}

/** Opens Team selection for an exact connected-account source. */
export function teamsDirectoryShareCredentialPath(source: TeamCredentialSourceHint): `/settings/teams?${string}` {
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

export function teamsCreatePath(options?: Readonly<{ administrationServerId?: string }>): '/settings/teams/new' | `/settings/teams/new?${string}` {
    const serverId = options?.administrationServerId?.trim();
    const base = `${teamsDirectoryPath()}/new` as const;
    return serverId
        ? `${base}?administrationServerId=${encodeURIComponent(serverId)}`
        : base;
}

export function teamDetailPath(address: TeamAddress): `/settings/teams/${string}/${string}` {
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
export function teamSessionsPath(address: TeamAddress): `/teams/${string}/sessions?serverId=${string}` {
    return `/teams/${encodeURIComponent(address.teamId)}/sessions?serverId=${encodeURIComponent(address.serverId)}`;
}

export function teamMembersPath(address: TeamAddress): `/settings/teams/${string}/${string}/members` {
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
): `/settings/teams/${string}/${string}/members/${string}` {
    const path = `${teamMembersPath(address)}/${encodeURIComponent(membershipId)}` as const;
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
): `/settings/teams/${string}/${string}/members/${string}` {
    const query = `?groupId=${encodeURIComponent(groupId)}&accountId=${encodeURIComponent(accountId)}`;
    return `${teamMemberDetailPath(address, membershipId)}${query}${options?.prepareHistory === true ? '&prepareHistory=1' : ''}`;
}

export function teamMemberAddPath(address: TeamAddress): `/settings/teams/${string}/${string}/members/add` {
    return `${teamMembersPath(address)}/add`;
}

export function teamGroupsPath(address: TeamAddress): `/settings/teams/${string}/${string}/groups` {
    return `${teamDetailPath(address)}/groups`;
}

export function teamInvitationsPath(address: TeamAddress): `/settings/teams/${string}/${string}/invitations` {
    return `${teamDetailPath(address)}/invitations`;
}

export function teamSettingsPath(address: TeamAddress): `/settings/teams/${string}/${string}/settings` {
    return `${teamDetailPath(address)}/settings`;
}

/** Set up for a Team (plan D, L2): the member's setup page, on the exact Home that holds the Team. */
export function teamSetupPath(address: TeamAddress): `/teams/${string}/setup?serverId=${string}` {
    return `/teams/${encodeURIComponent(address.teamId)}/setup?serverId=${encodeURIComponent(address.serverId)}`;
}

/** What new members get: the Team's member defaults and, as they land, the rest of a new member's setup. */
export function teamNewMembersPath(address: TeamAddress): `/settings/teams/${string}/${string}/new-members` {
    return `${teamDetailPath(address)}/new-members`;
}

/**
 * Lane 03 contributes the Authentication destination under the Team's own path
 * rather than adding a second Team root; the path owner still lives here so the
 * Team route shape has one definition.
 */
export function teamAuthenticationPath(address: TeamAddress): `/settings/teams/${string}/${string}/authentication` {
    return `${teamDetailPath(address)}/authentication`;
}

export function teamIdentityConnectionPath(address: TeamAddress, connectionId: string): `/settings/teams/${string}/${string}/authentication/${string}` {
    return `${teamAuthenticationPath(address)}/${encodeURIComponent(connectionId)}`;
}

export function teamIdentityConnectionProviderEditPath(address: TeamAddress, connectionId: string, providerId: string): `/settings/teams/${string}/${string}/authentication/${string}/edit?providerId=${string}` {
    return `${teamIdentityConnectionPath(address, connectionId)}/edit?providerId=${encodeURIComponent(providerId)}`;
}

export function teamIdentityProviderSetupPath(
    address: TeamAddress,
    providerKind: 'oidc' | 'github_app_identity' | 'workos_sso',
): `/settings/teams/${string}/${string}/authentication/new?kind=${string}` {
    return `${teamAuthenticationPath(address)}/new?kind=${encodeURIComponent(providerKind)}`;
}

/**
 * One Team-owned GitHub App registration. It sits under Authentication because
 * a Team App reaches Happier as a sign-in identity; repository access for the
 * same App stays with the Connected Services owner.
 */
export function teamGitHubAppPath(address: TeamAddress, registrationId: string): `/settings/teams/${string}/${string}/authentication/github-apps/${string}` {
    return `${teamAuthenticationPath(address)}/github-apps/${encodeURIComponent(registrationId)}`;
}

export function teamGitHubAppEditPath(address: TeamAddress, registrationId: string): `/settings/teams/${string}/${string}/authentication/github-apps/${string}/edit` {
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
export function teamCredentialsPath(address: TeamAddress): `/settings/teams/${string}/${string}/credentials` {
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
): `/settings/teams/${string}/${string}/credentials/new${'' | `?${string}`}` {
    const path = `${teamCredentialsPath(address)}/new` as const;
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

export function teamCredentialDetailPath(address: TeamAddress, resourceId: string): `/settings/teams/${string}/${string}/credentials/${string}` {
    return `${teamCredentialsPath(address)}/${encodeURIComponent(resourceId)}`;
}

export function teamCredentialEditPath(address: TeamAddress, resourceId: string): `/settings/teams/${string}/${string}/credentials/${string}/edit` {
    return `${teamCredentialDetailPath(address, resourceId)}/edit`;
}

/** Audience and delivery for one resource. */
export function teamCredentialAccessPath(address: TeamAddress, resourceId: string): `/settings/teams/${string}/${string}/credentials/${string}/edit?section=access` {
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
export function teamCredentialRequestPolicyPath(address: TeamAddress, resourceId: string): `/settings/teams/${string}/${string}/credentials/${string}/edit?section=request-policy` {
    return `${teamCredentialEditPath(address, resourceId)}?section=request-policy`;
}

export function teamCredentialActivityPath(address: TeamAddress, resourceId: string): `/settings/teams/${string}/${string}/credentials/${string}/activity` {
    return `${teamCredentialDetailPath(address, resourceId)}/activity`;
}

export function teamCredentialLimitsPath(address: TeamAddress, resourceId: string): `/settings/teams/${string}/${string}/credentials/${string}/edit?section=limits` {
    return `${teamCredentialEditPath(address, resourceId)}?section=limits`;
}

export function teamCredentialUsagePath(address: TeamAddress, resourceId: string): `/settings/teams/${string}/${string}/credentials/${string}/usage` {
    return `${teamCredentialDetailPath(address, resourceId)}/usage`;
}

export function teamCredentialAggregateUsagePath(address: TeamAddress): `/settings/teams/${string}/${string}/credentials/usage` {
    return `${teamCredentialsPath(address)}/usage`;
}

export function teamCredentialExternalApiPath(address: TeamAddress, resourceId: string): `/settings/teams/${string}/${string}/credentials/${string}/external-api` {
    return `${teamCredentialDetailPath(address, resourceId)}/external-api`;
}

export function teamDirectoryPath(address: TeamAddress): `/settings/teams/${string}/${string}/authentication/directory` {
    return `${teamAuthenticationPath(address)}/directory`;
}

export function teamDirectorySourcePath(address: TeamAddress, sourceId: string): `/settings/teams/${string}/${string}/authentication/directory/${string}` {
    return `${teamDirectoryPath(address)}/${encodeURIComponent(sourceId)}`;
}

/** One Group inside its Team. Group ids are unique only within their Team. */
export function teamGroupDetailPath(address: TeamAddress, groupId: string): `/settings/teams/${string}/${string}/groups/${string}` {
    return `${teamGroupsPath(address)}/${encodeURIComponent(groupId)}`;
}

export function teamGroupCreatePath(address: TeamAddress): `/settings/teams/${string}/${string}/groups/new` {
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
