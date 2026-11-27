import type { DeploymentEnvironmentDestinationV1, DeploymentEnvironmentSettingsSectionV1, DeploymentEnvironmentTabV1 } from '@happier-dev/deployments';
import type { SettingsCollectionFilter } from '@/components/settings/shell/settingsCollectionAdapter';

/**
 * Where an Environment's Automations live: they close its Overview (pfc-redesign r4 dEnvOv KEEP, owner-approved 11-13).
 * The Environment page places them here and every link to them (Project defaults) opens here, so the two never disagree.
 */
export const ENVIRONMENT_AUTOMATIONS_DESTINATION: DeploymentEnvironmentDestinationV1 = { tab: 'overview', section: 'automations' };

/** The Store catalog condition for databases: Data → Add, a preview's database choice and Move's empty destination list open with it. */
export const DEPLOYMENT_DATABASE_CATALOG_FILTER: SettingsCollectionFilter = Object.freeze({
  category: Object.freeze({ include: ['database'], exclude: [] }),
});

/** The Services page: every app, database, domain and check this Account runs (formerly All deployments). */
export const SERVICES_ROUTE = '/projects/deployments';

/** One saved Check (an Automation's health trigger) as its own Services page; the details pane's Open as page. */
export const SERVICE_CHECK_ROUTE = '/projects/deployments/check';

export type ServiceCheckAddress = Readonly<{ automationId: string; triggerId: string }>;

export function buildServiceCheckHref(input: ServiceCheckAddress): string {
    return `${SERVICE_CHECK_ROUTE}?automation=${encodeURIComponent(input.automationId)}&trigger=${encodeURIComponent(input.triggerId)}`;
}

export function readServiceCheckRouteParams(params: Readonly<Record<string, string | string[] | undefined>>): ServiceCheckAddress | null {
    const automationId = params.automation;
    const triggerId = params.trigger;
    return typeof automationId === 'string' && automationId && typeof triggerId === 'string' && triggerId
        ? { automationId, triggerId } : null;
}

type DeploymentEnvironmentAddress = Readonly<{
    serverId: string; projectSourceId: string; environmentId: string; deploymentId?: string; tab?: DeploymentEnvironmentTabV1;
    /** A Settings section, opened in place on the Settings tab. */
    section?: DeploymentEnvironmentSettingsSectionV1;
    /** Open the incumbent native setup sheet for this exact Environment. */
    setup?: 'backups';
    /** One of the Environment's databases, opened in place like a receipt (P9). */
    database?: string;
    /** Open the existing Detach review for this target. */
    detachTargetLinkId?: string;
    pluginPage?: Readonly<{ pluginId: string; localId: string; subPath?: string; view?: string | null }>;
}>;

/** Native Environment identity never needs a checkout/WorkspaceRef; `deploymentId` opens one of its receipts. */
export function deploymentEnvironmentRoute(input: DeploymentEnvironmentAddress) {
    return {
        pathname: '/deployments/[projectSourceId]' as const,
        params: {
            projectSourceId: input.projectSourceId,
            serverId: input.serverId,
            deploymentEnvironment: input.environmentId,
            ...(input.deploymentId ? { deployment: input.deploymentId } : {}),
            ...(input.tab ? { deploymentTab: input.tab } : {}),
            ...(input.section ? { deploymentSection: input.section } : {}),
            ...(input.setup ? { deploymentSetup: input.setup } : {}),
            ...(input.database ? { deploymentService: input.database } : {}),
            ...(input.detachTargetLinkId ? { deploymentDetachTarget: input.detachTargetLinkId } : {}),
            ...(input.pluginPage ? {
                deploymentPlugin: input.pluginPage.pluginId,
                deploymentPluginPage: input.pluginPage.localId,
                ...(input.pluginPage.subPath ? { deploymentPluginPath: input.pluginPage.subPath } : {}),
                ...(input.pluginPage.view && input.pluginPage.view !== input.pluginPage.localId
                    ? { deploymentPluginView: input.pluginPage.view } : {}),
            } : {}),
        },
    };
}

/** `folder`: a folder on the Machine that runs it, sent as it is at each deploy (Deploy an app only; no route opens it). */
export type DeploymentNewDefinitionKind = 'compose' | 'image' | 'folder';

/** A Project's new-Environment draft, opened on a stored definition (Store → Apps' Paste a Compose file, Run an image). */
export function buildDeploymentNewDefinitionHref(input: Readonly<{ serverId: string; projectSourceId?: string; kind: DeploymentNewDefinitionKind;
    /** The Machine a "Deploy an app here" door already chose; the draft starts on it (as the repository draft does). */
    machineId?: string | null }>): string {
    return `/deployments/${input.projectSourceId ? encodeURIComponent(input.projectSourceId) : 'new'}?serverId=${encodeURIComponent(input.serverId)}&newDefinition=${input.kind}`
        + (input.machineId ? `&deployMachine=${encodeURIComponent(input.machineId)}` : '');
}

/**
 * The draft door's value for a Project's own repository; not a stored definition. Deploy an app hosts that draft in its
 * own dialog (journey-deploy D3); a link carrying it still opens the Project's draft.
 */
export const DEPLOYMENT_NEW_REPOSITORY_DRAFT = 'repository' as const;

/** A Project's own deployments page (its Environments), by its Source: the Services column's and the Projects tree's Project row. */
export function buildDeploymentProjectHref(input: Readonly<{ serverId: string; projectSourceId: string }>): string {
    return `/deployments/${encodeURIComponent(input.projectSourceId)}?serverId=${encodeURIComponent(input.serverId)}`;
}

/** The same address as a link path, for consumers that hold a path rather than a typed route. */
export function buildDeploymentEnvironmentHref(input: DeploymentEnvironmentAddress): string {
    const { params } = deploymentEnvironmentRoute(input);
    return `/deployments/${encodeURIComponent(params.projectSourceId)}?serverId=${encodeURIComponent(params.serverId)}`
        + `&deploymentEnvironment=${encodeURIComponent(params.deploymentEnvironment)}`
        + ('deployment' in params ? `&deployment=${encodeURIComponent(params.deployment!)}` : '')
        + ('deploymentTab' in params ? `&deploymentTab=${encodeURIComponent(params.deploymentTab!)}` : '')
        + ('deploymentSection' in params ? `&deploymentSection=${encodeURIComponent(params.deploymentSection!)}` : '')
        + ('deploymentSetup' in params ? `&deploymentSetup=${encodeURIComponent(params.deploymentSetup!)}` : '')
        + ('deploymentService' in params ? `&deploymentService=${encodeURIComponent(params.deploymentService!)}` : '')
        + ('deploymentDetachTarget' in params ? `&deploymentDetachTarget=${encodeURIComponent(params.deploymentDetachTarget!)}` : '')
        + ('deploymentPlugin' in params ? `&deploymentPlugin=${encodeURIComponent(params.deploymentPlugin!)}&deploymentPluginPage=${encodeURIComponent(params.deploymentPluginPage!)}` : '')
        + ('deploymentPluginPath' in params ? `&deploymentPluginPath=${encodeURIComponent(params.deploymentPluginPath!)}` : '')
        + ('deploymentPluginView' in params ? `&deploymentPluginView=${encodeURIComponent(params.deploymentPluginView!)}` : '');
}
