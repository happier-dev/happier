import { describe, expect, it } from 'vitest';

import { resolveNewSessionAgentSettingsRequirement, resolveNewSessionCreateAdmission, resolveNewSessionCredentialDefaultsRequirement, resolveNewSessionTargetRequirement } from './newSessionCreateAdmission';

describe('resolveNewSessionCreateAdmission', () => {
    it('explains the first blocking requirement and advances the reason as it becomes ready', () => {
        const requirements = [
            { ready: false, reason: 'Select a machine' },
            { ready: false, reason: 'Sign in to the selected Agent' },
        ];
        expect(resolveNewSessionCreateAdmission(requirements)).toEqual({
            canCreate: false, disabledReason: 'Select a machine',
        });
        expect(resolveNewSessionCreateAdmission([
            { ...requirements[0], ready: true }, requirements[1],
        ])).toEqual({ canCreate: false, disabledReason: 'Sign in to the selected Agent' });
        expect(resolveNewSessionCreateAdmission(requirements.map(requirement => ({ ...requirement, ready: true })))).toEqual({
            canCreate: true, disabledReason: null,
        });
    });
});

describe('resolveNewSessionCredentialDefaultsRequirement', () => {
    const reason = 'Credentials · Unavailable';
    it('stays quiet while the defaults are still arriving, and names them only once they really failed', () => {
        expect(resolveNewSessionCredentialDefaultsRequirement({ status: 'loading', unavailableReason: reason })).toEqual({ ready: false, reason: null });
        expect(resolveNewSessionCredentialDefaultsRequirement({ status: 'unavailable', unavailableReason: reason })).toEqual({ ready: false, reason });
        expect(resolveNewSessionCredentialDefaultsRequirement({ status: 'ready', unavailableReason: reason }).ready).toBe(true);
    });
});

describe('resolveNewSessionAgentSettingsRequirement', () => {
    const reason = 'Claude · Configuration · Unavailable';
    // A Bot template's setup read "Unavailable" while the Agent's settings were still loading (REAL-USER-PASS F5).
    it('stays quiet while the Agent settings load, and names them only once they settled without being ready', () => {
        expect(resolveNewSessionAgentSettingsRequirement({ readiness: { ready: false, settled: false, loading: true, error: null }, unavailableReason: reason }))
            .toEqual({ ready: false, reason: null });
        expect(resolveNewSessionAgentSettingsRequirement({ readiness: { ready: false, settled: true, loading: false, error: null }, unavailableReason: reason }))
            .toEqual({ ready: false, reason });
        expect(resolveNewSessionAgentSettingsRequirement({ readiness: { ready: false, settled: false, loading: false, error: 'failed' }, unavailableReason: reason }))
            .toEqual({ ready: false, reason });
        expect(resolveNewSessionAgentSettingsRequirement({ readiness: null, unavailableReason: reason }).ready).toBe(true);
        expect(resolveNewSessionAgentSettingsRequirement({ readiness: { ready: true, settled: true, loading: false, error: null }, unavailableReason: reason }).ready).toBe(true);
    });
});

describe('resolveNewSessionTargetRequirement', () => {
    const translate = (key: string) => key;

    // 58d AF1: with no machine on the Home yet, the "Run on…" chip is the ask; a status line would repeat it.
    it('blocks without a status line while the Home has no machine yet', () => {
        const requirement = resolveNewSessionTargetRequirement({ ready: false, hasTarget: false, hasMachine: false, needsFolder: true, translate });
        expect(requirement).toEqual({ ready: false, reason: null });
        expect(resolveNewSessionCreateAdmission([requirement])).toEqual({ canCreate: false, disabledReason: null });
    });

    it('asks for a machine once one exists (or while unknown) but none is chosen', () => {
        for (const hasMachine of [true, null]) {
            expect(resolveNewSessionTargetRequirement({ ready: false, hasTarget: false, hasMachine, needsFolder: true, translate }))
                .toEqual({ ready: false, reason: 'newSession.noMachineSelected' });
        }
    });

    it('names the review step when a managed default placed a preset that is not reviewed yet', () => {
        expect(resolveNewSessionTargetRequirement({ ready: false, hasTarget: false, hasMachine: true, needsFolder: true,
            placedPresetReason: 'Review Node 22 container to start the session', translate }))
            .toEqual({ ready: false, reason: 'Review Node 22 container to start the session' });
    });

    it('lets the folder chip speak for a missing folder, since it is still resolving, then reports the machine as unavailable', () => {
        expect(resolveNewSessionTargetRequirement({ ready: false, hasTarget: true, hasMachine: true, needsFolder: true, translate }))
            .toEqual({ ready: false, reason: null });
        expect(resolveNewSessionTargetRequirement({ ready: false, hasTarget: true, hasMachine: true, needsFolder: false, translate }))
            .toEqual({ ready: false, reason: 'newSession.machineUnavailableStatus' });
        expect(resolveNewSessionTargetRequirement({ ready: true, hasTarget: true, hasMachine: true, needsFolder: false, translate }).ready)
            .toBe(true);
    });
});
