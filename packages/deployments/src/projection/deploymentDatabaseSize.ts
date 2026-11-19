import type { DeploymentEnvironmentContentV1, DeploymentEnvironmentHeaderV1 } from '@happier-dev/deployments/contracts/v1';
import {
    DatabaseOperationResultV1Schema,
    type DatabaseDescriptorV1,
    type DatabaseStatsOperationInputV1,
    type DatabaseTargetsListResultV1,
} from '@happier-dev/plugin-sdk/database';
import type { DeploymentDatabaseSizeV1 } from '@happier-dev/protocol/deployments/deploymentReadsV1';

/** Page measurements consume the shared operation owner's typed size observation. */
export async function readDeploymentDatabaseSizesV1(input: Readonly<{
    environment: DeploymentEnvironmentHeaderV1; content: DeploymentEnvironmentContentV1;
    readTargets(): Promise<DatabaseTargetsListResultV1>;
    run(input: DatabaseStatsOperationInputV1, placement: DatabaseDescriptorV1['placement']): Promise<unknown>;
    previous?: readonly DeploymentDatabaseSizeV1[] | undefined; now?: () => number;
}>): Promise<readonly DeploymentDatabaseSizeV1[]> {
    let targets: Promise<DatabaseTargetsListResultV1> | undefined;
    const previous = new Map(input.previous?.map(row => [row.service, row]));
    const result: DeploymentDatabaseSizeV1[] = [];
    for (const data of input.content.template?.data ?? []) {
        const unavailable = (reason: string): DeploymentDatabaseSizeV1 => ({ service: data.service,
            size: { status: 'unavailable', reason }, growth: { status: 'unavailable', reason } });
        if (data.engine !== 'postgres' && data.engine !== 'mysql') { result.push(unavailable('unsupported_engine')); continue; }
        let listed: DatabaseTargetsListResultV1;
        try { listed = await (targets ??= input.readTargets()); } catch (error) {
            const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'database_placement_read_failed';
            result.push(unavailable(code)); continue;
        }
        const descriptor = listed.targets.find(({ target }) => target.kind === 'deployment_service'
            && target.environment.serverId === input.environment.serverId
            && target.environment.projectSourceId === input.environment.projectSourceId
            && target.environment.environmentId === input.environment.id
            && target.targetLinkId === input.environment.runtimeTargetLinkId && target.serviceId === data.service);
        const target = descriptor?.target;
        if (!descriptor || target?.kind !== 'deployment_service') { result.push(unavailable('active_deployment_required')); continue; }
        let raw: unknown;
        try { raw = await input.run({ operation: 'stats.read', target,
            request: { kind: 'stats.read', group: 'size', selection: {} } }, descriptor.placement); }
        catch (error) {
            result.push(unavailable(error instanceof Error && 'code' in error && typeof error.code === 'string'
                ? error.code : 'database_size_read_failed')); continue;
        }
        const parsed = DatabaseOperationResultV1Schema.safeParse(raw);
        if (!parsed.success) { result.push(unavailable('invalid_size_result')); continue; }
        const query = parsed.data;
        if (!query.ok) { result.push(unavailable(query.code)); continue; }
        if (query.operation !== 'stats.read' || query.observation.group !== 'size') { result.push(unavailable('invalid_size_result')); continue; }
        const observation = query.observation;
        if (observation.status === 'unavailable') { result.push(unavailable(observation.reason)); continue; }
        if (!observation.completeness.complete || observation.coverage.status !== 'complete') {
            result.push(unavailable('incomplete_size_result')); continue;
        }
        const observedAtMs = input.now ? input.now() : observation.observedAtMs;
        const bytes = Number(observation.data.bytes);
        if (!Number.isSafeInteger(bytes) || bytes < 0 || observation.data.measurement === 'page_allocation') {
            result.push(unavailable('invalid_size_result')); continue;
        }
        const prior = previous.get(data.service);
        const comparable = prior?.deploymentId === target.deploymentId && prior.size.status === 'available'
            && prior.size.observedAtMs < observedAtMs ? prior.size : null;
        result.push({ service: data.service, deploymentId: target.deploymentId,
            size: { status: 'available', bytes, measurement: observation.data.measurement, observedAtMs },
            growth: comparable ? { status: 'available', bytes: bytes - comparable.bytes, fromMs: comparable.observedAtMs, toMs: observedAtMs }
                : { status: 'unavailable', reason: 'previous_sample_required' } });
    }
    return result;
}
