type DeploymentEnvironmentAddress = Readonly<{
    serverId: string; projectSourceId: string; environmentId: string; deploymentId?: string;
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
        },
    };
}

/** The same address as a link path, for consumers that hold a path rather than a typed route. */
export function buildDeploymentEnvironmentHref(input: DeploymentEnvironmentAddress): string {
    const { params } = deploymentEnvironmentRoute(input);
    return `/deployments/${encodeURIComponent(params.projectSourceId)}?serverId=${encodeURIComponent(params.serverId)}`
        + `&deploymentEnvironment=${encodeURIComponent(params.deploymentEnvironment)}`
        + ('deployment' in params ? `&deployment=${encodeURIComponent(params.deployment!)}` : '');
}
