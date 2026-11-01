import { describe, expect, it } from 'vitest';
import { describeManagedOperationDiagnostic } from './managedNativeFailurePresentation';

describe('managed native failure Details', () => {
    it('shows the projected Lima stderr reason alongside the failed native command', () => {
        const diagnostic = describeManagedOperationDiagnostic({ errorCode: 'native_acquisition_unconfirmed', error: 'Native acquisition unconfirmed',
            details: { kind: 'managedNative', nativeCause: { localCause: 'native_command_failed', command: 'restart', exitCode: 1,
                stderr: 'failed to download template:ubuntu: no such file or directory' } } });
        expect(diagnostic).toContain('restart');
        expect(diagnostic).toContain('no such file or directory');
    });
});
