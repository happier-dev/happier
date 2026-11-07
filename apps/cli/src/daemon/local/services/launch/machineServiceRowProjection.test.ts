import { describe, expect, it } from 'vitest';
import { projectMachineServiceName } from './machineServiceRowProjection';

describe('Machine native service display projection', () => {
    const adapter = { pluginId: 'happier.machine.services', localId: 'compose' };
    const hash = `happier-${'a'.repeat(64)}`;
    it('uses the admitted watch label and identity instead of the discovered native name', () => {
        const identity = { kind: 'adopted' as const, machineId: 'machine', serviceId: 'watch', watchId: 'watch', watchRevision: 'revision' };
        expect(projectMachineServiceName({ name: hash, adapter }, { name: 'Production database', identity }))
            .toEqual({ name: 'Production database', identity });
    });
    it('resolves a managed native hash through its Environment instance without parsing it', () => {
        const identity = { kind: 'deployment' as const, machineId: 'machine', environmentId: 'production',
            environmentInstanceId: 'production-instance', composeService: 'web', serviceId: 'production-instance/web' };
        expect(projectMachineServiceName({ name: hash, adapter }, { name: 'web', identity }))
            .toEqual({ name: 'web', identity });
    });
    it('keeps an adopted hash unresolved while retaining the adopted identity', () => {
        const identity = { kind: 'adopted' as const, machineId: 'machine', serviceId: 'watch', watchId: 'watch', watchRevision: 'revision' };
        expect(projectMachineServiceName({ name: hash, adapter }, { name: hash, identity }))
            .toEqual({ name: hash, identity, nameResolution: 'unresolved_environment' });
    });
    it('retains unowned project names and marks an unresolved Happier Environment without stripping its hash', () => {
        expect(projectMachineServiceName({ name: 'shop-api', adapter })).toEqual({ name: 'shop-api' });
        for (const name of [hash, `happier-g-${'b'.repeat(64)}`]) {
            expect(projectMachineServiceName({ name, adapter })).toEqual({ name, nameResolution: 'unresolved_environment' });
        }
        expect(projectMachineServiceName({ name: hash, adapter: { ...adapter, localId: 'systemd' } }))
            .toEqual({ name: hash });
    });
});
