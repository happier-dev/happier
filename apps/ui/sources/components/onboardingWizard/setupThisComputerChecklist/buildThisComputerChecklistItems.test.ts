import { describe, expect, it } from 'vitest';

import { buildThisComputerChecklistItems } from './buildThisComputerChecklistItems';

describe('buildThisComputerChecklistItems', () => {
    it('omits auth steps when sign-in is already satisfied and marks satisfied items as included', () => {
        const items = buildThisComputerChecklistItems({
            activeRelayUrl: 'https://relay.example.test',
            serviceInstalled: true,
            daemonRunning: false,
            machineId: null,
            needsAuth: false,
            daemonServerUrl: 'https://relay.example.test',
            daemonComparableKey: 'https://relay.example.test',
            daemonAccountId: 'acct_1',
            daemonMachineRegistered: true,
            uiAccountId: 'acct_1',
            serverMismatch: false,
            accountMismatch: false,
            pairingRequired: false,
            relayDriftBanner: null,
        });

        expect(items.map((item) => item.id)).toEqual([
            'setup.thisComputer.resolveRelay',
            'setup.thisComputer.checkAuth',
            'setup.thisComputer.configureRelay',
            'setup.thisComputer.installService',
            'setup.thisComputer.startService',
            'setup.thisComputer.verifyService',
        ]);

        expect(items.every((item) => item.defaultSelected === true)).toBe(true);
        expect(items.find((item) => item.id === 'setup.thisComputer.resolveRelay')?.disabled).toBe(true);
        expect(items.find((item) => item.id === 'setup.thisComputer.checkAuth')?.disabled).toBe(true);
        expect(items.find((item) => item.id === 'setup.thisComputer.installService')?.disabled).toBe(true);
        expect(items.find((item) => item.id === 'setup.thisComputer.startService')?.disabled).toBe(false);
        expect(items.find((item) => item.id === 'setup.thisComputer.resolveRelay')?.satisfied).toBe(true);
        expect(items.find((item) => item.id === 'setup.thisComputer.checkAuth')?.satisfied).toBe(true);
        expect(items.find((item) => item.id === 'setup.thisComputer.installService')?.satisfied).toBe(true);
        expect(items.find((item) => item.id === 'setup.thisComputer.startService')?.satisfied).toBe(false);
    });

    it('includes auth steps and surfacing relay drift when the daemon still needs sign-in', () => {
        const items = buildThisComputerChecklistItems({
            activeRelayUrl: 'https://relay.example.test',
            serviceInstalled: false,
            daemonRunning: false,
            machineId: null,
            needsAuth: true,
            daemonServerUrl: 'https://relay.example.test',
            daemonComparableKey: 'https://relay.example.test',
            daemonAccountId: null,
            daemonMachineRegistered: false,
            uiAccountId: 'acct_1',
            serverMismatch: true,
            accountMismatch: false,
            pairingRequired: true,
            relayDriftBanner: {
                kind: 'warning',
                title: 'Relay mismatch',
                description: 'App and daemon point to different relays.',
                actionLabel: 'Repair',
                isRepairStarting: false,
                repairTaskSnapshot: null,
                onPress: () => {},
            },
        });

        expect(items.map((item) => item.id)).toEqual([
            'setup.thisComputer.resolveRelay',
            'setup.thisComputer.checkAuth',
            'setup.thisComputer.configureRelay',
            'setup.thisComputer.auth.request',
            'setup.thisComputer.auth.wait',
            'setup.thisComputer.installService',
            'setup.thisComputer.startService',
            'setup.thisComputer.verifyService',
        ]);

        expect(items.find((item) => item.id === 'setup.thisComputer.configureRelay')?.satisfied).toBe(false);
        expect(items.find((item) => item.id === 'setup.thisComputer.configureRelay')?.badge).toBe('Mismatch');
    });

    it('surfaces account mismatch as an unsatisfied auth check even when the daemon is otherwise authenticated', () => {
        const items = buildThisComputerChecklistItems({
            activeRelayUrl: 'https://relay.example.test',
            serviceInstalled: true,
            daemonRunning: true,
            machineId: 'machine_1',
            needsAuth: false,
            daemonServerUrl: 'https://relay.example.test',
            daemonComparableKey: 'https://relay.example.test',
            daemonAccountId: 'acct_daemon',
            daemonMachineRegistered: true,
            uiAccountId: 'acct_ui',
            serverMismatch: false,
            accountMismatch: true,
            pairingRequired: false,
            relayDriftBanner: null,
        });

        expect(items.find((item) => item.id === 'setup.thisComputer.checkAuth')?.satisfied).toBe(false);
        expect(items.find((item) => item.id === 'setup.thisComputer.checkAuth')?.badge).toBe('Mismatch');
    });
});
