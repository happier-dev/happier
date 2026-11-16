import type { DeploymentEnvironmentSettingsSectionV1, DeploymentEnvironmentTabV1 } from '@happier-dev/deployments';

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
        },
    };
}

export type DeploymentNewDefinitionKind = 'compose' | 'image';

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
        + ('deploymentService' in params ? `&deploymentService=${encodeURIComponent(params.deploymentService!)}` : '');
}
