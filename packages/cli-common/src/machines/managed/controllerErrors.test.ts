import { describe, expect, it } from 'vitest';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';

import { ManagedMachineControllerError } from './controllerErrors.js';

describe('ManagedMachineControllerError.fromActionFailure', () => {
    it('preserves typed Agent isolation set details for the recovery projector', () => {
        const details = {
            kind: 'managedAgentIsolation',
            phase: 'machines.agentIsolation.set',
            code: 'conflict',
            expectedMetadataVersion: 1,
            metadataVersion: 2,
            expectedPolicy: { enabled: true, memberProvisioning: 'linuxUsersV1' },
            policy: { enabled: true, memberProvisioning: 'linuxUsersV1' },
        } as const;

        const error = ManagedMachineControllerError.fromActionFailure({
            ok: false,
            errorCode: 'conflict',
            error: 'conflict',
            details,
        }, 'machines.agentIsolation.set');

        expect(error.details).toEqual(details);
        expect(normalizeActionExecutorThrownError(error, 'machines.managed.acquire')).toMatchObject({
            errorCode: 'conflict',
            details,
            error: expect.stringContaining('Agent isolation requires a fresh review'),
        });
    });
});
