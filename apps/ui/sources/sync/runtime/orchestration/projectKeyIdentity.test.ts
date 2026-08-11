import { describe, expect, it } from 'vitest';

import { resolveProjectMachineScopeId } from './projectKeyIdentity';

describe('resolveProjectMachineScopeId', () => {
    it('does not use host as a project machine identity fallback', () => {
        expect(resolveProjectMachineScopeId({
            host: 'same-host',
            machineId: null,
        })).toBe('unknown');
    });

    it('uses stable session machine identity when available', () => {
        expect(resolveProjectMachineScopeId({
            host: 'same-host',
            machineId: 'machine-a',
        })).toBe('machine-a');
    });
});
