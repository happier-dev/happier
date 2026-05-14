import { describe, expect, it } from 'vitest';

import {
    MachineReplacementFieldsSchema,
    MachineReplacementReasonSchema,
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
});
