import { describe, expect, it } from 'vitest';

import {
    captureMachineAdministrationOperationScope,
    isMachineAdministrationOperationScopeCurrent,
} from './operationScope';

describe('machine administration operation scope', () => {
    it('accepts settlement only while the exact portable target and selection revision remain current', () => {
        const targetA = { serverIdentityId: 'srv_one', machineId: 'machine-a' };
        const scope = captureMachineAdministrationOperationScope({
            target: targetA,
            selectionRevision: 'selection-4',
            daemonStateVersion: 12,
        });

        expect(isMachineAdministrationOperationScopeCurrent(scope, {
            target: targetA,
            selectionRevision: 'selection-4',
        })).toBe(true);
        expect(isMachineAdministrationOperationScopeCurrent(scope, {
            target: targetA,
            selectionRevision: 'selection-5',
        })).toBe(false);
        expect(isMachineAdministrationOperationScopeCurrent(scope, {
            target: { serverIdentityId: 'srv_one', machineId: 'machine-b' },
            selectionRevision: 'selection-4',
        })).toBe(false);
        expect(isMachineAdministrationOperationScopeCurrent(scope, {
            target: { serverIdentityId: 'srv_two', machineId: 'machine-a' },
            selectionRevision: 'selection-4',
        })).toBe(false);
    });

    it('rejects settlement after the selected target becomes unavailable', () => {
        const scope = captureMachineAdministrationOperationScope({
            target: { serverIdentityId: 'srv_one', machineId: 'machine-a' },
            selectionRevision: 'selection-4',
        });

        expect(isMachineAdministrationOperationScopeCurrent(scope, {
            target: null,
            selectionRevision: 'selection-4',
        })).toBe(false);
    });
});
