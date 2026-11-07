import { describe, expect, it } from 'vitest';
import { describeManagedActionFailureDiagnostic, describeManagedOperationDiagnostic } from './managedNativeFailurePresentation';

describe('managed native failure Details', () => {
    it('retains the typed controller request cause without exposing opaque response text', () => {
        const details = { kind: 'managedControllerRequest', path: '/v1/machines/managed/controller/submit-intent',
            category: 'status', status: 409, code: 'intent_changed' };
        expect(describeManagedActionFailureDiagnostic('managed_controller_request_failed', details))
            .toBe('managed_controller_request_failed · status · HTTP 409 · intent_changed');
        expect(describeManagedActionFailureDiagnostic('managed_controller_request_failed', { ...details, body: 'secret' }))
            .toBe('managed_controller_request_failed');
    });
    it('includes the closed transport cause in control Details while refusing opaque diagnostic text', () => {
        const details = { error: 'invalid_request', code: 'action_outcome_unknown', requestId: 'control',
            diagnostic: { reason: 'daemon_rpc_refused', errorCode: 'RPC_FORBIDDEN' } };
        expect(describeManagedActionFailureDiagnostic('action_outcome_unknown', details)).toContain('RPC_FORBIDDEN');
        expect(describeManagedActionFailureDiagnostic('action_outcome_unknown', { ...details,
            diagnostic: { ...details.diagnostic, privateText: 'secret' } })).toBe('action_outcome_unknown');
    });
    it('shows the projected Lima stderr reason alongside the failed native command', () => {
        const diagnostic = describeManagedOperationDiagnostic({ errorCode: 'native_acquisition_unconfirmed', error: 'Native acquisition unconfirmed',
            details: { kind: 'managedNative', nativeCause: { localCause: 'native_command_failed', command: 'restart', exitCode: 1,
                stderr: 'failed to download template:ubuntu: no such file or directory' } } });
        expect(diagnostic).toContain('restart');
        expect(diagnostic).toContain('no such file or directory');
    });
});
