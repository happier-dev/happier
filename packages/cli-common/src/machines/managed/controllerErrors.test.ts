import { describe, expect, it } from 'vitest';
import { completeSpawnActionResult, normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';

import { ManagedMachineControllerError } from './controllerErrors.js';

describe('ManagedMachineControllerError.fromActionFailure', () => {
    it('retains the ordinary Session spawn refusal and launch cause through a managed continuation', () => {
        const refusal = { type: 'error' as const, code: 'spawn_failed' as const, retryable: false,
            launchError: { kind: 'launch_error' as const, code: 'agent_cli_target_unavailable',
                message: 'The Agent CLI cannot run in this target' } };
        const child = completeSpawnActionResult(refusal);
        if (child.ok) throw new Error('Expected the ordinary spawn failure');
        const error = ManagedMachineControllerError.fromActionFailure(child, 'session.spawn_new');
        expect(normalizeActionExecutorThrownError(error, 'machines.managed.acquire')).toMatchObject({
            errorCode: 'spawn_failed', error: refusal.launchError.message, details: refusal,
        });
    });
    it.each([false, true])('retains a code-only child refusal request and effect evidence (%s)', effectAttempted => {
        const error = ManagedMachineControllerError.fromActionFailure({ ok: false, errorCode: 'provider_unavailable',
            error: 'provider_unavailable', requestId: 'native-acquire-request', effectAttempted,
            details: { privateOutput: 'PRIVATE_OUTPUT' } }, 'machines.managed.acquire');
        const failure = normalizeActionExecutorThrownError(error, 'root');
        expect(failure).toMatchObject({ errorCode: 'provider_unavailable', requestId: 'native-acquire-request', effectAttempted });
        expect(JSON.stringify(failure)).not.toContain('PRIVATE_OUTPUT');
    });
    it('retains a public child refusal reason and its original typed cause without arbitrary details', () => {
        const failureCause = { phase: 'deployment.reviewed_child', errorClass: 'Error', errorCode: 'approval_required', httpStatus: null } as const;
        const error = ManagedMachineControllerError.fromActionFailure({ ok: false, errorCode: 'credential_scope_denied',
            error: 'Approval required by fixture.compute/actions/acquire; required surface: ui; requested surface: ui.',
            failureCause, details: { privateOutput: 'PRIVATE_OUTPUT' } }, 'machines.managed.bootstrap.retry');
        expect(normalizeActionExecutorThrownError(error, 'root')).toMatchObject({
            errorCode: 'credential_scope_denied', failureCause,
            error: 'Approval required by fixture.compute/actions/acquire; required surface: ui; requested surface: ui.',
        });
        expect(JSON.stringify(error.cause)).not.toContain('PRIVATE_OUTPUT');
    });
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

    it.each([false, true])('preserves typed Agent isolation set details for the recovery projector (metadata %s)', metadata => {
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
            ...(metadata ? { requestId: 'isolation-child', effectAttempted: false } : {}),
        }, 'machines.agentIsolation.set');

        expect(error.details).toEqual(details);
        expect(normalizeActionExecutorThrownError(error, 'machines.managed.acquire')).toMatchObject({
            errorCode: 'conflict',
            details,
            error: expect.stringContaining('Agent isolation requires a fresh review'),
        });
    });
});
