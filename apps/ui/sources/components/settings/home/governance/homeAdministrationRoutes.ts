/**
 * Home Administration destinations.
 *
 * Every path carries the Home's own id, so a screen opened here stays bound to
 * that Home for its whole lifetime and a change of focused Home elsewhere in the
 * app cannot retarget it.
 */
/**
 * The Home selector. It is the only Home Administration destination without a
 * Home in its path, because choosing one is exactly what it is for.
 */
export function homeAdministrationHomesPath(): '/settings/home' {
    return '/settings/home';
}

/**
 * Home Administration as the Settings navigation opens it: the Home selector, told it was entered
 * from Settings, so one administrable Home opens its console directly. Every other way to the
 * selector (All Homes, a link, back) is `homeAdministrationHomesPath()` and shows the list.
 */
export const HOME_ADMINISTRATION_SETTINGS_ENTRY = 'settings';
export function homeAdministrationSettingsEntryHref(): '/settings/home?entry=settings' {
    return `${homeAdministrationHomesPath()}?entry=${HOME_ADMINISTRATION_SETTINGS_ENTRY}`;
}

export function homeAdministrationOverviewPath(serverId: string): `/settings/home/${string}` {
    return `${homeAdministrationHomesPath()}/${encodeURIComponent(serverId)}`;
}

export function homeAdministrationPeoplePath(serverId: string): `/settings/home/${string}/people` {
    return `${homeAdministrationOverviewPath(serverId)}/people`;
}

export function homeAdministrationAccountPath(serverId: string, accountId: string): `/settings/home/${string}/people/${string}` {
    return `${homeAdministrationPeoplePath(serverId)}/${encodeURIComponent(accountId)}`;
}

/**
 * Team administration for one Home. It is a Home Administration destination
 * rather than the person's own Teams list: the authority comes from the Home
 * role, and the Teams shown are the Home's, not the viewer's memberships.
 */
export function homeAdministrationTeamsPath(serverId: string): `/settings/home/${string}/teams` {
    return `${homeAdministrationOverviewPath(serverId)}/teams`;
}

/** What new sessions of this Home's members start with: the Machine and per-Agent defaults. */
export function homeAdministrationMemberDefaultsPath(serverId: string): `/settings/home/${string}/teams/member-defaults` {
    return `${homeAdministrationTeamsPath(serverId)}/member-defaults`;
}

export function homeAdministrationPoliciesPath(serverId: string): `/settings/home/${string}/policies` {
    return `${homeAdministrationOverviewPath(serverId)}/policies`;
}

/** How devices, links and mail find this Home: addresses, direct connections and the host's access method. */
export function homeAdministrationReachPath(serverId: string): `/settings/home/${string}/reach` {
    return `${homeAdministrationOverviewPath(serverId)}/reach`;
}

/** The server that runs this Home: version, updates, restart and the hosting computer's operations. */
export function homeAdministrationRuntimePath(serverId: string): `/settings/home/${string}/runtime` {
    return `${homeAdministrationOverviewPath(serverId)}/runtime`;
}

/** How this Home sends mail: SMTP, sender and a test send. */
export function homeAdministrationEmailPath(serverId: string): `/settings/home/${string}/email` {
    return `${homeAdministrationOverviewPath(serverId)}/email`;
}

/** What this Home offers: every server feature, its limits, and why each is on or off. */
export function homeAdministrationFeaturesPath(serverId: string): `/settings/home/${string}/features` {
    return `${homeAdministrationOverviewPath(serverId)}/features`;
}

/** What this Home keeps and for how long: automatic deletion and its dry run. */
export function homeAdministrationDataPath(serverId: string): `/settings/home/${string}/data` {
    return `${homeAdministrationOverviewPath(serverId)}/data`;
}

/** Every setting the server reads, from its configuration registry: live, restart-applied and read-only at startup. */
export function homeAdministrationServerSettingsPath(serverId: string): `/settings/home/${string}/server-settings` {
    return `${homeAdministrationOverviewPath(serverId)}/server-settings`;
}

/** Who changed what on this Home, and when: the administration audit trail. */
export function homeAdministrationActivityPath(serverId: string): `/settings/home/${string}/activity` {
    return `${homeAdministrationOverviewPath(serverId)}/activity`;
}

export function homeAdministrationUsagePath(serverId: string): `/settings/home/${string}/usage` {
    return `${homeAdministrationOverviewPath(serverId)}/usage`;
}

/** The audit trail narrowed to events about one person (`home.audit.list{targetId}`). */
export function homeAdministrationPersonActivityPath(serverId: string, accountId: string): `/settings/home/${string}/activity?targetId=${string}` {
    return `${homeAdministrationActivityPath(serverId)}?targetId=${encodeURIComponent(accountId)}`;
}

/**
 * Company sign-in, GitHub Apps and the rules Teams use: the identity providers and GitHub Apps
 * live under it. Policies keeps only the sign-in methods that turn a provider on.
 */
export function homeAdministrationSignInProvidersPath(serverId: string): `/settings/home/${string}/sign-in-providers` {
    return `${homeAdministrationOverviewPath(serverId)}/sign-in-providers`;
}

export function homeAdministrationIdentityProviderCreatePath(serverId: string): `/settings/home/${string}/sign-in-providers/identity/new` {
    return `${homeAdministrationSignInProvidersPath(serverId)}/identity/new`;
}

/** The shared scoped connection detail, separate from managed OIDC provider records. */
export function homeAdministrationIdentityConnectionPath(serverId: string, connectionId: string): `/settings/home/${string}/sign-in-providers/connections/${string}` {
    return `${homeAdministrationSignInProvidersPath(serverId)}/connections/${encodeURIComponent(connectionId)}`;
}

export function homeAdministrationWorkosSetupPath(serverId: string): `/settings/home/${string}/sign-in-providers/connections/new` {
    return `${homeAdministrationSignInProvidersPath(serverId)}/connections/new`;
}

export function homeAdministrationIdentityProviderPath(serverId: string, providerId: string): `/settings/home/${string}/sign-in-providers/identity/${string}` {
    return `${homeAdministrationSignInProvidersPath(serverId)}/identity/${encodeURIComponent(providerId)}`;
}

export function homeAdministrationIdentityProviderEditPath(serverId: string, providerId: string): `/settings/home/${string}/sign-in-providers/identity/${string}/edit` {
    return `${homeAdministrationIdentityProviderPath(serverId, providerId)}/edit`;
}

export function homeAdministrationGitHubAppCreatePath(serverId: string): `/settings/home/${string}/sign-in-providers/github-apps/new` {
    return `${homeAdministrationSignInProvidersPath(serverId)}/github-apps/new`;
}

export function homeAdministrationGitHubAppPath(serverId: string, registrationId: string): `/settings/home/${string}/sign-in-providers/github-apps/${string}` {
    return `${homeAdministrationSignInProvidersPath(serverId)}/github-apps/${encodeURIComponent(registrationId)}`;
}

export function homeAdministrationGitHubAppEditPath(serverId: string, registrationId: string): `/settings/home/${string}/sign-in-providers/github-apps/${string}/edit` {
    return `${homeAdministrationGitHubAppPath(serverId, registrationId)}/edit`;
}
