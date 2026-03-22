import { describe, expect, it } from 'vitest';

import { resolveDaemonDiagnosticSubsystemGates } from './diagnosticSubsystemGates';

describe('resolveDaemonDiagnosticSubsystemGates', () => {
    it('defaults all diagnostic gates to false', () => {
        expect(resolveDaemonDiagnosticSubsystemGates({})).toEqual({
            disableMachineSync: false,
            disableAutomationWorker: false,
        });
    });

    it('parses enabled diagnostic disable flags from env', () => {
        expect(
            resolveDaemonDiagnosticSubsystemGates({
                HAPPIER_DAEMON_DIAGNOSTIC_DISABLE_MACHINE_SYNC: '1',
                HAPPIER_DAEMON_DIAGNOSTIC_DISABLE_AUTOMATION_WORKER: 'true',
            }),
        ).toEqual({
            disableMachineSync: true,
            disableAutomationWorker: true,
        });
    });
});
