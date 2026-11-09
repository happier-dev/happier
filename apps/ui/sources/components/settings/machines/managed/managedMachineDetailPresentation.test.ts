import { describe, expect, it } from 'vitest';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';

import {
    projectManagedMachineApproval,
    projectManagedMachineDetailRead,
    shouldReleaseManagedMachinePendingOnApproval,
} from './managedMachineDetailPresentation';

const machine = ManagedMachineV1Schema.parse({
    id: 'managed', homeId: 'home', custodianAccountId: 'owner',
    launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Known resource', choices: {} },
    controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'bound', creationState: 'active',
    resource: { contributionRef: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, value: { resourceId: 'native-id' } },
    desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
});

describe('managed Machine detail presentation', () => {
    it('uses the current list row as header identity while the exact read is pending', () => {
        expect(projectManagedMachineDetailRead({ managedId: machine.id, detailStatus: 'loading', admittedMachine: machine }))
            .toEqual({ headerMachine: machine, missing: false });
    });

    it('does not infer missing from an active list that excludes an archived resource when exact get fails', () => {
        const archived = { ...machine, archivedAt: 1 };
        expect(projectManagedMachineDetailRead({ managedId: machine.id, detailStatus: 'error' }).missing).toBe(false);
        expect(projectManagedMachineDetailRead({ managedId: archived.id, detailStatus: 'error', admittedMachine: archived }))
            .toEqual({ headerMachine: archived, missing: false });
        expect(projectManagedMachineDetailRead({ managedId: machine.id, detailStatus: 'unsupported' }).missing).toBe(false);
        expect(projectManagedMachineDetailRead({ managedId: machine.id, detailStatus: 'missing', admittedMachine: archived }))
            .toEqual({ headerMachine: undefined, missing: true });
        expect(projectManagedMachineDetailRead({ managedId: machine.id, detailStatus: 'denied', admittedMachine: archived }))
            .toEqual({ headerMachine: undefined, missing: false });
    });

    it('projects an admitted Delete through the managed pending-Ask presentation, not the generic card', () => {
        expect(projectManagedMachineApproval({ approvalId: 'delete-ask', submittedDeleteApprovalId: 'delete-ask',
            storedDeleteApprovalId: null })).toEqual({ kind: 'delete', artifactId: 'delete-ask' });
        expect(projectManagedMachineApproval({ approvalId: 'other-ask', submittedDeleteApprovalId: null,
            storedDeleteApprovalId: 'stored-delete' })).toEqual({ kind: 'delete', artifactId: 'stored-delete' });
        expect(projectManagedMachineApproval({ approvalId: 'other-ask', submittedDeleteApprovalId: null,
            storedDeleteApprovalId: null })).toEqual({ kind: 'generic', artifactId: 'other-ask' });
    });

    it('releases only the local Delete busy state once its Ask exists', () => {
        expect(shouldReleaseManagedMachinePendingOnApproval('machines.managed.delete')).toBe(true);
        expect(shouldReleaseManagedMachinePendingOnApproval('machines.managed.power.set')).toBe(false);
    });
});
