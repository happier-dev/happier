import { describe, expect, it } from 'vitest';
import { readOwnServerTeardownVolumes, settleOwnServerTeardownVolumes } from './teardownVolumes';

describe('native teardown volume disposition', () => {
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
    it('does not turn a failed native volume deletion into successful teardown', async () => {
        expect(await settleOwnServerTeardownVolumes({ resources: [{ id: 'app_data', kind: 'data',
            ownership: 'owned', disposition: 'remove' }], run: async () => ({ exitCode: 1, stdout: '', stderr: 'in use' }) }))
            .toEqual({ kind: 'failed', reason: 'volume_removal_failed' });
    });
});
