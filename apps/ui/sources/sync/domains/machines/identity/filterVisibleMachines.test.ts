import { describe, expect, it } from 'vitest';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { buildMachineDisplayRenderableFromMachine } from '../machineDisplayRenderable';
import { selectMachineFleet, selectMachineFleetFromRecord } from './filterVisibleMachines';

describe('Home fleet selection', () => {
    it('shares current identity membership across raw lists and display maps', () => {
        const rows = [createMachineFixture({ id: 'offline', active: false }),
            createMachineFixture({ id: 'shared', isShared: true }),
            createMachineFixture({ id: 'guest', managedMachineRef: { homeId: 'home', managedId: 'creation' } }),
            createMachineFixture({ id: 'replaced', replacedByMachineId: 'guest' }),
            createMachineFixture({ id: 'revoked', revokedAt: 1 }),
            createMachineFixture({ id: 'runner', kind: 'ephemeral_session_runner' })];
        const selected = selectMachineFleet(rows);
        expect(selected.map(row => row.id)).toEqual(['offline', 'shared', 'guest']);
        const displays = Object.fromEntries(rows.map(row => [row.id, buildMachineDisplayRenderableFromMachine(row)]));
        expect(selectMachineFleetFromRecord(displays).map(row => row.id)).toEqual(selected.map(row => row.id));
        expect(selectMachineFleetFromRecord(displays)).toBe(selectMachineFleetFromRecord(displays));
        expect(selectMachineFleet([])).toEqual([]);
    });

    it('visits each Machine once per immutable inventory snapshot across repeated selections', () => {
        // F7's observed Account inventory has 351 Machines.
        let visits = 0;
        const rows = Array.from({ length: 351 }, (_, index) => {
            const row = createMachineFixture({ id: `fleet-${index}` });
            Object.defineProperty(row, 'kind', { get() { visits += 1; return 'persistent'; } });
            return row;
        });
        const selected = selectMachineFleet(rows);
        expect(visits).toBe(351);
        for (let surface = 0; surface < 6; surface += 1) {
            expect(selectMachineFleet(rows)).toBe(selected);
        }
        expect(visits).toBe(351);
        const changed = [...rows.slice(0, -1), createMachineFixture({ id: 'fleet-350', revokedAt: 1 })];
        const changedSelection = selectMachineFleet(changed);
        expect(changedSelection).toHaveLength(350);
        const afterChange = visits;
        expect(selectMachineFleet(changed)).toBe(changedSelection);
        expect(visits).toBe(afterChange);
    });
});
