import { readNativeComposeLogTargetForHost, type NativeComposeActivatedServiceFacts } from './nativeComposeLifecycle';
import { projectNativeComposeReview } from '@/workspaces/projectSetup/nativeComposeReview';
import { isNativeDefinitionRecord as record } from '@/workspaces/projectSetup/nativePackageScripts';
import { readNativeComposePublishedPorts } from './nativeComposePorts';

type ColdTarget = NonNullable<ReturnType<typeof readNativeComposeLogTargetForHost>> & Readonly<{
    configuration: NativeComposeActivatedServiceFacts['configuration'] | undefined;
}>;

/** Native inspection supplies effective ports even when no activation render
 * survives. Never re-open runtime secrets or copy Config.Env/commands/paths. */
function readColdConfiguration(rows: readonly unknown[], target: NonNullable<ReturnType<typeof readNativeComposeLogTargetForHost>>,
    composeService: string): ColdTarget['configuration'] {
    const selected = rows.filter((row): row is Record<string, unknown> => record(row)
        && typeof row.Id === 'string' && target.containerIds.includes(row.Id));
    const first = selected[0];
    if (!first || selected.length !== target.containerIds.length || !record(first.Config) || !record(first.HostConfig)) return undefined;
    const ports = readNativeComposePublishedPorts(selected.map(row => record(row.NetworkSettings) ? row.NetworkSettings.Ports : undefined), value => value);
    if (!ports) return undefined;
    const host = first.HostConfig;
    const policy = record(host.RestartPolicy) ? host.RestartPolicy : undefined;
    const healthcheck = record(first.Config.Healthcheck) ? first.Config.Healthcheck : undefined;
    // Reuse the warm native structural projector. Cold observations have no
    // activation masking lease, so mount paths remain unknown rather than copied.
    const configuration = projectNativeComposeReview({ services: { [composeService]: {
        deploy: { replicas: selected.length }, restart: policy?.Name,
        cpus: typeof host.NanoCpus === 'number' && host.NanoCpus > 0 ? host.NanoCpus / 1_000_000_000 : undefined,
        mem_limit: typeof host.Memory === 'number' && host.Memory > 0 ? host.Memory : undefined,
        ...(healthcheck ? { healthcheck: { disable: Array.isArray(healthcheck.Test) && healthcheck.Test[0] === 'NONE' } } : {}),
        volumes: Array.isArray(first.Mounts) ? first.Mounts.filter(record).map(mount => ({
            type: mount.Type, read_only: mount.RW === false,
        })) : [],
    } } }, target.sourcePath, value => value).services[0];
    return configuration ? { ...configuration, ports } : undefined;
}

/** Read-only discovery shared by cold logs and retained deployment observations.
 * Labels route native facts; the caller supplies retained definition/source custody. */
export async function readColdNativeComposeTargetsForHost(input: Readonly<{
    deploymentRoot: string;
    environmentId: string;
    environmentInstanceId: string;
    projectName: string;
    composeServices: readonly string[];
    deploymentId?: string;
    run(args: readonly string[]): Promise<Readonly<{ exitCode: number | null; stdout: string }>>;
}>): Promise<readonly (ColdTarget | null)[] | null> {
    const listed = await input.run(['ps', '--all', '--no-trunc', '--filter', `label=com.docker.compose.project=${input.projectName}`,
        ...(input.composeServices.length === 1 ? ['--filter', `label=com.docker.compose.service=${input.composeServices[0]}`] : []),
        '--format', '{{.ID}}']);
    const ids = listed.stdout.trim().split('\n').filter(Boolean);
    if (listed.exitCode !== 0 || ids.some(id => !/^[a-f0-9]{64}$/u.test(id)) || new Set(ids).size !== ids.length) return null;
    if (!ids.length) return input.composeServices.map(() => null);
    const inspected = await input.run(['inspect', '--type', 'container', ...ids]);
    if (inspected.exitCode !== 0) return null;
    let rows: unknown;
    try { rows = JSON.parse(inspected.stdout); } catch { return null; }
    if (!Array.isArray(rows)) return null;
    const inspectedRows: readonly unknown[] = rows;
    const targets = input.composeServices.map(composeService => {
        const target = readNativeComposeLogTargetForHost({ ...input, stdout: inspected.stdout, composeService });
        return target ? { ...target, configuration: readColdConfiguration(inspectedRows, target, composeService) } : null;
    });
    if (targets.some(target => target?.containerIds.some(id => !ids.includes(id)))) return null;
    return targets;
}
