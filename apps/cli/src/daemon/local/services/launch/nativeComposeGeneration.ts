import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { DeploymentImageV1 } from '@happier-dev/deployment-protocol';
import { captureNativeComposeConfiguration, type NativeComposeConfigurationMatcher } from './nativeComposeConfiguration';
import type { NativeComposeRoutingGeneration } from './nativeComposeStartFirst';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const refuse = (reason: string): never => { throw new PluginError({ code: 'native_failed',
    message: 'Native Compose operation could not be completed', details: { reason } }); };
type Container = Record<string, unknown> & { Id: string; RestartCount: number };

/** Native Compose's successful-init condition is also used when selecting the
 * readiness-only wait after the complete project's dependency start. */
export function nativeComposeCompletedServices(model: Record<string, unknown>): ReadonlySet<string> {
    const completed = new Set<string>();
    const requiresRunning = new Set<string>();
    if (record(model.services)) for (const service of Object.values(model.services)) {
        if (!record(service) || !record(service.depends_on)) continue;
        for (const [dependency, requirement] of Object.entries(service.depends_on)) {
            if (record(requirement) && requirement.condition === 'service_completed_successfully') completed.add(dependency);
            else requiresRunning.add(dependency);
        }
    }
    return new Set([...completed].filter(service => !requiresRunning.has(service)));
}

/** One native snapshot/baseline owner for activation and subsequent generation observations. */
export function createNativeComposeGenerationProof(input: Readonly<{
    projectName: string;
    run(args: readonly string[], signal?: AbortSignal): Promise<Readonly<{ stdout: string }>>;
    pin(service: string): DeploymentImageV1;
}>) {
    let baseline: ReadonlyMap<string, number> | undefined;
    const read = async (signal?: AbortSignal) => {
        const ids = (await input.run(['ps', '--all', '--no-trunc', '--filter',
            `label=com.docker.compose.project=${input.projectName}`, '--format', '{{.ID}}'], signal)).stdout.trim().split('\n').filter(Boolean);
        if (ids.some(id => !/^[a-f0-9]{64}$/u.test(id)) || new Set(ids).size !== ids.length) return refuse('deployment_generation_unavailable');
        if (!ids.length) return { ids, rows: [] as Container[] };
        const observed: unknown = JSON.parse((await input.run(['inspect', '--type', 'container', ...ids], signal)).stdout);
        if (!Array.isArray(observed) || observed.length !== ids.length) return refuse('deployment_generation_unavailable');
        const selectedIds = new Set(ids);
        const rows: Container[] = [];
        for (const row of observed) {
            if (!record(row) || typeof row.Id !== 'string' || !selectedIds.delete(row.Id)
                || typeof row.RestartCount !== 'number' || !Number.isSafeInteger(row.RestartCount) || row.RestartCount < 0
                || !record(row.Config) || !record(row.Config.Labels)
                || row.Config.Labels['com.docker.compose.project'] !== input.projectName) return refuse('deployment_generation_unavailable');
            rows.push({ ...row, Id: row.Id, RestartCount: row.RestartCount });
        }
        return { ids, rows };
    };
    return {
        snapshot: read,
        async captureBaseline(signal?: AbortSignal) {
            const snapshot = await read(signal);
            baseline = new Map(snapshot.rows.map(row => [row.Id, row.RestartCount]));
            return snapshot.ids;
        },
        async inspect(current: Readonly<{ services: readonly string[]; healthServices: readonly string[]; model: Record<string, unknown>;
            proveImage(reference: string, image: DeploymentImageV1): Promise<unknown>; signal?: AbortSignal;
            /** Losing-generation identity for witnessed retirement, never readiness. */
            purpose?: 'retire';
            snapshot?: Awaited<ReturnType<typeof read>> }>) {
            const retiring = current.purpose === 'retire';
            const { rows } = current.snapshot ?? await read(current.signal);
            // A recovered read-only observation starts at its first native
            // snapshot. Activation instead captures BEFORE up, including empty.
            baseline ??= new Map(rows.map(row => [row.Id, row.RestartCount]));
            const byService = new Map<string, Container[]>();
            for (const row of rows) {
                const labels = record(row.Config) && record(row.Config.Labels) ? row.Config.Labels : {};
                const service = labels['com.docker.compose.service'];
                if (typeof service === 'string') {
                    const group = byService.get(service) ?? [];
                    group.push(row);
                    byService.set(service, group);
                }
            }
            const completed = nativeComposeCompletedServices(current.model);
            const participants = new Set(current.healthServices);
            const serviceNativeIds = new Map<string, readonly string[]>();
            const serviceContainerImages = new Map<string, readonly Readonly<{ id: string; nativeImageId: string; imageConfigDigest: string;
                configurationMatches: NativeComposeConfigurationMatcher }>[]>();
            let health: 'healthy' | 'unverified' = !retiring && participants.size ? 'healthy' : 'unverified';
            for (const service of current.services) {
                const containers = byService.get(service);
                if (!containers?.length) return refuse('deployment_generation_unavailable');
                const containerImages: { id: string; nativeImageId: string; imageConfigDigest: string;
                    configurationMatches: NativeComposeConfigurationMatcher }[] = [];
                const init = completed.has(service);
                for (const row of containers) {
                    if (!record(row.State) || typeof row.Image !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(row.Image)
                        || !retiring && row.RestartCount !== (baseline.get(row.Id) ?? 0)) return refuse('deployment_activation_failed');
                    const finished = init && row.State.Status === 'exited' && row.State.ExitCode === 0;
                    if (!retiring && !finished && (init || row.State.Status !== 'running'
                        || participants.has(service) && record(row.State.Health) && row.State.Health.Status !== 'healthy')) return refuse('deployment_activation_failed');
                    if (participants.has(service) && !finished && !record(row.State.Health)) health = 'unverified';
                    const image = input.pin(service);
                    await current.proveImage(row.Image, image);
                    containerImages.push({ id: row.Id, nativeImageId: row.Image, imageConfigDigest: image.configDigest,
                        configurationMatches: captureNativeComposeConfiguration(row.Config, row.HostConfig) });
                }
                serviceContainerImages.set(service, Object.freeze(containerImages));
                serviceNativeIds.set(service, Object.freeze(containers.map(row => row.Id)));
            }
            const routingServices = (): NativeComposeRoutingGeneration['services'] => current.services.map(service => {
                const containers = byService.get(service)!;
                const definition = record(current.model.services) ? current.model.services[service] : undefined;
                const deploy = record(definition) && record(definition.deploy) ? definition.deploy : undefined;
                const count = record(definition) ? definition.scale ?? deploy?.replicas ?? 1 : undefined;
                if (containers.length !== count) return refuse('deployment_generation_unavailable');
                return { service, stopGracePeriodSeconds: record(containers[0]!.Config)
                    && typeof containers[0]!.Config.StopTimeout === 'number' ? containers[0]!.Config.StopTimeout : undefined,
                    replicas: containers.map(row => {
                        if (typeof row.Name !== 'string' || !row.Name.startsWith('/')
                            || !record(row.NetworkSettings) || !record(row.NetworkSettings.Networks)) return refuse('deployment_generation_unavailable');
                        return { id: row.Id, name: row.Name.slice(1), networks: Object.keys(row.NetworkSettings.Networks) };
                    }) };
            });
            return { serviceNativeIds, serviceContainerImages, health, routingServices };
        },
    };
}
