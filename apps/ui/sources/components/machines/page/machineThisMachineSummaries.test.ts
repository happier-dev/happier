import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

describe('Sharing row summary', () => {
    it('reports who shares a machine with you, and says nothing when nothing is known (plan 10 MPG-10: no purpose line)', async () => {
        const { describeMachineSharingSummary } = await import('./machineThisMachineSummaries');
        expect(describeMachineSharingSummary({ isShared: true, access: { custodian: { displayName: 'Ben' } } })).toContain('sharedByOwner');
        expect(describeMachineSharingSummary({ isShared: true, access: null })).toContain('sharedWithYou');
        expect(describeMachineSharingSummary({})).toBeUndefined();
    });

    it('gives a cold row its title alone: no summary for Agents and Doctor until their caches hold state', async () => {
        const { describeMachineAgentsReady, describeMachineDoctorSummary } = await import('./machineThisMachineSummaries');
        expect(describeMachineAgentsReady([])).toBeNull();
        expect(describeMachineDoctorSummary(null)).toBeUndefined();
        expect(describeMachineDoctorSummary({ cachedAt: 1_700_000_000_000 })).toContain('doctorChecked');
    });

    it('says installed and ready tools only once the inventory is held: no spinner, no zero from an unobserved registry', async () => {
        const { describeMachineToolsSummary } = await import('./machineThisMachineSummaries');
        expect(describeMachineToolsSummary({ status: 'ready', installed: 3, ready: 2, held: false })).toContain('toolsInstalledReady');
        // A refresh that failed keeps the inventory it already held; a settled zero is a reading.
        expect(describeMachineToolsSummary({ status: 'ready', installed: 0, ready: 0, held: true })).toContain('toolsInstalledReady');
        for (const status of ['unknown', 'loading', 'unavailable'] as const) {
            expect(describeMachineToolsSummary({ status })).toBeUndefined();
        }
    });

    it('keeps a Happier-created machine’s provider instance name out of the Details row: platform only', async () => {
        const { describeMachineDetailsSummary } = await import('./machineThisMachineSummaries');
        expect(describeMachineDetailsSummary({ host: 'studio', platform: 'Linux', managed: false })).toBe('studio · Linux');
        expect(describeMachineDetailsSummary({ host: 'lima-happier-5bi1h6q00rlp5zjoh5njd664', platform: 'Linux', managed: true })).toBe('Linux');
        expect(describeMachineDetailsSummary({ host: undefined, platform: undefined, managed: false })).toBeUndefined();
    });

    it('summarises Setup on the Security tab from the daemon’s published observation, without reading a plan', async () => {
        const { describeMachineSetupRowSummary } = await import('./machineThisMachineSummaries');
        const recipe = (status: 'satisfied' | 'drifted' | 'checking') => ({ ref: { kind: 'builtin', id: 'docker' }, status, steps: [] });
        // Before the Machine publishes an observation the row still leads to Setup, saying what is there.
        expect(describeMachineSetupRowSummary(null)).toEqual({ title: expect.stringContaining('setupRowUnknown'), subtitle: undefined });
        expect(describeMachineSetupRowSummary({ status: 'satisfied', recipes: [] })?.title).toContain('setupRowNone');
        expect(describeMachineSetupRowSummary({ status: 'satisfied', recipes: [recipe('satisfied'), recipe('satisfied')] }))
            .toEqual({ title: expect.stringContaining('setupRowRecipes(count=2)'), subtitle: undefined });
        expect(describeMachineSetupRowSummary({ status: 'drifted', recipes: [recipe('drifted')] })?.subtitle).toContain('setupRowDrifted');
        expect(describeMachineSetupRowSummary({ status: 'checking', recipes: [recipe('checking')] })?.subtitle).toContain('setupRowChecking');
    });
});

