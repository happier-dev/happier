import { describe, expect, it } from 'vitest';

import { resolveMachineDisplayNameParts } from './machineDisplayNames';

type Source = Parameters<typeof resolveMachineDisplayNameParts>[0][number];

/** Machines whose `name` and `host` reads are counted, as an inventory row's fields would be read. */
function countedFleet(count: number, host: (index: number) => string): Readonly<{ machines: Source[]; reads: () => number }> {
    let reads = 0;
    const machines = Array.from({ length: count }, (_, index) => {
        const machine = { id: `${index.toString(16).padStart(8, '0')}-63e0-436e-ab81` } as { id: string; name: string; host: string };
        Object.defineProperty(machine, 'name', { enumerable: true, get: () => { reads += 1; return 'lima-happier-fresh'; } });
        Object.defineProperty(machine, 'host', { enumerable: true, get: () => { reads += 1; return host(index); } });
        return machine;
    });
    return { machines, reads: () => reads };
}

describe('resolveMachineDisplayNameParts', () => {
    it('reads each Machine a constant number of times however many share its name', () => {
        // QA A holds 483 same-named Machines; the resolver read 233,289 host fields for them in one pass.
        for (const count of [7, 137, 483]) {
            const distinctHosts = countedFleet(count, (index) => `lima-host-${index}`);
            const names = resolveMachineDisplayNameParts(distinctHosts.machines);
            expect(names.get(distinctHosts.machines[5]!.id)).toEqual({ name: 'lima-happier-fresh', hint: 'lima-host-5' });
            expect(distinctHosts.reads()).toBeLessThanOrEqual(count * 6);

            const sharedHost = countedFleet(count, () => 'lima-happier-fresh');
            resolveMachineDisplayNameParts(sharedHost.machines);
            expect(sharedHost.reads()).toBeLessThanOrEqual(count * 6);
        }
    });

    it('falls back to the shortest unique id prefix for peers that share a host, and keeps a unique host as the hint', () => {
        const names = resolveMachineDisplayNameParts([
            { id: 'abcdef01-1', name: 'Build', host: 'shared.local' },
            { id: 'abcdef02-2', name: 'build', host: 'shared.local' },
            { id: 'abcd99-3', name: 'BUILD', host: 'own.local' },
            { id: 'zz', name: 'Build', host: '' },
            { id: 'lone', name: 'Laptop', host: 'laptop.local' },
        ]);
        expect(names.get('abcdef01-1')).toEqual({ name: 'Build', hint: 'abcdef01' });
        expect(names.get('abcdef02-2')).toEqual({ name: 'build', hint: 'abcdef02' });
        expect(names.get('abcd99-3')).toEqual({ name: 'BUILD', hint: 'own.local' });
        expect(names.get('zz')).toEqual({ name: 'Build', hint: 'zz' });
        expect(names.get('lone')).toEqual({ name: 'Laptop', hint: null });
    });

    it('lets a Machine that must not be qualified still count as a peer for the others', () => {
        const names = resolveMachineDisplayNameParts([
            { id: 'aaaa-1', name: 'Build', host: 'mac.local', disambiguate: false },
            { id: 'bbbb-2', name: 'Build', host: 'mac.local' },
        ]);
        expect(names.get('aaaa-1')).toEqual({ name: 'Build', hint: null });
        expect(names.get('bbbb-2')).toEqual({ name: 'Build', hint: 'bbbb' });
    });
});
