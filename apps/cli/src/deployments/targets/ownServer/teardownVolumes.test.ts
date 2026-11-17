import { describe, expect, it } from 'vitest';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { projectNativeComposeReview } from '@/workspaces/projectSetup/nativeComposeReview';
import { readOwnServerPreviewCleanup, readOwnServerTeardownVolumes, settleOwnServerTeardownVolumes } from './teardownVolumes';
import { normalizeActionExecutorThrownError, settleActionOutput } from '@happier-dev/protocol/actions/executor/resultProjection';

describe('native teardown volume disposition', () => {
    it.each([false, true])('captures only observed PostgreSQL data or reports malformed inspection privately: %s', async malformed => {
        const environment = createDeploymentEnvironmentDetailV1();
        Object.assign(environment.environment, { purpose: 'standard', previewCompanionOfEnvironmentId: 'main-preview' });
        environment.content.template = { templateRef: { sourceId: 'apps', itemId: 'postgres', version: '1',
            ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } }, services: ['db'],
            definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` },
            data: [{ engine: 'postgres', service: 'db' }],
            volumes: [{ id: 'data', service: 'db', target: '/data', persistent: true, backup: true, consistency: 'logicalDump' }] };
        const operation = readOwnServerPreviewCleanup({ environment, machineId: 'machine-a', services: ['db'],
            render: { projectName: 'companion-project', review: projectNativeComposeReview({ services: { db: {
                image: 'postgres:17', volumes: [{ type: 'volume', source: 'data', target: '/data' }],
            } } }, '/release', value => value) },
            activation: { nativeIdsForService: () => ['container-db'] },
            // Docker process boundary: inventory includes an unrelated owned volume, while inspect identifies the actual data mount.
            async run(args) {
                if (args[0] === 'volume') return { exitCode: 0, stdout: 'observed-data\nunrelated-data', stderr: '' };
                if (args[0] === 'inspect') return { exitCode: 0, stdout: malformed ? 'PRIVATE invalid inspection JSON' : JSON.stringify([{ Id: 'container-db',
                    Config: { Labels: { 'com.docker.compose.project': 'companion-project', 'com.docker.compose.service': 'db' } },
                    Mounts: [{ Type: 'volume', Name: 'observed-data', Destination: '/data', RW: true }] }]), stderr: '' };
                throw new Error(`Unexpected native command ${args.join(' ')}`);
            } });
        if (!malformed) expect(await operation).toEqual({ machines: ['machine-a'], volumes: [{ name: 'observed-data', disposition: 'delete', confirmation: 'observed-data' }] });
        else {
            let caught: unknown;
            try { await operation; } catch (error) { caught = error; }
            const diagnostics: unknown[] = [];
            const result = settleActionOutput('deployments.teardown', { ok: false, ...normalizeActionExecutorThrownError(caught) },
                undefined, undefined, diagnostic => diagnostics.push(diagnostic));
            expect(result).toMatchObject({ ok: false, errorCode: 'volume_observation_unavailable' });
            expect(diagnostics).toMatchObject([{ phase: 'deployment.teardown.preview_volume_parse',
                failureCause: { errorClass: 'SyntaxError' } }]);
            expect(JSON.stringify([result, diagnostics])).not.toContain('PRIVATE');
        }
    });

    it('does not authorize data deletion for an ordinary service subset or an unrelated preview subset', async () => {
        const environment = createDeploymentEnvironmentDetailV1();
        environment.content.template = { templateRef: { sourceId: 'apps', itemId: 'postgres', version: '1',
            ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } }, services: ['db'],
            definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` },
            data: [{ engine: 'postgres', service: 'db' }] };
        const input = { environment, machineId: 'machine-a', services: ['db'],
            render: { projectName: 'child-project', review: { inspection: 'complete' as const, services: [], risks: [] } },
            activation: { nativeIdsForService: () => [] }, async run(): Promise<never> { throw new Error('Unadmitted cleanup must not inspect Docker'); } };
        expect(await readOwnServerPreviewCleanup(input)).toBeUndefined();
        environment.environment.purpose = 'preview';
        expect(await readOwnServerPreviewCleanup({ ...input, services: ['app'] })).toBeUndefined();
    });
    it('removes only the selected exact owned volume and proves retained volumes without deleting them', async () => {
        const volumes = new Set(['app_data', 'app_logs', 'another_app_data']);
        const run = async (args: readonly string[]) => {
            if (args[0] === 'volume' && args[1] === 'ls') return { exitCode: 0,
                stdout: (args.includes('label=com.docker.compose.project=app')
                    ? [...volumes].filter(name => name.startsWith('app_')) : [...volumes]).join('\n'), stderr: '' };
            if (args[0] === 'volume' && args[1] === 'rm') {
                for (const name of args.slice(2)) volumes.delete(name);
                return { exitCode: 0, stdout: '', stderr: '' };
            }
            throw new Error(`Unexpected native command ${args.join(' ')}`);
        };
        const inventory = await readOwnServerTeardownVolumes({ projects: ['app'], machineId: 'machine', run });
        expect(inventory).toEqual([
            { id: 'app_data', kind: 'data', machineId: 'machine', ownership: 'owned', disposition: 'retain' },
            { id: 'app_logs', kind: 'data', machineId: 'machine', ownership: 'owned', disposition: 'retain' },
        ]);
        expect(await settleOwnServerTeardownVolumes({ resources: inventory.map(resource => resource.id === 'app_data'
            ? { ...resource, disposition: 'remove' as const } : resource), run })).toBeNull();
        expect([...volumes]).toEqual(['app_logs', 'another_app_data']);
        expect(await settleOwnServerTeardownVolumes({ resources: [{ id: 'app_data', kind: 'data',
            machineId: 'machine', ownership: 'owned', disposition: 'remove' }], run })).toBeNull();
    });
    it('inventories an activated restore volume as retained data without claiming an external binding', async () => {
        const resources = await readOwnServerTeardownVolumes({ projects: ['app'], machineId: 'machine',
            activatedVolumes: ['restore-stage', 'external-data'], async run(args) {
                if (args[1] === 'ls') return { exitCode: 0,
                    stdout: args.includes('label=happier.operation') ? 'restore-stage\nunrelated-stage' : '', stderr: '' };
                throw new Error('Unexpected native command');
            } });
        expect(resources).toEqual([{ id: 'restore-stage', kind: 'data', machineId: 'machine', ownership: 'owned', disposition: 'retain' }]);
    });

    it('does not turn a failed native volume deletion into successful teardown', async () => {
        expect(await settleOwnServerTeardownVolumes({ resources: [{ id: 'app_data', kind: 'data',
            ownership: 'owned', disposition: 'remove' }], run: async () => ({ exitCode: 1, stdout: '', stderr: 'in use' }) }))
            .toEqual({ kind: 'failed', reason: 'volume_removal_failed' });
    });
});
