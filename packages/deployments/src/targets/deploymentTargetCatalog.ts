import type { DeploymentTargetV1 } from '@happier-dev/deployment-protocol/v1';

/** Readable during cyclic host initialization: this declaration uses no module-initialized values. */
export function readOwnServerDeploymentTargetDeclarationV1() {
    return {
        source: { kind: 'host', id: 'own-server' },
        actions: {
            inspect: { kind: 'host', actionId: 'deployments.environments.get' },
            link: { kind: 'host', actionId: 'deployments.targets.link' },
            deploy: { kind: 'host', actionId: 'deployments.deploy' },
            observe: { kind: 'host', actionId: 'deployments.receipts.get' },
            rollback: { kind: 'host', actionId: 'deployments.rollback' },
            teardown: { kind: 'host', actionId: 'deployments.teardown' },
        },
    } as const satisfies Pick<Extract<DeploymentTargetV1, { role: 'runtime' }>, 'source' | 'actions'>;
}

/** Native runtime Actions shared by the target declaration and its capability projections. */
export const { source: OWN_SERVER_DEPLOYMENT_TARGET_SOURCE_V1, actions: OWN_SERVER_DEPLOYMENT_TARGET_ACTIONS_V1 }
    = readOwnServerDeploymentTargetDeclarationV1();

/** Resource removal follows the target's declared teardown role; an unlinked record has no workload to stop. */
export function selectDeploymentTargetTeardownAvailableV1(
    source: DeploymentTargetV1['source'] | undefined,
    targets: readonly Readonly<{ pluginId: string; targetId: string; teardown?: true }>[],
): boolean {
    if (!source) return true;
    if (source.kind === 'host') return source.id === OWN_SERVER_DEPLOYMENT_TARGET_SOURCE_V1.id
        && Boolean(OWN_SERVER_DEPLOYMENT_TARGET_ACTIONS_V1.teardown);
    return targets.some(target => target.pluginId === source.contribution.pluginId
        && target.targetId === source.contribution.localId && target.teardown === true);
}

/** One removal choice owner for app and Action preparation; historical links are adopted. */
export function selectDeploymentTargetRemovalChoicesV1(
    source: DeploymentTargetV1['source'] | undefined,
    targets: Parameters<typeof selectDeploymentTargetTeardownAvailableV1>[1],
    origin?: 'created',
): Readonly<{ choices: readonly ('unlink' | 'delete')[]; defaultChoice: 'unlink' | 'delete' }> {
    const available = selectDeploymentTargetTeardownAvailableV1(source, targets);
    return { choices: available ? ['unlink', 'delete'] : ['unlink'],
        defaultChoice: available && origin === 'created' ? 'delete' : 'unlink' };
}

export interface DeploymentTargetCatalogV1 {
    list(): readonly DeploymentTargetV1[];
    read(source: DeploymentTargetV1['source']): DeploymentTargetV1 | null;
}

function sourceKey(source: DeploymentTargetV1['source']): string {
    return source.kind === 'host' ? JSON.stringify(['host', source.id])
        : JSON.stringify(['plugin', source.contribution.pluginId, source.contribution.localId]);
}

/** Consumes admitted normalized targets; declaration and invocation admission stay with their owners. */
export function createDeploymentTargetCatalogV1(targets: readonly DeploymentTargetV1[]): DeploymentTargetCatalogV1 {
    const bySource = new Map<string, DeploymentTargetV1>();
    for (const target of targets) {
        const key = sourceKey(target.source);
        if (bySource.has(key)) throw new TypeError('Duplicate admitted deployment target identity.');
        bySource.set(key, target);
    }
    const list = Object.freeze([...targets]);
    return Object.freeze({
        list: () => list,
        read: (source: DeploymentTargetV1['source']) => bySource.get(sourceKey(source)) ?? null,
    });
}
