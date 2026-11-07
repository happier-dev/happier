import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

const { describeMachineStartUnavailable } = await import('./machineStartAvailability');

describe('Start session says why it is disabled (MR6)', () => {
    it('names the reason the canonical readiness owner gives, never a raw status', () => {
        const name = 'Lima';
        expect(describeMachineStartUnavailable({ status: 'offline', machineId: 'm' }, name)).toContain('startUnavailable.offline');
        expect(describeMachineStartUnavailable({ status: 'keyUnavailable', machineId: 'm' }, name)).toContain('startUnavailable.locked');
        expect(describeMachineStartUnavailable({ status: 'rpcUnavailable', machineId: 'm' }, name)).toContain('startUnavailable.notAnswering');
        expect(describeMachineStartUnavailable({ status: 'revoked', machineId: 'm' }, name)).toContain('startUnavailable.removed');
        expect(describeMachineStartUnavailable({ status: 'replaced', machineId: 'm', replacedByMachineId: 'n' }, name)).toContain('startUnavailable.replaced');
    });

    it('says nothing while Start is possible or the Machine is not read yet', () => {
        expect(describeMachineStartUnavailable({ status: 'ready', machineId: 'm' }, 'Lima')).toBeUndefined();
        expect(describeMachineStartUnavailable({ status: 'unknown', machineId: 'm' }, 'Lima')).toBeUndefined();
        expect(describeMachineStartUnavailable({ status: 'missing' }, 'Lima')).toBeUndefined();
    });
});
