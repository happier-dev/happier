import { describe, expect, it, vi } from 'vitest';
import type { DeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/v1';
import type { DeploymentDataQueryInputV1 } from '@happier-dev/protocol/deployments/deploymentReadsV1';
import { readDeploymentDatabaseSizesV1 } from './deploymentDatabaseSize.js';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';

const detail = (): DeploymentEnvironmentDetailV1 => {
    const value = createDeploymentEnvironmentDetailV1();
    return { ...value, content: { ...value.content, template: { ...value.content.template!,
        services: ['postgres', 'redis'], data: [{ service: 'postgres', engine: 'postgres' }, { service: 'redis', engine: 'redis' }] } } };
};
describe('database engine size read', () => {
    it('does no placement or engine work for unsupported services and issues one MySQL catalog query when supported', async () => {
        const value = detail();
        const link = value.targetLinks[0]!.targetLink;
        const readTargetLinks = vi.fn(async () => [{ ...link, targetKind: 'ownServer' as const }]);
        const run = vi.fn(async (_input: DeploymentDataQueryInputV1) => ({ ok: true,
            columns: [{ name: 'size_bytes' }], rows: [[0]], complete: true }));
        const content: DeploymentEnvironmentDetailV1['content'] = { ...value.content, template: { ...value.content.template!,
            services: ['cache'], data: [{ service: 'cache', engine: 'redis' }] } };
        expect(await readDeploymentDatabaseSizesV1({ environment: value.environment, content, readTargetLinks, run }))
            .toMatchObject([{ size: { status: 'unavailable', reason: 'unsupported_engine' } }]);
        expect(readTargetLinks).not.toHaveBeenCalled();
        expect(run).not.toHaveBeenCalled();
        const mysql = await readDeploymentDatabaseSizesV1({ environment: value.environment,
            content: { ...content, template: { ...value.content.template!, data: [{ service: 'mysql', engine: 'mysql' }] } }, readTargetLinks, run });
        expect(mysql[0]?.size).toMatchObject({ status: 'available', bytes: 0 });
        expect(readTargetLinks).toHaveBeenCalledTimes(1);
        expect(run).toHaveBeenCalledTimes(1);
        expect(run.mock.calls[0]?.[0]?.sql).toContain('information_schema.tables');
    });
    it('reads supported databases once, keeps unsupported engines explicit and computes growth only between matching samples', async () => {
        const value = detail();
        const link = value.targetLinks[0]!.targetLink;
        const environment = { ...value.environment, runtimeTargetLinkId: link.id };
        const targetLinks = [{ ...link, targetKind: 'ownServer' as const, activeDeploymentId: 'deploy-a',
            members: [{ machineId: 'machine', installationId: 'installation' }] }];
        const run = vi.fn(async (_input: DeploymentDataQueryInputV1) => ({ ok: true, columns: [{ name: 'size_bytes' }], rows: [['4096']], complete: true }));
        const first = await readDeploymentDatabaseSizesV1({ environment, content: value.content, readTargetLinks: async () => targetLinks, run, now: () => 1000 });
        expect(first).toMatchObject([{ service: 'postgres', size: { status: 'available', bytes: 4096 },
            growth: { status: 'unavailable', reason: 'previous_sample_required' } },
            { service: 'redis', size: { status: 'unavailable', reason: 'unsupported_engine' } }]);
        run.mockResolvedValueOnce({ ok: true, columns: [{ name: 'size_bytes' }], rows: [['3072']], complete: true });
        const second = await readDeploymentDatabaseSizesV1({ environment, content: value.content, readTargetLinks: async () => targetLinks, run, now: () => 2000, previous: first });
        expect(second[0]?.growth).toEqual({ status: 'available', bytes: -1024, fromMs: 1000, toMs: 2000 });
        expect(run).toHaveBeenCalledTimes(2);
        expect(run.mock.calls[0]?.[0]).toMatchObject({ sql: 'SELECT pg_database_size(current_database()) AS size_bytes', params: {}, service: 'postgres' });
        const replaced = await readDeploymentDatabaseSizesV1({ environment, content: value.content,
            readTargetLinks: async () => [{ ...targetLinks[0]!, activeDeploymentId: 'deploy-b' }], run, now: () => 3000, previous: second });
        expect(replaced[0]?.growth.status).toBe('unavailable');
    });
    it('preserves query refusal and rejects incomplete or invalid sizes without fabricating zero', async () => {
        const value = detail();
        const link = value.targetLinks[0]!.targetLink;
        const environment = { ...value.environment, runtimeTargetLinkId: link.id };
        const targetLinks = [{ ...link, targetKind: 'ownServer' as const, activeDeploymentId: 'deploy', members: [{ machineId: 'machine', installationId: 'installation' }] }];
        for (const [result, reason] of [
            [{ ok: false, error: 'deployment_unavailable', diagnostic: { code: 'read_role_setup_required' } }, 'read_role_setup_required'],
            [{ ok: true, columns: [{ name: 'size_bytes' }], rows: [['12']], complete: false }, 'incomplete_size_result'],
            [{ ok: true, columns: [{ name: 'size_bytes' }], rows: [[null]], complete: true }, 'invalid_size_result'],
        ] as const) {
            const rows = await readDeploymentDatabaseSizesV1({ environment, content: value.content, readTargetLinks: async () => targetLinks, run: async () => result });
            expect(rows[0]?.size).toEqual({ status: 'unavailable', reason });
        }
    });
});
