import { describe, expect, it } from 'vitest';
import { t } from '@/text';
import { ManagedNativeFailureDetailsV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { describeManagedActionFailureDiagnostic, describeManagedObservationDiagnostic, describeManagedOperationDiagnostic, describeManagedPresetAvailabilityFailure, describeManagedPresetKeyPending } from './managedNativeFailurePresentation';
import { MACHINE_PRESET_TEAM_KEY_PENDING } from '@/sync/domains/machines/presets/machinePresetReadFailure';

describe('managed native failure Details', () => {
    it('shows the retained cleanup failure in pending acquisition operation and observation Details', () => {
        const details = { kind: 'managedNative', nativeCause: { localCause: 'native_command_failed', command: 'up', exitCode: null,
            failureCause: { phase: 'exec.run', errorClass: 'Error', errorCode: 'plugin_exec_termination_incomplete', httpStatus: null } } };
        const parsed = ManagedNativeFailureDetailsV1Schema.parse(details);
        for (const diagnostic of [describeManagedOperationDiagnostic({ errorCode: 'native_acquisition_unconfirmed',
            error: 'private cleanup prose', details: parsed }),
            describeManagedObservationDiagnostic({ reason: 'native_acquisition_pending', nativeCause: parsed.nativeCause })]) {
            expect(diagnostic).toContain('plugin_exec_termination_incomplete');
            expect(diagnostic).toContain('exec.run');
            expect(diagnostic).not.toContain('exit 23');
            expect(diagnostic).not.toContain('private cleanup prose');
        }
    });
    it('shows the closed guest carrier reasons in immediate and retained operation Details', () => {
        const details = { kind: 'managedGuestHome', homeOrigin: 'https://home.example.test',
            carrierFailure: { attemptedCarrier: 'https', reason: 'home_unreachable',
                irohAttempt: { outcome: 'unavailable', reason: 'transport_timeout' } } } as const;
        for (const diagnostic of [describeManagedActionFailureDiagnostic('home_not_guest_reachable', details),
            describeManagedOperationDiagnostic({ errorCode: 'home_not_guest_reachable', error: 'private diagnostic', details }),
            describeManagedObservationDiagnostic({ reason: 'bootstrap.home_not_guest_reachable', carrierFailure: details.carrierFailure })]) {
            expect(diagnostic).toContain('https');
            expect(diagnostic).toContain('home_unreachable');
            expect(diagnostic).toContain('transport_timeout');
            expect(diagnostic).not.toContain('private diagnostic');
            expect(diagnostic).not.toContain(details.homeOrigin);
        }
    });
    it('retains the Action owner cause through immediate and observed managed failures', () => {
        const failureCause = { phase: 'machines.managed.acquire', errorClass: 'ManagedMachineControllerError' as const,
            errorCode: 'credential_scope_denied', httpStatus: null };
        const immediate = describeManagedActionFailureDiagnostic('action_failed', undefined, 'member-acquire', failureCause);
        const observed = describeManagedOperationDiagnostic({ errorCode: 'action_failed', error: 'action_failed', failureCause });
        for (const diagnostic of [immediate, observed]) {
            expect(diagnostic).toContain('credential_scope_denied');
            expect(diagnostic).toContain('ManagedMachineControllerError');
        }
        expect(immediate).toContain('member-acquire');
    });

    it.each([
        'permission_denied', 'controller_unavailable', 'credential_unavailable', 'provider_unavailable',
        'controller_retired', 'request_conflict', 'intent_changed', 'managed_not_found', 'enrollment_retired',
    ] as const)('localizes the preset availability refusal %s through the existing Session copy', (code) => {
        // The controller refusal says what the machine list says beside the same preset.
        const expected = code === 'controller_unavailable' ? t('managedMachines.controller.requiredUnnamed') : t(`session.startFailure.cause.${code}`);
        expect(expected).not.toContain('startFailure.cause.');
        expect(describeManagedPresetAvailabilityFailure(code)).toBe(expected);
    });

    it('retains native refusal cause and Request ID for the existing Details presenter', () => {
        const details = ManagedNativeFailureDetailsV1Schema.parse({ kind: 'managedNative', nativeCause: { httpStatusClass: '4xx', code: 'not_found' } });
        const diagnostic = describeManagedActionFailureDiagnostic('provider_unavailable', details, 'member-acquire');
        expect(diagnostic).toContain('provider_unavailable');
        expect(diagnostic).toContain('not_found');
        expect(diagnostic).toContain('member-acquire');
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
    it('presents a preset waiting for its key as a state with no code behind Details', () => {
        expect(describeManagedPresetKeyPending(MACHINE_PRESET_TEAM_KEY_PENDING)).toEqual({
            title: t('machinePresets.keyPendingTitle'), reason: t('machinePresets.keyPendingReason') });
        expect(describeManagedPresetKeyPending('permission_denied')).toBeNull();
    });
});
