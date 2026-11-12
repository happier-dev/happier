import { describe, expect, it, vi } from 'vitest';

import { linkMachineActivity, publishMachineActivities, publishMachineActivity, readMachineActivity, subscribeMachineActivity } from './machineActivity';

const row = (active = true) => Object.freeze({ active, activeAt: 1,
    activity: { value: { active, activeAt: 1 }, answered: false } });

describe('machine activity subscriptions', () => {
    it('publishes a cold presence answer only to the changed Machine row', () => {
        const machines = Array.from({ length: 24 }, (_, index) => row());
        const renders = machines.map(() => 0);
        const stops = machines.map((machine, index) => subscribeMachineActivity(machine, () => { renders[index] += 1; }));
        publishMachineActivities([{ machine: machines[0]!, activity: { active: false, activeAt: 2 }, projections: [] }]);
        expect(renders).toEqual(Array.from({ length: 24 }, (_, index) => index === 0 ? 1 : 0));
        stops.forEach(stop => stop());
    });

    it.each([true, false])('keeps linked projections current across same-valued replacements from active=%s', (active) => {
        const held = row(active);
        const projection = { ...held };
        const nestedProjection = { ...held };
        linkMachineActivity(held, projection);
        linkMachineActivity(projection, nestedProjection);
        const observed: boolean[] = [];
        const stop = subscribeMachineActivity(projection, () => observed.push(readMachineActivity(projection).active));
        const middle = { ...held };
        const lateObserved: boolean[] = [];
        const stopLate = subscribeMachineActivity(nestedProjection, () => lateObserved.push(readMachineActivity(nestedProjection).active));
        const current = { ...held };
        const currentObserved: boolean[] = [];
        const stopCurrent = subscribeMachineActivity(current, () => currentObserved.push(readMachineActivity(current).active));

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
        const middle = { ...held };
        const current = { ...middle };
        const listener = vi.fn();
        const stop = subscribeMachineActivity(held, listener);

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
