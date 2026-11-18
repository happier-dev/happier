/**
 * P40-R54 Environment navigation: the one owner of the seven Environment tabs and the sections another page
 * links to: Settings sections (Private sharing from a database's Share) and the Overview's Automations (Project
 * defaults). Variables, Domains and Permissions are tabs, never sections; consumers
 * (P41/P42/P45/P60 links, the host page and its URL) import these instead of copying ids.
 */
export const DEPLOYMENT_ENVIRONMENT_TABS_V1 = ['overview', 'history', 'variables', 'domains', 'telemetry', 'permissions', 'settings'] as const;
export type DeploymentEnvironmentTabV1 = (typeof DEPLOYMENT_ENVIRONMENT_TABS_V1)[number];

export const DEPLOYMENT_ENVIRONMENT_SETTINGS_SECTIONS_V1 = [
    'servers-build', 'sharing', 'controller', 'rollout', 'checks-alerts', 'backups', 'previews',
] as const;
export type DeploymentEnvironmentSettingsSectionV1 = (typeof DEPLOYMENT_ENVIRONMENT_SETTINGS_SECTIONS_V1)[number];

/** The Overview's linked sections: its Automations (triggers and push setup) close the page (dEnvOv KEEP). */
export const DEPLOYMENT_ENVIRONMENT_OVERVIEW_SECTIONS_V1 = ['automations'] as const;
export type DeploymentEnvironmentOverviewSectionV1 = (typeof DEPLOYMENT_ENVIRONMENT_OVERVIEW_SECTIONS_V1)[number];

export type DeploymentEnvironmentDestinationV1 = Readonly<{
    tab: DeploymentEnvironmentTabV1;
    /** A Settings section on the Settings tab, an Overview section on the Overview; null elsewhere. */
    section: DeploymentEnvironmentSettingsSectionV1 | DeploymentEnvironmentOverviewSectionV1 | null;
}>;

const TABS: ReadonlySet<string> = new Set(DEPLOYMENT_ENVIRONMENT_TABS_V1);
const SECTIONS: ReadonlySet<string> = new Set(DEPLOYMENT_ENVIRONMENT_SETTINGS_SECTIONS_V1);
const OVERVIEW_SECTIONS: ReadonlySet<string> = new Set(DEPLOYMENT_ENVIRONMENT_OVERVIEW_SECTIONS_V1);

/** Narrows a destination's section to a Settings section (the Settings panel's focus). */
export function isDeploymentEnvironmentSettingsSectionV1(section: unknown): section is DeploymentEnvironmentSettingsSectionV1 {
    return typeof section === 'string' && SECTIONS.has(section);
}

/** Canonicalizes an untrusted tab/section pair: unknown tabs open Overview, unknown sections the Settings landing. */
export function resolveDeploymentEnvironmentDestinationV1(input: Readonly<{ tab?: unknown; section?: unknown }>): DeploymentEnvironmentDestinationV1 {
    const tab = typeof input.tab === 'string' && TABS.has(input.tab) ? input.tab as DeploymentEnvironmentTabV1 : 'overview';
    const section = typeof input.section !== 'string' ? null
        : tab === 'settings' && SECTIONS.has(input.section) ? input.section as DeploymentEnvironmentSettingsSectionV1
        : tab === 'overview' && OVERVIEW_SECTIONS.has(input.section) ? input.section as DeploymentEnvironmentOverviewSectionV1
        : null;
    return { tab, section };
}
