import { afterEach, describe, expect, it } from 'vitest';
import { createMachinesWidgetPresets } from '@/components/machines/widgets/machinesWidgetPresets';
import { createDemoMachinesWidgetBinding } from './demoMachinesWidgetBinding';
import { enterDemoMode, resetDemoModeDepthForTests } from './enterExitDemoMode';

afterEach(resetDemoModeDepthForTests);

describe('demo Machines widget binding', () => {
    it('returns a cancelled read as a failure instead of a read-only success', async () => {
        enterDemoMode('demo-widget-home');
        const binding = createDemoMachinesWidgetBinding(createMachinesWidgetPresets(
            { overview: 'Overview', machineHealth: 'Machine health' }, { machine: { serverId: 'demo-widget-home', machineId: 'demo-machine' } }));
        if (!binding) throw new Error('Expected the demo binding');
        expect(await binding.port.execute({ actionId: 'widgets.item.list' }, AbortSignal.abort()))
            .toEqual({ ok: false, errorCode: 'cancelled', error: 'cancelled' });
    });
});
