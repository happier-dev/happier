import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MachineActivityAccumulator, type MachineActivityUpdate } from './machineActivityAccumulator';

describe('MachineActivityAccumulator', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('drops pending updates whose guard becomes stale before debounce flush', async () => {
        let isCurrentScope = true;
        const flushHandler = vi.fn();
        const accumulator = new MachineActivityAccumulator(flushHandler, 300);
        const update1: MachineActivityUpdate = {
            id: 'machine1',
            active: true,
            activeAt: 1_000,
        };
        const update2: MachineActivityUpdate = {
            id: 'machine1',
            active: true,
            activeAt: 1_100,
        };

        accumulator.addUpdate(update1, { shouldContinue: () => isCurrentScope });
        accumulator.addUpdate(update2, { shouldContinue: () => isCurrentScope });

        expect(flushHandler).toHaveBeenCalledTimes(1);

        isCurrentScope = false;
        await vi.runAllTimersAsync();

        expect(flushHandler).toHaveBeenCalledTimes(1);
    });

    it('preserves source server ids when debounced updates flush', async () => {
        const flushHandler = vi.fn();
        const accumulator = new MachineActivityAccumulator(flushHandler, 300);

        accumulator.addUpdate({ id: 'machine1', active: true, activeAt: 1_000 }, { sourceServerId: 'server-a' });
        accumulator.addUpdate({ id: 'machine1', active: true, activeAt: 1_100 }, { sourceServerId: 'server-a' });

        await vi.runAllTimersAsync();

        expect(flushHandler).toHaveBeenLastCalledWith(
            new Map([['machine1', { id: 'machine1', active: true, activeAt: 1_100 }]]),
            { sourceServerId: 'server-a' },
        );
    });
});
