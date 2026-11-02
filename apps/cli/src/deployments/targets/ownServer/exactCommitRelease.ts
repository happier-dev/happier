import type { DeploymentSourceMaterializationV1 } from '@happier-dev/plugin-sdk';
import type { WorkspaceManifestEntry } from '@happier-dev/protocol';

const sourceManifests = new WeakMap<DeploymentSourceMaterializationV1, Readonly<{
    entries: readonly WorkspaceManifestEntry[]; operationLog?: boolean; commitSubject?: string;
}>>();

/** Host-only projection of the manifest already admitted by transfer custody. */
export function readDeploymentSourceManifestForHost(source: DeploymentSourceMaterializationV1): readonly WorkspaceManifestEntry[] {
    const manifest = sourceManifests.get(source);
    if (!manifest) throw Object.assign(new Error('Deployment source custody is unavailable'), { code: 'deployment_source_unavailable' });
    return manifest.entries;
}

/** Observation of source already proven by retained receipt custody. It owns no
 * staging bytes, so settlement cannot transfer or remove the serving release. */
export function observeRetainedDeploymentSourceForHost(input: Omit<DeploymentSourceMaterializationV1, 'commit' | 'abort'>
    & Readonly<{ manifest: readonly WorkspaceManifestEntry[] }>): DeploymentSourceMaterializationV1 {
    const { manifest, ...identity } = input;
    const source: DeploymentSourceMaterializationV1 = Object.freeze({ ...identity, async commit() {}, async abort() {} });
    sourceManifests.set(source, { entries: manifest });
    return source;
}
