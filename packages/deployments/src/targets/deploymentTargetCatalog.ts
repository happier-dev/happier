import type { DeploymentTargetV1 } from '@happier-dev/deployment-protocol/v1';

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
