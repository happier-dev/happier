/**
 * P40-R54 Environment navigation: the one owner of the seven Environment tabs and the Settings section
 * ids another page links to (Private sharing from a database's Share, Automations from Project defaults).
 * Variables, Domains and Permissions are tabs, never Settings sections; consumers
 * (P41/P42/P45/P60 links, the host page and its URL) import these instead of copying ids.
 */
export const DEPLOYMENT_ENVIRONMENT_TABS_V1 = ['overview', 'history', 'variables', 'domains', 'telemetry', 'permissions', 'settings'] as const;
export type DeploymentEnvironmentTabV1 = (typeof DEPLOYMENT_ENVIRONMENT_TABS_V1)[number];

export const DEPLOYMENT_ENVIRONMENT_SETTINGS_SECTIONS_V1 = [
    'servers-build', 'sharing', 'controller', 'rollout', 'checks-alerts', 'backups', 'previews', 'automations',
] as const;
export type DeploymentEnvironmentSettingsSectionV1 = (typeof DEPLOYMENT_ENVIRONMENT_SETTINGS_SECTIONS_V1)[number];

export type DeploymentEnvironmentDestinationV1 = Readonly<{
    tab: DeploymentEnvironmentTabV1;
    /** Set only on the Settings tab. */
    section: DeploymentEnvironmentSettingsSectionV1 | null;
}>;

const TABS: ReadonlySet<string> = new Set(DEPLOYMENT_ENVIRONMENT_TABS_V1);
const SECTIONS: ReadonlySet<string> = new Set(DEPLOYMENT_ENVIRONMENT_SETTINGS_SECTIONS_V1);

/** Canonicalizes an untrusted tab/section pair: unknown tabs open Overview, unknown sections the Settings landing. */
export function resolveDeploymentEnvironmentDestinationV1(input: Readonly<{ tab?: unknown; section?: unknown }>): DeploymentEnvironmentDestinationV1 {
    const tab = typeof input.tab === 'string' && TABS.has(input.tab) ? input.tab as DeploymentEnvironmentTabV1 : 'overview';
    const section = tab === 'settings' && typeof input.section === 'string' && SECTIONS.has(input.section)
        ? input.section as DeploymentEnvironmentSettingsSectionV1 : null;
    return { tab, section };
}
