import type { DeploymentEnvironmentSettingsSectionV1, DeploymentEnvironmentTabV1 } from '@happier-dev/deployments';

type DeploymentEnvironmentAddress = Readonly<{
    serverId: string; projectSourceId: string; environmentId: string; deploymentId?: string; tab?: DeploymentEnvironmentTabV1;
    /** A Settings section, opened in place on the Settings tab. */
    section?: DeploymentEnvironmentSettingsSectionV1;
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
            ...(input.database ? { deploymentService: input.database } : {}),
        },
    };
}

/** The same address as a link path, for consumers that hold a path rather than a typed route. */
export function buildDeploymentEnvironmentHref(input: DeploymentEnvironmentAddress): string {
    const { params } = deploymentEnvironmentRoute(input);
    return `/deployments/${encodeURIComponent(params.projectSourceId)}?serverId=${encodeURIComponent(params.serverId)}`
        + `&deploymentEnvironment=${encodeURIComponent(params.deploymentEnvironment)}`
        + ('deployment' in params ? `&deployment=${encodeURIComponent(params.deployment!)}` : '')
        + ('deploymentTab' in params ? `&deploymentTab=${encodeURIComponent(params.deploymentTab!)}` : '')
        + ('deploymentSection' in params ? `&deploymentSection=${encodeURIComponent(params.deploymentSection!)}` : '')
        + ('deploymentService' in params ? `&deploymentService=${encodeURIComponent(params.deploymentService!)}` : '');
}
