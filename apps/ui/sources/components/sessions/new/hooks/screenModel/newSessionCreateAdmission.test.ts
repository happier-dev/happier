import { describe, expect, it } from 'vitest';

import { resolveNewSessionCreateAdmission, resolveNewSessionTargetRequirement } from './newSessionCreateAdmission';

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

    it('then asks for a folder, then reports the machine as unavailable', () => {
        expect(resolveNewSessionTargetRequirement({ ready: false, hasTarget: true, hasMachine: true, needsFolder: true, translate }))
            .toEqual({ ready: false, reason: 'newSession.noPathSelected' });
        expect(resolveNewSessionTargetRequirement({ ready: false, hasTarget: true, hasMachine: true, needsFolder: false, translate }))
            .toEqual({ ready: false, reason: 'newSession.machineUnavailableStatus' });
        expect(resolveNewSessionTargetRequirement({ ready: true, hasTarget: true, hasMachine: true, needsFolder: false, translate }).ready)
            .toBe(true);
    });
});
