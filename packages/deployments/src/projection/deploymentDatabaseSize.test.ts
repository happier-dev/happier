import { describe, expect, it, vi } from 'vitest';
import type { DeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/v1';
import type {
    DatabaseDescriptorV1,
    DatabaseStatsOperationInputV1,
    DatabaseTargetsListResultV1,
} from '@happier-dev/plugin-sdk/database';
import { readDeploymentDatabaseSizesV1 } from './deploymentDatabaseSize.js';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';

const detail = (): DeploymentEnvironmentDetailV1 => {
    const value = createDeploymentEnvironmentDetailV1();
    return { ...value, environment: { ...value.environment, runtimeTargetLinkId: value.targetLinks[0]!.targetLink.id },
        content: { ...value.content, template: {
            templateRef: { sourceId: 'catalog', itemId: 'postgres', version: '1', ref: { kind: 'version', version: '1' } },
            definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` }, services: ['postgres', 'redis'],
            data: [{ service: 'postgres', engine: 'postgres' }, { service: 'redis', engine: 'redis' }] } } };
};
function descriptor(value: DeploymentEnvironmentDetailV1, serviceId = 'postgres', deploymentId = 'deploy-a'): DatabaseDescriptorV1 {
    return { target: { kind: 'deployment_service', environment: { serverId: value.environment.serverId,
        projectSourceId: value.environment.projectSourceId, environmentId: value.environment.id },
        targetLinkId: value.environment.runtimeTargetLinkId!, deploymentId, serviceId, database: 'receipt-database' },
        engine: serviceId === 'mysql' ? 'mysql' : 'postgresql', label: serviceId, origin: { label: 'Active deployment' },
        placement: { serverId: value.environment.serverId, accountId: 'account', machineId: 'member', installationId: 'installation' }, capabilities: [] };
}
const listed = (...targets: DatabaseDescriptorV1[]): DatabaseTargetsListResultV1 => ({ targets, completeness: { complete: true } });
const statementResult = (value: string | null, mysql = false) => ({ ok: true, operation: 'stats.read', observation: {
    v: 1, observedAtMs: 1, engineId: mysql ? 'mysql' : 'postgresql', scope: { database: 'receipt-database' },
    intervalBasis: { bindingKey: 'selected', databaseIdentity: 'receipt-database', selectionKey: 'size' },
    status: 'available', group: 'size', coverage: { status: 'complete' }, completeness: { complete: true },
    data: { bytes: value, measurement: mysql ? 'table_bytes_estimate' : 'database_bytes' },
} });

describe('database engine size read', () => {
    it('does no target or engine work for unsupported services and decodes the canonical MySQL size projection including zero', async () => {
        const value = detail();
        const readTargets = vi.fn(async () => listed(descriptor(value, 'mysql')));
        const run = vi.fn(async (_input: DatabaseStatsOperationInputV1) => statementResult('0', true));
        const content: DeploymentEnvironmentDetailV1['content'] = { ...value.content, template: { ...value.content.template!,
            services: ['cache'], data: [{ service: 'cache', engine: 'redis' }] } };
        expect(await readDeploymentDatabaseSizesV1({ environment: value.environment, content, readTargets, run }))
            .toMatchObject([{ size: { status: 'unavailable', reason: 'unsupported_engine' } }]);
        expect(readTargets).not.toHaveBeenCalled();
        expect(run).not.toHaveBeenCalled();
        const mysql = await readDeploymentDatabaseSizesV1({ environment: value.environment,
            content: { ...content, template: { ...value.content.template!, data: [{ service: 'mysql', engine: 'mysql' }] } }, readTargets, run });
        expect(mysql[0]?.size).toMatchObject({ status: 'available', bytes: 0, measurement: 'table_bytes_estimate' });
        expect(readTargets).toHaveBeenCalledTimes(1);
        expect(run).toHaveBeenCalledTimes(1);
        expect(run.mock.calls[0]?.[0]).toMatchObject({ operation: 'stats.read', request: { kind: 'stats.read', group: 'size', selection: {} } });
    });
    it('uses the active host descriptor and its placement, excludes neighbouring targets and compares only the same deployment', async () => {
        const value = detail();
        const selected = descriptor(value);
        const other = descriptor(value);
        if (other.target.kind !== 'deployment_service') throw new Error('Expected native descriptor');
        const neighbours: DatabaseDescriptorV1[] = [
            { ...other, target: { ...other.target, targetLinkId: 'other-link', database: 'wrong-link-database' } },
            { ...other, target: { ...other.target, environment: { ...other.target.environment, environmentId: 'other-environment' } } },
            { ...other, target: { ...other.target, serviceId: 'other-service' } },
        ];
        const readTargets = async () => listed(...neighbours, selected);
        const run = vi.fn(async (_input: DatabaseStatsOperationInputV1, _placement: DatabaseDescriptorV1['placement']) => statementResult('4096'));
        const first = await readDeploymentDatabaseSizesV1({ environment: value.environment, content: value.content, readTargets, run, now: () => 1000 });
        expect(first).toMatchObject([{ service: 'postgres', deploymentId: 'deploy-a', size: { status: 'available', bytes: 4096 },
            growth: { status: 'unavailable', reason: 'previous_sample_required' } },
            { service: 'redis', size: { status: 'unavailable', reason: 'unsupported_engine' } }]);
        expect(run.mock.calls[0]).toEqual([expect.objectContaining({ target: selected.target }), selected.placement]);
        run.mockResolvedValueOnce(statementResult('3072'));
        const second = await readDeploymentDatabaseSizesV1({ environment: value.environment, content: value.content, readTargets, run, now: () => 2000, previous: first });
        expect(second[0]?.growth).toEqual({ status: 'available', bytes: -1024, fromMs: 1000, toMs: 2000 });
        const replaced = await readDeploymentDatabaseSizesV1({ environment: value.environment, content: value.content,
            readTargets: async () => listed(descriptor(value, 'postgres', 'deploy-b')), run, now: () => 3000, previous: second });
        expect(replaced[0]?.growth).toEqual({ status: 'unavailable', reason: 'previous_sample_required' });
    });
    it('preserves semantic refusals and rejects incomplete, missing and unsafe sizes without fabricating zero', async () => {
        const value = detail();
        const incomplete = statementResult('12');
        const observation = incomplete.observation;
        for (const [result, reason] of [
            [{ ok: false, status: 'unavailable', code: 'read_role_setup_required', reason: 'Configure the reader' }, 'read_role_setup_required'],
            [{ ...incomplete, observation: { ...observation, completeness: { complete: false, reason: 'response_envelope' } } }, 'incomplete_size_result'],
            [{ ...incomplete, observation: { ...observation, coverage: { status: 'partial', reasons: ['visibility_restricted'] } } }, 'incomplete_size_result'],
            [statementResult(null), 'invalid_size_result'],
            [statementResult('9007199254740992'), 'invalid_size_result'],
            [{ ...incomplete, observation: { ...observation, status: 'unavailable', reason: 'visibility_restricted', data: undefined,
                completeness: undefined, coverage: undefined } }, 'invalid_size_result'],
        ] as const) {
            const rows = await readDeploymentDatabaseSizesV1({ environment: value.environment, content: value.content,
                readTargets: async () => listed(descriptor(value)), run: async () => result });
            expect(rows[0]?.size).toEqual({ status: 'unavailable', reason });
        }
        const run = vi.fn();
        const missing = await readDeploymentDatabaseSizesV1({ environment: value.environment, content: value.content,
            readTargets: async () => listed(), run });
        expect(missing[0]?.size).toEqual({ status: 'unavailable', reason: 'active_deployment_required' });
        expect(run).not.toHaveBeenCalled();
    });
});
