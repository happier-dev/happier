import { isNativeDefinitionRecord as record } from '@/workspaces/projectSetup/nativePackageScripts';

type NativeVolumeRun = (args: readonly string[]) => Promise<Readonly<{ exitCode: number | null; stdout: string }>>;

function unavailable(): never {
    throw Object.assign(new Error('volume_observation_unavailable'), { code: 'volume_observation_unavailable' });
}

/** Compose labels, rather than supplied names or prefixes, own volume membership. */
export async function readNativeComposeProjectVolumeNames(input: Readonly<{
    projects: Iterable<string>; run: NativeVolumeRun;
    /** Receipt-captured service data activated from a Happier-owned restore stage. */
    activatedVolumes?: readonly string[];
}>): Promise<string[]> {
    const names = new Set<string>();
    for (const project of input.projects) {
        const listed = await input.run(['volume', 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Name}}']);
        if (listed.exitCode !== 0) return unavailable();
        for (const name of listed.stdout.trim().split('\n').filter(Boolean)) names.add(name);
    }
    if (input.activatedVolumes?.length) {
        const listed = await input.run(['volume', 'ls', '--filter', 'label=happier.operation', '--format', '{{.Name}}']);
        if (listed.exitCode !== 0) return unavailable();
        const owned = new Set(listed.stdout.trim().split('\n').filter(Boolean));
        for (const name of input.activatedVolumes) if (owned.has(name)) names.add(name);
    }
    return [...names].sort();
}

/** Select actual writable mounts from the witnessed containers and project inventory. */
export function selectNativeComposePreviewVolumeNames(input: Readonly<{
    projectName: string;
    targets: readonly Readonly<{ service: string; target: string }>[];
    expected: ReadonlyMap<string, string>;
    observations: unknown;
    ownedNames: readonly string[];
}>): string[] {
    const rows = input.observations;
    if (!input.expected.size || !Array.isArray(rows) || rows.length !== input.expected.size) return unavailable();
    const targets = new Map<string, Set<string>>();
    for (const { service, target } of input.targets) {
        const selected = targets.get(service) ?? new Set<string>();
        selected.add(target);
        targets.set(service, selected);
    }
    const mounted = new Set<string>();
    const seen = new Set<string>();
    for (const row of rows) {
        if (!record(row) || typeof row.Id !== 'string' || seen.has(row.Id) || !input.expected.has(row.Id)
            || !record(row.Config) || !record(row.Config.Labels) || !Array.isArray(row.Mounts)) return unavailable();
        seen.add(row.Id);
        const service = input.expected.get(row.Id)!;
        if (row.Config.Labels['com.docker.compose.project'] !== input.projectName
            || row.Config.Labels['com.docker.compose.service'] !== service) return unavailable();
        for (const mount of row.Mounts) {
            if (record(mount) && mount.Type === 'volume' && typeof mount.Name === 'string' && mount.Name
                && mount.RW !== false && typeof mount.Destination === 'string' && targets.get(service)?.has(mount.Destination)) mounted.add(mount.Name);
        }
    }
    return input.ownedNames.filter(name => mounted.has(name));
}

export async function settleNativeComposeVolumeRemoval(input: Readonly<{
    names: readonly string[]; run: NativeVolumeRun;
}>): Promise<Readonly<{ kind: 'failed'; reason: 'volume_removal_failed' }> | null> {
    if (!input.names.length) return null;
    const listed = await input.run(['volume', 'ls', '--format', '{{.Name}}']);
    if (listed.exitCode !== 0) return { kind: 'failed', reason: 'volume_removal_failed' };
    const present = new Set(listed.stdout.trim().split('\n'));
    const names = input.names.filter(name => present.has(name));
    if (names.length && (await input.run(['volume', 'rm', ...names])).exitCode !== 0) return { kind: 'failed', reason: 'volume_removal_failed' };
    return null;
}
