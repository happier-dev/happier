import { describe, expect, it, vi } from 'vitest';

import { carryMachineActivity, linkMachineActivity, publishMachineActivities, publishMachineActivity, readMachineActivity, subscribeMachineActivity } from './machineActivity';

const row = () => Object.freeze({ active: true, activeAt: 1 });

describe('machine activity subscriptions', () => {
    it.each([true, false])('keeps linked projections current across same-valued replacements from active=%s', (active) => {
        const held = Object.freeze({ active, activeAt: 1 });
        const projection = { ...held };
        const nestedProjection = { ...held };
        linkMachineActivity(held, projection);
        linkMachineActivity(projection, nestedProjection);
        const observed: boolean[] = [];
        const stop = subscribeMachineActivity(projection, () => observed.push(readMachineActivity(projection).active));
        const middle = { ...held };
        carryMachineActivity(held, middle);
        const lateObserved: boolean[] = [];
        const stopLate = subscribeMachineActivity(nestedProjection, () => lateObserved.push(readMachineActivity(nestedProjection).active));
        const current = { ...held };
        const currentObserved: boolean[] = [];
        const stopCurrent = subscribeMachineActivity(current, () => currentObserved.push(readMachineActivity(current).active));
        carryMachineActivity(middle, current);

        publishMachineActivities([
            { machine: current, activity: { active, activeAt: 2 }, projections: [] },
            { machine: current, activity: { active: !active, activeAt: 3 }, projections: [] },
        ]);

        expect(observed).toEqual([!active]);
        expect(lateObserved).toEqual([!active]);
        expect(currentObserved).toEqual([!active]);
        for (const reader of [held, projection, nestedProjection, middle, current]) {
            expect(readMachineActivity(reader)).toEqual({ active: !active, activeAt: 3 });
        }
        stop();
        stopLate();
        stopCurrent();
        publishMachineActivity(current, { active, activeAt: 4 }, []);
        expect(observed).toEqual([!active]);
        expect(lateObserved).toEqual([!active]);
        expect(currentObserved).toEqual([!active]);
    });

    it('keeps independently subscribed projections joined after their initial publication', () => {
        const machine = row();
        const projection = row();
        const observed: boolean[] = [];
        const stop = subscribeMachineActivity(projection, () => observed.push(readMachineActivity(projection).active));
        publishMachineActivity(machine, { active: true, activeAt: 2 }, [projection]);
        publishMachineActivity(machine, { active: false, activeAt: 3 }, []);
        expect(observed).toEqual([true, false]);
        stop();
        publishMachineActivity(machine, { active: true, activeAt: 4 }, [projection]);
        expect(observed).toEqual([true, false]);
    });

    it('stops a reader however far carried rows moved its subscription', () => {
        const held = row();
        const middle = row();
        const current = row();
        const listener = vi.fn();
        const stop = subscribeMachineActivity(held, listener);
        carryMachineActivity(held, middle);
        carryMachineActivity(middle, current);

        publishMachineActivity(current, { active: false, activeAt: 2 }, []);
        expect(listener).toHaveBeenCalledTimes(1);

        stop();
        publishMachineActivity(current, { active: true, activeAt: 3 }, []);
        publishMachineActivity(middle, { active: true, activeAt: 4 }, []);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('stopping one reader leaves another reader of the same listener on its own row', () => {
        const first = row();
        const second = row();
        const listener = vi.fn();
        const stopFirst = subscribeMachineActivity(first, listener);
        subscribeMachineActivity(second, listener);
        stopFirst();
        publishMachineActivity(second, { active: false, activeAt: 2 }, []);
        expect(listener).toHaveBeenCalledTimes(1);
    });
});
