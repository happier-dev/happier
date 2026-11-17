/** One navigation target for profile pickers, settings and Artifact use targets. */
export function buildApprovalProfileSettingsRoute(profileId: string): `/settings/actions/profiles/${string}` {
    return `/settings/actions/profiles/${encodeURIComponent(profileId)}`;
}
