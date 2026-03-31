import { describe, expect, it } from 'vitest';

import type { PlanChecklistExecutionState } from '@/components/systemTasks/planChecklist';

import { buildThisComputerChecklistDiagnosticsPayload } from './buildThisComputerChecklistDiagnosticsPayload';

describe('buildThisComputerChecklistDiagnosticsPayload', () => {
    it('sanitizes urls and redacts ids so raw sensitive values are not copied', () => {
        const rawRelayUrl = 'https://relay.example.test/path/?token=secret#frag';
        const rawDaemonUrl = 'https://daemon.example.test/?apiKey=supersecret';
        const rawUiAccountId = 'acct_ui_sensitive_1234567890';
        const rawDaemonAccountId = 'acct_daemon_sensitive_0987654321';
        const rawMachineId = 'machine_sensitive_abcdef123456';

        const payload = buildThisComputerChecklistDiagnosticsPayload({
            itemId: 'setup.thisComputer.configureRelay',
            selectedIds: ['setup.thisComputer.configureRelay'],
            preflight: {
                activeRelayUrl: rawRelayUrl,
                serviceInstalled: true,
                daemonRunning: true,
                machineId: rawMachineId,
                needsAuth: false,
                daemonServerUrl: rawDaemonUrl,
                daemonComparableKey: rawDaemonUrl,
                daemonAccountId: rawDaemonAccountId,
                daemonMachineRegistered: true,
                uiAccountId: rawUiAccountId,
                serverMismatch: true,
                accountMismatch: true,
                pairingRequired: true,
                relayDriftBanner: null,
            },
            activeTaskSnapshot: null,
            executionById: {
                'setup.thisComputer.configureRelay': {
                    status: 'error',
                    logs: [{ ts: 1, level: 'error', message: 'failed' }],
                    error: { title: 'error_code', message: 'boom' },
                } satisfies PlanChecklistExecutionState,
            },
        });

        const serialized = JSON.stringify(payload);

        expect(payload.activeRelayUrl).not.toContain('token=secret');
        expect(payload.activeRelayUrl).not.toContain('#frag');
        expect(payload.daemon?.serverUrl).not.toContain('apiKey=');

        expect(serialized).not.toContain(rawUiAccountId);
        expect(serialized).not.toContain(rawDaemonAccountId);
        expect(serialized).not.toContain(rawMachineId);

        expect(payload.uiAccountId).not.toBe(rawUiAccountId);
        expect(payload.daemon?.accountId).not.toBe(rawDaemonAccountId);
        expect(payload.daemon?.machineId).not.toBe(rawMachineId);
    });
});
