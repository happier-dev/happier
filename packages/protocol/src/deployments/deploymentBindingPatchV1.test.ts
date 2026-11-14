import { describe, expect, it } from 'vitest';
import { applyEnvironmentSecretBindingsPatchV1 } from './deploymentBindingPatchV1.js';

describe('Environment variable Machine-grant references', () => {
    it('promotes retained variable addresses only during a normal binding save', () => {
        const legacy = { purpose: 'variable' as const, phase: 'runtime' as const, name: 'RETAINED',
            source: { kind: 'value' as const, value: 'retained' } };
        const grantRef = '00000000-0000-4000-8000-000000000003';
        expect(applyEnvironmentSecretBindingsPatchV1([legacy], { set: [], remove: [] }, () => grantRef))
            .toEqual([{ ...legacy, grantRef }]);
        expect(legacy).not.toHaveProperty('grantRef');
    });

    it('keeps the opaque reference across replacement and mints a new one for a renamed binding', () => {
        const retainedGrantRef = '00000000-0000-4000-8000-000000000001';
        const renamedGrantRef = '00000000-0000-4000-8000-000000000002';
        const current = [{ purpose: 'variable' as const, phase: 'runtime' as const, name: 'PUBLIC_ENDPOINT',
            grantRef: retainedGrantRef, source: { kind: 'value' as const, value: 'https://before.example.test' } }];
        const replaced = applyEnvironmentSecretBindingsPatchV1(current, {
            set: [{ purpose: 'variable', phase: 'runtime', name: 'PUBLIC_ENDPOINT',
                source: { kind: 'value', value: 'https://after.example.test' } }],
            remove: [],
        }, () => renamedGrantRef);
        expect(replaced).toEqual([{ ...current[0], source: { kind: 'value', value: 'https://after.example.test' } }]);

        const renamed = applyEnvironmentSecretBindingsPatchV1(replaced, {
            set: [{ purpose: 'variable', phase: 'runtime', name: 'PUBLIC_ORIGIN',
                // Editors commonly spread the old persisted value while changing
                // its identity. That stale reference must not transfer to the
                // newly named variable.
                grantRef: retainedGrantRef,
                source: { kind: 'value', value: 'https://after.example.test' } }],
            remove: [{ purpose: 'variable', phase: 'runtime', name: 'PUBLIC_ENDPOINT' }],
        }, () => renamedGrantRef);
        expect(renamed).toEqual([{ purpose: 'variable', phase: 'runtime', name: 'PUBLIC_ORIGIN',
            grantRef: renamedGrantRef, source: { kind: 'value', value: 'https://after.example.test' } }]);
    });
});
