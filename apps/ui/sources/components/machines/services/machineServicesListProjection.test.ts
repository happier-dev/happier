import { describe, expect, it } from 'vitest';
import { MachineServiceRowV1Schema, MachineServicesListResultV1Schema } from '@happier-dev/protocol';
import { machineServicesListProjection } from './machineServicesListProjection';

function snapshot(names: readonly string[]) {
    return MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: names.map(name => MachineServiceRowV1Schema.parse({
        serviceId: name, name, authority: 'machine', lifecyclePurpose: 'development', state: 'running',
        generation: 'generation-a', watchId: name, watchRevision: 'revision-a',
        capabilities: { exec: true, start: true, stop: true, restart: true, logs: true, accounting: true },
    })) });
}
function decode(value: ReturnType<typeof MachineServicesListResultV1Schema.parse>, previous?: ReturnType<typeof machineServicesListProjection.decode>) {
    return machineServicesListProjection.decode({ bytes: new TextEncoder().encode(JSON.stringify(value)) }, previous);
}

describe('first Services inventory count', () => {
    it('preserves explicit partial coverage even when selected rows are unchanged', () => {
        const first = decode(snapshot([]));
        const next = decode({ ...snapshot([]), coverage: 'managed_services' }, first);
        expect(next).toHaveProperty('coverage', 'managed_services');
        expect(decode({ ...snapshot([]), coverage: 'managed_services' }, next)).toBe(next);
    });
    it.each([{ names: [] }, { names: ['web', 'worker'] }])('keeps the first successful count across changes and unavailable answers ($names)', ({ names }) => {
        const unavailable = MachineServicesListResultV1Schema.parse({ kind: 'unavailable', reason: 'admission_unavailable' });
        const unanswered = decode(unavailable);
        expect(unanswered).toHaveProperty('firstInventoryCount', null);
        const first = decode(snapshot(names), unanswered);
        expect(first).toHaveProperty('firstInventoryCount', names.length);
        const changed = decode(snapshot(['web', 'worker', 'database']), first);
        expect(changed).toHaveProperty('firstInventoryCount', names.length);
        const failed = decode(unavailable, changed);
        expect(failed).toHaveProperty('firstInventoryCount', names.length);
        const recovered = decode(snapshot(['web']), failed);
        expect(recovered).toHaveProperty('firstInventoryCount', names.length);
        // A new Resource starts from its own first answer, without another Account's count.
        expect(decode(snapshot(['database']))).toHaveProperty('firstInventoryCount', 1);
    });

    it('retains unchanged snapshots and rows while keeping the arrival count', () => {
        const value = snapshot(['web', 'worker']);
        const first = decode(value);
        expect(decode(value, first)).toBe(first);
        const changed = decode(snapshot(['web', 'worker', 'database']), first);
        expect(changed).toHaveProperty('firstInventoryCount', 2);
        if (first.kind !== 'snapshot' || changed.kind !== 'snapshot') throw new Error('Expected inventory snapshots');
        expect(changed.services[0]).toBe(first.services[0]);
        expect(changed.services[1]).toBe(first.services[1]);
    });
});
