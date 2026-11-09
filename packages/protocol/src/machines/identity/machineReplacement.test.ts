import { describe, expect, it } from 'vitest';

import {
    MachineReplacementFieldsSchema,
    MachineReplacementReasonSchema,
    MachineRegistrationReplacementResultSchema,
    readMachineReplacementRegistrationIntent,
} from './machineReplacement.js';

describe('machine replacement protocol', () => {
    it('parses explicit replacement intent and keeps replacement terminology', () => {
        expect(MachineReplacementReasonSchema.parse('reauth')).toBe('reauth');
        expect(MachineReplacementFieldsSchema.parse({
            replacesMachineId: 'machine-old',
            replacementReason: 'rotation',
        })).toEqual({
            replacesMachineId: 'machine-old',
            replacementReason: 'rotation',
        });
    });

    it('treats missing or malformed replacement intent as absent for compatibility', () => {
        expect(readMachineReplacementRegistrationIntent({})).toBeNull();
        expect(readMachineReplacementRegistrationIntent({
            replacesMachineId: '',
            replacementReason: 'rotation',
        })).toBeNull();
        expect(readMachineReplacementRegistrationIntent({
            replacesMachineId: 'machine-old',
            replacementReason: '',
        })).toBeNull();
        expect(readMachineReplacementRegistrationIntent({
            replacesMachineId: 'machine-old',
            replacementReason: 'rotation',
        })).toEqual({
            replacesMachineId: 'machine-old',
            replacementReason: 'rotation',
        });
    });

    it('admits closed registration outcomes without accepting untrusted diagnostic reasons', () => {
        for (const status of ['applied', 'alreadyApplied'] as const) {
            const result = { status, replacesMachineId: 'machine-old' };
            expect(MachineRegistrationReplacementResultSchema.parse(result)).toEqual(result);
        }
        const skipped = { status: 'skipped', replacesMachineId: 'machine-old', reason: 'installation_id_mismatch' };
        expect(MachineRegistrationReplacementResultSchema.parse(skipped)).toEqual(skipped);
        expect(MachineRegistrationReplacementResultSchema.safeParse({ ...skipped, reason: 'untrusted replacement detail' }).success).toBe(false);
        expect(MachineRegistrationReplacementResultSchema.safeParse({ ...skipped, details: 'untrusted replacement detail' }).success).toBe(false);
        expect(MachineRegistrationReplacementResultSchema.safeParse({ status: 'applied' }).success).toBe(false);
        expect(MachineReplacementReasonSchema.parse('vendor:rotation')).toBe('vendor:rotation');
    });
});
