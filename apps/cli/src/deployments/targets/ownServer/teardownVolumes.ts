import type { DeploymentTeardownResourceV1 } from '@happier-dev/deployment-protocol';

export type TeardownNativeRun = (args: readonly string[]) => Promise<Readonly<{ exitCode: number; stdout: string; stderr: string }>>;

/** Compose labels, rather than caller supplied names or prefixes, own native volume membership. */
export async function readOwnServerTeardownVolumes(input: Readonly<{
    projects: Iterable<string>; machineId: string; run: TeardownNativeRun;
}>): Promise<DeploymentTeardownResourceV1[]> {
    const names = new Set<string>();
    for (const project of input.projects) {
        const listed = await input.run(['volume', 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Name}}']);
        if (listed.exitCode !== 0) throw Object.assign(new Error('volume_observation_unavailable'), { code: 'volume_observation_unavailable' });
        for (const name of listed.stdout.trim().split('\n').filter(Boolean)) names.add(name);
    }
    return [...names].sort().map(id => ({ id, kind: 'data', machineId: input.machineId, ownership: 'owned', disposition: 'retain' }));
}

export async function observeOwnServerTeardownVolumes(input: Readonly<{
    resources: readonly DeploymentTeardownResourceV1[]; run: TeardownNativeRun;
}>): Promise<'needed' | 'proved'> {
    const removed = input.resources.filter(resource => resource.kind === 'data' && resource.disposition === 'remove');
    if (!removed.length) return 'proved';
    const listed = await input.run(['volume', 'ls', '--format', '{{.Name}}']);
    if (listed.exitCode !== 0) throw Object.assign(new Error('volume_observation_unavailable'), { code: 'volume_observation_unavailable' });
    const present = new Set(listed.stdout.trim().split('\n'));
    return removed.some(resource => present.has(resource.id)) ? 'needed' : 'proved';
}

export async function settleOwnServerTeardownVolumes(input: Readonly<{
    resources: readonly DeploymentTeardownResourceV1[]; run: TeardownNativeRun;
}>): Promise<Readonly<{ kind: 'failed'; reason: 'volume_removal_failed' }> | null> {
    const selected = input.resources.filter(resource => resource.kind === 'data' && resource.disposition === 'remove');
    if (!selected.length) return null;
    const listed = await input.run(['volume', 'ls', '--format', '{{.Name}}']);
    if (listed.exitCode !== 0) return { kind: 'failed', reason: 'volume_removal_failed' };
    const present = new Set(listed.stdout.trim().split('\n'));
    const names = selected.filter(resource => present.has(resource.id)).map(resource => resource.id);
    if (names.length && (await input.run(['volume', 'rm', ...names])).exitCode !== 0) return { kind: 'failed', reason: 'volume_removal_failed' };
    return null;
}
