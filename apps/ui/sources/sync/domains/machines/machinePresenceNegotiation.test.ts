import { describe, expect, it } from 'vitest';
import { createMachineFixture } from '@/dev/testkit';
import { publishMachineActivity } from './machineActivity';
import { buildMachineDisplayRenderableFromMachine, areMachineDisplaySemanticsEqual } from './machineDisplayRenderable';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { isMachineReachable } from './reachability/machineReachability';

describe('negotiated Machine presence consumers', () => {
    it('uses the latest held activity clock for legacy grace and preserves negotiated facts in display rows', () => {
        const legacy = createMachineFixture({ id: 'held', active: true, activeAt: 100_000 });
        const display = buildMachineDisplayRenderableFromMachine(legacy);
        expect(isMachineOnline(legacy, 180_001)).toBe(false);
        publishMachineActivity(legacy, { active: true, activeAt: 180_001 }, [display]);
        expect(isMachineOnline(legacy, 180_001)).toBe(true);
        expect(isMachineOnline(display, 180_001)).toBe(true);
        expect(isMachineOnline(display, 240_002)).toBe(false);
        const negotiated = { ...legacy, presenceProtocolVersion: 1 as const };
        const negotiatedDisplay = buildMachineDisplayRenderableFromMachine(negotiated);
        expect(isMachineOnline(negotiatedDisplay, 1_000_000)).toBe(true);
        expect(areMachineDisplaySemanticsEqual(display, negotiatedDisplay)).toBe(false);
        const scope = { serverId: 'home', accountId: 'owner' };
        expect(isMachineReachable(scope, legacy, 240_002)).toBe(false);
        expect(isMachineReachable(scope, negotiated, 1_000_000)).toBe(true);
    });
});
