import { describe, expect, it } from 'vitest';
import { t } from '@/text';
import { describeManagedActionFailureDiagnostic, describeManagedOperationDiagnostic, describeManagedPresetAvailabilityFailure } from './managedNativeFailurePresentation';

describe('managed native failure Details', () => {
    it.each([
        'permission_denied', 'controller_unavailable', 'credential_unavailable', 'provider_unavailable',
        'controller_retired', 'request_conflict', 'intent_changed', 'managed_not_found', 'enrollment_retired',
    ] as const)('localizes the preset availability refusal %s through the existing Session copy', (code) => {
        const expected = t(`session.startFailure.cause.${code}`);
        expect(expected).not.toContain('startFailure.cause.');
        expect(describeManagedPresetAvailabilityFailure(code)).toBe(expected);
    });

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
    it('shows the failed contributed Action and sanitized schema issue paths in operation Details', () => {
        const issues = [{ code: 'required' as const, path: ['resource', 'containerId'],
            message: 'private validation prose', received: 'rejected-private-value' },
            { code: 'type' as const, path: ['argv', 1] }, { code: 'type' as const, path: [] }];
        const diagnostic = describeManagedOperationDiagnostic({ errorCode: 'plugin_action_input_schema_invalid', error: 'plugin_action_input_schema_invalid',
            details: { kind: 'managedNative', nativeCause: { localCause: 'plugin_action_input_schema_invalid',
                action: { pluginId: 'acme.compute', localId: 'exec' },
                issues } } });
        expect(diagnostic).toContain('acme.compute/exec');
        expect(diagnostic).toContain('resource.containerId');
        expect(diagnostic).toContain('argv.1');
        expect(diagnostic).toContain('required');
        expect(diagnostic).toContain('type');
        expect(diagnostic).toContain('<root>: type');
        expect(diagnostic).not.toContain('private validation prose');
        expect(diagnostic).not.toContain('rejected-private-value');
    });
    it('shows the projected Lima stderr reason alongside the failed native command', () => {
        const diagnostic = describeManagedOperationDiagnostic({ errorCode: 'native_acquisition_unconfirmed', error: 'Native acquisition unconfirmed',
            details: { kind: 'managedNative', nativeCause: { localCause: 'native_command_failed', command: 'restart', exitCode: 1,
                stderr: 'failed to download template:ubuntu: no such file or directory' } } });
        expect(diagnostic).toContain('restart');
        expect(diagnostic).toContain('no such file or directory');
    });
});
