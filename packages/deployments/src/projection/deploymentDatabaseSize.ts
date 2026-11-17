import type { DeploymentEnvironmentContentV1, DeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/v1';
import { DatabaseOperationResultV1Schema, type DatabaseDescriptorV1, type DatabaseReadStatementInputV1,
    type DatabaseTargetsListResultV1 } from '@happier-dev/database-protocol';
import { compileDatabaseSizeV1, statsNativeRowsV1, type DatabaseStatsNativeRowV1 } from '@happier-dev/databases/size';
import type { DeploymentDatabaseSizeV1 } from '@happier-dev/protocol/deployments/deploymentReadsV1';

/** Page measurements consume host-owned targets and the dialect owner's size plan. */
export async function readDeploymentDatabaseSizesV1(input: Readonly<{
    environment: DeploymentEnvironmentHeaderV1; content: DeploymentEnvironmentContentV1;
    readTargets(): Promise<DatabaseTargetsListResultV1>;
    run(input: DatabaseReadStatementInputV1, placement: DatabaseDescriptorV1['placement']): Promise<unknown>;
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
        const operation = { kind: 'stats.read', group: 'size', selection: {} } as const;
        const plan = descriptor.engine === 'postgresql' || descriptor.engine === 'mysql'
            ? compileDatabaseSizeV1(descriptor.engine, operation) : null;
        if (!plan || plan.status === 'unavailable') { result.push(unavailable(plan?.reason ?? 'unsupported_engine')); continue; }
        const resultSets: (readonly DatabaseStatsNativeRowV1[])[] = [];
        let refusal: string | undefined;
        for (const statement of plan.statements) {
            let raw: unknown;
            try {
                raw = await input.run({ operation: 'statement.run', mode: 'read', target, statement: {
                    sql: statement.sql, parameters: statement.parameters.map(value => typeof value === 'string'
                        ? { type: 'text' as const, value } : { type: 'float' as const, value }),
                } }, descriptor.placement);
            } catch (error) {
                refusal = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'database_size_read_failed';
                break;
            }
            const parsed = DatabaseOperationResultV1Schema.safeParse(raw);
            if (!parsed.success) { refusal = 'invalid_size_result'; break; }
            const query = parsed.data;
            if (!query.ok) { refusal = query.code; break; }
            if (query.operation !== 'statement.run') { refusal = 'invalid_size_result'; break; }
            if (query.completeness?.complete === false || query.results.some(row => !row.completeness.complete)) {
                refusal = 'incomplete_size_result'; break;
            }
            const frame = query.results[0];
            if (query.results.length !== 1 || !frame || frame.rows.length !== 1
                || frame.columns.filter(column => column.name === 'size_bytes').length !== 1) {
                refusal = 'invalid_size_result'; break;
            }
            // Both dialect size plans cast their counters to text; the stats decoder owns numeric validation.
            resultSets.push(statsNativeRowsV1(frame.columns, frame.rows.map(row => row.cells.map(cell => cell.type === 'text' ? cell.value : null))));
        }
        if (refusal) { result.push(unavailable(refusal)); continue; }
        const observedAtMs = (input.now ?? Date.now)();
        try {
            const observation = plan.decode(resultSets, { observedAtMs, database: target.database,
                intervalBasis: { bindingKey: JSON.stringify(target), databaseIdentity: target.database, selectionKey: 'size' } });
            if (observation.status !== 'available' || observation.group !== 'size') { result.push(unavailable('invalid_size_result')); continue; }
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
        } catch { result.push(unavailable('invalid_size_result')); }
    }
    return result;
}
