import { describe, expect, it } from 'vitest';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';

import { ManagedMachineControllerError } from './controllerErrors.js';

describe('ManagedMachineControllerError.fromActionFailure', () => {
    it('preserves only the same-code authored reason, repair and closed native diagnostics', () => {
        const error = ManagedMachineControllerError.fromActionFailure({
            ok: false, errorCode: 'credential_unavailable', error: 'credential_unavailable',
            details: { name: 'PluginError', code: 'credential_unavailable',
                message: '  Sign in to Docker: run sbx login  ', remediation: { kind: 'retry' },
                details: { nativeCause: { localCause: 'native_options_changed' }, privateOutput: 'PRIVATE_OUTPUT' } },
        }, 'machines.provisioners.options');
        const failure = normalizeActionExecutorThrownError(error, 'machines.provisioners.options');
        expect(failure).toMatchObject({ errorCode: 'credential_unavailable', details: {
            name: 'PluginError', message: 'Sign in to Docker: run sbx login', remediation: { kind: 'retry' },
        } });
        expect(error.details).toEqual({ kind: 'managedNative', nativeCause: { localCause: 'native_options_changed' } });
        expect(JSON.stringify(failure)).not.toContain('PRIVATE_OUTPUT');
    });

    it('does not trust a different-code authored payload', () => {
        const error = ManagedMachineControllerError.fromActionFailure({
            ok: false, errorCode: 'provider_unavailable', error: 'provider_unavailable',
            details: { name: 'PluginError', code: 'credential_unavailable', message: 'PRIVATE_REASON',
                remediation: { kind: 'retry' } },
        }, 'machines.provisioners.options');
        expect(JSON.stringify(normalizeActionExecutorThrownError(error))).not.toContain('PRIVATE_REASON');
    });

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
