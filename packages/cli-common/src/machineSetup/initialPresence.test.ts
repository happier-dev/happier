import { expect, it } from 'vitest';
import { createMachineSetupEffectPlan, readMachineSetupInitialPresenceV1 } from './index.js';

it.each([false, true, undefined])('uses the selected exact cask footprint, retaining unknown presence (%s)', present => {
    const plan = createMachineSetupEffectPlan({
        basis: { kind: 'setup', machineId: 'machine', desiredRevision: 0 },
        checks: [{ id: 'cask', kind: 'package', manager: 'brew', state: 'absent',
            packages: [{ name: 'browser', kind: 'cask' }] }],
        checkFacts: [{ stepId: 'cask', status: 'satisfied', facts: {} }], selectedCheckIds: ['cask'],
        steps: [{ id: 'packages', kind: 'package', manager: 'brew', packages: [
            { name: 'browser', kind: 'formula' }, { name: 'browser', kind: 'cask' },
        ] }],
        nativeFacts: [{ stepId: 'packages', status: 'drifted', facts: { manager: 'brew', packages: [
            { manager: 'brew', name: 'browser', kind: 'formula', present: true },
            { manager: 'brew', name: 'browser', kind: 'cask', ...(present === undefined ? {} : { present }) },
        ] } }],
    });
    expect(readMachineSetupInitialPresenceV1(plan)).toBe(present === undefined ? undefined : present ? 'present' : 'absent');
});

it('retains a pre-existing native directory alongside an absent selected package', () => {
    const plan = createMachineSetupEffectPlan({
        basis: { kind: 'setup', machineId: 'machine', desiredRevision: 0 },
        checks: [{ id: 'package', kind: 'package', manager: 'apt', packages: [{ name: 'server' }] }],
        checkFacts: [{ stepId: 'package', status: 'drifted', facts: {} }], selectedCheckIds: ['package'],
        steps: [
            { id: 'package', kind: 'package', manager: 'apt', packages: [{ name: 'server' }] },
            { id: 'data', kind: 'directory', path: '/example/data', owner: 'root', group: 'root', mode: 0o755 },
        ],
        nativeFacts: [
            { stepId: 'package', status: 'drifted', facts: { manager: 'apt', packages: [{ manager: 'apt', name: 'server', present: false }] } },
            { stepId: 'data', status: 'satisfied', facts: { present: true } },
        ],
    });
    expect(readMachineSetupInitialPresenceV1(plan)).toBe('present');
});
