import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

const { describeMachineStartUnavailable, machineHeaderPrimary } = await import('./machineStartAvailability');

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

    it('fills at most one header action, and only on Overview: a tab’s own review or staged change leads its page', () => {
        expect(machineHeaderPrimary({ tab: 'overview', online: true, needsYou: false })).toBe('startSession');
        expect(machineHeaderPrimary({ tab: 'overview', online: true, needsYou: true })).toBe('needsYou');
        expect(machineHeaderPrimary({ tab: 'overview', online: false, needsYou: true })).toBe('needsYou');
        expect(machineHeaderPrimary({ tab: 'overview', online: false, needsYou: false })).toBeNull();
        // Setup's "Review changes", Network's staged "Review changes", any tab's own form: the header steps back.
        for (const tab of ['services', 'processes', 'storage', 'guard', 'setup', 'security', 'plugin'] as const) {
            expect(machineHeaderPrimary({ tab, online: true, needsYou: true })).toBeNull();
            expect(machineHeaderPrimary({ tab, online: true, needsYou: false })).toBeNull();
        }
    });
});
