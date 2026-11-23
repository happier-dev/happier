import { disconnectNativeCaddyNetworks } from '@happier-dev/cli-common/machineSetup';

/** Release project-owned networks without disturbing another running or stopped workload. */
export async function removeUnusedNativeComposeNetworks(input: Readonly<{
    projects: readonly string[];
    retainedNetworkNames?: ReadonlySet<string>;
    run(args: readonly string[]): Promise<Readonly<{ exitCode: number | null; stdout: string; stderr?: string }>>;
}>): Promise<string | null> {
    const networkIds = new Set<string>();
    const format = input.retainedNetworkNames ? '{{.ID}}\t{{.Name}}' : '{{.ID}}';
    for (const project of input.projects) {
        const networks = await input.run(['network', 'ls', '--no-trunc', '--filter',
            `label=com.docker.compose.project=${project}`, '--format', format]);
        if (networks.exitCode !== 0) return 'network_observation_unavailable';
        for (const row of networks.stdout.trim().split('\n').filter(Boolean)) {
            const [id, name] = row.split('\t');
            if (!id || input.retainedNetworkNames && !name) return 'network_observation_unavailable';
            // An external declaration can reference a native network by ID.
            if (name && (input.retainedNetworkNames?.has(name) || input.retainedNetworkNames?.has(id))) continue;
            networkIds.add(id);
        }
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
