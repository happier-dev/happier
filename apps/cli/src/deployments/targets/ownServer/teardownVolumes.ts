import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { withActionFailureCauseDiagnostic } from '@happier-dev/protocol/actions/executor/actionFailureDiagnostic';
import type { DeploymentEnvironmentDetailV1, DeploymentTeardownResourceV1 } from '@happier-dev/deployment-protocol';
import { DeploymentPreviewCleanupV1Schema, type DeploymentPreviewCleanupV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { NativeComposeActivatedProject, NativeComposeProjectRender } from '@/daemon/local/services/launch/nativeComposeLifecycle';
import { readNativeComposeProjectVolumeNames, selectNativeComposePreviewVolumeNames, settleNativeComposeVolumeRemoval } from '@/daemon/local/services/launch/nativeComposeVolumes';

export type TeardownNativeRun = Parameters<typeof readNativeComposeProjectVolumeNames>[0]['run'];

export function isOwnServerPreviewDataEnvironment(environment: DeploymentEnvironmentDetailV1['environment']): boolean {
    return environment.purpose === 'preview' || environment.previewCompanionOfEnvironmentId !== undefined;
}

/** Compose labels, rather than caller supplied names or prefixes, own native volume membership. */
export async function readOwnServerTeardownVolumes(input: Readonly<{
    projects: Iterable<string>; machineId: string; run: TeardownNativeRun;
    activatedVolumes?: readonly string[];
}>): Promise<DeploymentTeardownResourceV1[]> {
    const names = await readNativeComposeProjectVolumeNames(input);
    return names.map(id => ({ id, kind: 'data', machineId: input.machineId, ownership: 'owned', disposition: 'retain' }));
}

/** Capture only mounted named PostgreSQL data from this preview's admitted provision. */
export async function readOwnServerPreviewCleanup(input: Readonly<{
    environment: DeploymentEnvironmentDetailV1;
    services?: readonly string[];
    render: Pick<NativeComposeProjectRender, 'projectName' | 'review'> & Partial<Pick<NativeComposeProjectRender, 'namedVolumes'>>;
    activation: Pick<NativeComposeActivatedProject, 'nativeIdsForService'>;
    machineId: string;
    run: TeardownNativeRun;
}>): Promise<DeploymentPreviewCleanupV1 | undefined> {
    const dataServices = new Set(input.environment.content.template?.data?.filter(data => data.engine === 'postgres').map(data => data.service));
    if (!isOwnServerPreviewDataEnvironment(input.environment.environment) || !input.services?.length
        || input.services.length !== dataServices.size || !input.services.every(service => dataServices.has(service))) return undefined;
    const dataTargets = new Map(input.services.map(service => [service,
        new Set(input.environment.content.template?.volumes?.filter(volume => volume.service === service && volume.persistent)
            .map(volume => volume.target))]));
    const targets = input.render.review.services.filter(service => dataServices.has(service.name)).flatMap(service =>
        service.mounts.flatMap(mount => mount.type === 'volume' && mount.source && mount.target && !mount.readOnly
            && dataTargets.get(service.name)?.has(mount.target)
            ? [{ service: service.name, target: mount.target }] : []));
    const expected = new Map(input.services.flatMap(service => input.activation.nativeIdsForService(service).map(id => [id, service] as const)));
    const unavailable = (): never => { throw createActionExecuteFailureError({ ok: false, errorCode: 'volume_observation_unavailable', error: 'volume_observation_unavailable' }); };
    if (!expected.size) return unavailable();
    const inspected = await input.run(['inspect', '--type', 'container', ...expected.keys()]);
    if (inspected.exitCode !== 0) return unavailable();
    let rows: unknown;
    try { rows = JSON.parse(inspected.stdout); }
    catch (error) { throw withActionFailureCauseDiagnostic(createActionExecuteFailureError({ ok: false,
        errorCode: 'volume_observation_unavailable', error: 'volume_observation_unavailable' }),
        error, 'deployment.teardown.preview_volume_parse'); }
    const ownedNames = await readNativeComposeProjectVolumeNames({ projects: [input.render.projectName], run: input.run,
        activatedVolumes: input.render.namedVolumes?.map(binding => binding.physicalName) });
    const names = selectNativeComposePreviewVolumeNames({ projectName: input.render.projectName, targets, expected, observations: rows, ownedNames });
    return DeploymentPreviewCleanupV1Schema.parse({ machines: [input.machineId], volumes: names
        .map(name => ({ name, disposition: 'delete', confirmation: name })) });
}

export async function observeOwnServerTeardownVolumes(input: Readonly<{
    resources: readonly DeploymentTeardownResourceV1[]; run: TeardownNativeRun;
}>): Promise<'needed' | 'proved'> {
    const removed = input.resources.filter(resource => resource.kind === 'data' && resource.disposition === 'remove');
    if (!removed.length) return 'proved';
    const listed = await input.run(['volume', 'ls', '--format', '{{.Name}}']);
    if (listed.exitCode !== 0) throw createActionExecuteFailureError({ ok: false, errorCode: 'volume_observation_unavailable', error: 'volume_observation_unavailable' });
    const present = new Set(listed.stdout.trim().split('\n'));
    return removed.some(resource => present.has(resource.id)) ? 'needed' : 'proved';
}

export async function settleOwnServerTeardownVolumes(input: Readonly<{
    resources: readonly DeploymentTeardownResourceV1[]; run: TeardownNativeRun;
}>): Promise<Readonly<{ kind: 'failed'; reason: 'volume_removal_failed' }> | null> {
    return settleNativeComposeVolumeRemoval({ names: input.resources.filter(resource => resource.kind === 'data'
        && resource.disposition === 'remove').map(resource => resource.id), run: input.run });
}
