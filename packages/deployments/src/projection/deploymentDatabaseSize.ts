import type { DeploymentEnvironmentContentV1, DeploymentEnvironmentHeaderV1, DeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/v1';
import { DeploymentDataQueryResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { DeploymentDataQueryInputV1, DeploymentDatabaseSizeV1 } from '@happier-dev/protocol/deployments/deploymentReadsV1';

/** One input/measurement owner over the existing credential-scoped native query Action.
 * No admin credential, bootstrap, polling or persisted history is acquired here. */
export async function readDeploymentDatabaseSizesV1(input: Readonly<{
    environment: DeploymentEnvironmentHeaderV1; content: DeploymentEnvironmentContentV1;
    readTargetLinks(): Promise<readonly DeploymentTargetLinkHeaderV1[]>;
    run(input: DeploymentDataQueryInputV1): Promise<unknown>;
    previous?: readonly DeploymentDatabaseSizeV1[] | undefined; now?: () => number;
}>): Promise<readonly DeploymentDatabaseSizeV1[]> {
    let placement: Promise<readonly DeploymentTargetLinkHeaderV1[]> | undefined;
    const previous = new Map(input.previous?.map(row => [row.service, row]));
    const result: DeploymentDatabaseSizeV1[] = [];
    for (const data of input.content.template?.data ?? []) {
        const unavailable = (reason: string): DeploymentDatabaseSizeV1 => ({ service: data.service,
            size: { status: 'unavailable', reason }, growth: { status: 'unavailable', reason } });
        const sql = data.engine === 'postgres'
            ? 'SELECT pg_database_size(current_database()) AS size_bytes'
            : data.engine === 'mysql' ? 'SELECT COALESCE(SUM(data_length + index_length), 0) AS size_bytes FROM information_schema.tables WHERE table_schema = DATABASE()'
            : null;
        if (!sql) { result.push(unavailable('unsupported_engine')); continue; }
        let links: readonly DeploymentTargetLinkHeaderV1[];
        try { links = await (placement ??= input.readTargetLinks()); } catch (error) {
            const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'database_placement_read_failed';
            result.push(unavailable(code)); continue;
        }
        const link = links.find(row => row.id === input.environment.runtimeTargetLinkId);
        const member = link?.members.find(row => row.machineId === input.environment.controllerMachineId) ?? link?.members[0];
        if (link?.targetKind !== 'ownServer' || !link.activeDeploymentId || !member) {
            result.push(unavailable('active_deployment_required')); continue;
        }
        let raw: unknown;
        try {
            raw = await input.run({ serverId: input.environment.serverId, environmentId: input.environment.id,
                expectedRevision: input.environment.revision, targetLinkId: link.id, deploymentId: link.activeDeploymentId,
                machineId: member.machineId, installationId: member.installationId, service: data.service, sql, params: {} });
        } catch (error) {
            const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'database_size_read_failed';
            result.push(unavailable(code)); continue;
        }
        const parsed = DeploymentDataQueryResultV1Schema.safeParse(raw);
        if (!parsed.success) { result.push(unavailable('invalid_size_result')); continue; }
        const query = parsed.data;
        if (!query.ok) { result.push(unavailable('diagnostic' in query && query.diagnostic && 'code' in query.diagnostic ? query.diagnostic.code : query.error)); continue; }
        if (!query.complete) { result.push(unavailable('incomplete_size_result')); continue; }
        const cell = query.rows[0]?.[0];
        const bytes = typeof cell === 'number' ? cell : typeof cell === 'string' && /^\d+$/.test(cell) ? Number(cell) : NaN;
        if (query.columns.length !== 1 || query.columns[0]?.name !== 'size_bytes' || query.rows.length !== 1
            || !Number.isSafeInteger(bytes) || bytes < 0) { result.push(unavailable('invalid_size_result')); continue; }
        const observedAtMs = (input.now ?? Date.now)();
        const prior = previous.get(data.service);
        const comparable = prior?.deploymentId === link.activeDeploymentId && prior.size.status === 'available'
            && prior.size.observedAtMs < observedAtMs ? prior.size : null;
        result.push({ service: data.service, deploymentId: link.activeDeploymentId,
            size: { status: 'available', bytes, measurement: data.engine === 'mysql' ? 'table_bytes_estimate' : 'database_bytes', observedAtMs },
            growth: comparable ? { status: 'available', bytes: bytes - comparable.bytes, fromMs: comparable.observedAtMs, toMs: observedAtMs }
                : { status: 'unavailable', reason: 'previous_sample_required' } });
    }
    return result;
}
