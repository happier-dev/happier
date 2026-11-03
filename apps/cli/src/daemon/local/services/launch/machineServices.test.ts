import { describe, expect, it } from 'vitest';
import { createMachineServicesRuntime } from './machineServices';

describe('Machine service watch front door', () => {
    it('leaves Compose adoption to the reviewed deployment owner before native observation admission', async () => {
        const runtime = createMachineServicesRuntime({ target: { serverId: 'home', machineId: 'machine' },
            readMetadata: () => { throw new Error('Adoption must not read watch custody'); },
            captureMetadataPort: () => { throw new Error('Adoption must not mutate watch custody'); } });
        expect(await runtime.execute({ actionId: 'machines.services.adopt', input: {
            serverId: 'home', machineId: 'machine', serviceId: 'analytics', expectedGeneration: 'generation',
            requestKey: 'adoption', profiles: [], mode: 'review',
        }, context: { surface: 'cli', authority: 'present_user' },
        canReadEnvironments: async () => new Set() })).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
        await runtime.dispose();
    });
});
