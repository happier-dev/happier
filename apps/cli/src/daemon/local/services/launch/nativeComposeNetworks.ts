import { disconnectNativeCaddyNetworks } from '@happier-dev/cli-common/machineSetup';

/** Release project-owned networks without disturbing another running or stopped workload. */
export async function removeUnusedNativeComposeNetworks(input: Readonly<{
    projects: readonly string[];
    run(args: readonly string[]): Promise<Readonly<{ exitCode: number | null; stdout: string; stderr?: string }>>;
}>): Promise<string | null> {
    const networkIds = new Set<string>();
    for (const project of input.projects) {
        const networks = await input.run(['network', 'ls', '--no-trunc', '--filter',
            `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}']);
        if (networks.exitCode !== 0) return 'network_observation_unavailable';
        for (const id of networks.stdout.trim().split('\n').filter(Boolean)) networkIds.add(id);
    }
    if (!networkIds.size) return null;
    const detached = await disconnectNativeCaddyNetworks({ networkIds: [...networkIds], onlyUnused: true }, {
        run: async command => {
            const result = await input.run(command.args);
            return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr ?? '' };
        },
    });
    if (detached.status !== 'ready') return detached.reason;
    for (const id of networkIds) {
        // Network inspect omits stopped containers. Docker's all-state listing
        // is the holder authority, including another retained generation.
        const holders = await input.run(['ps', '--all', '--no-trunc', '--filter', `network=${id}`, '--format', '{{.ID}}']);
        if (holders.exitCode !== 0) return 'network_observation_unavailable';
        if (holders.stdout.trim()) continue;
        const removal = await input.run(['network', 'rm', id]);
        if (removal.exitCode !== 0) return removal.exitCode === null ? 'network_removal_unproved' : 'network_removal_failed';
    }
    return null;
}
