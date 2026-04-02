import { describe, expect, it } from 'vitest';

import { computeThisComputerMismatches } from './computeThisComputerMismatches';

describe('computeThisComputerMismatches', () => {
    it('treats daemon comparable key mismatch as a server mismatch', () => {
        expect(computeThisComputerMismatches({
            activeRelayUrl: 'https://relay.example.test',
            activeLocalRelayUrl: null,
            daemonComparableKey: 'https://other.example.test',
            daemonAccountId: 'acct_1',
            uiAccountId: 'acct_1',
            needsAuth: false,
            machineId: 'machine_1',
            machineRegistered: true,
        })).toEqual({
            serverMismatch: true,
            accountMismatch: false,
            pairingRequired: false,
        });
    });

    it('treats different daemon account id as an account mismatch', () => {
        expect(computeThisComputerMismatches({
            activeRelayUrl: 'https://relay.example.test',
            activeLocalRelayUrl: null,
            daemonComparableKey: 'https://relay.example.test',
            daemonAccountId: 'acct_daemon',
            uiAccountId: 'acct_ui',
            needsAuth: false,
            machineId: 'machine_1',
            machineRegistered: true,
        })).toEqual({
            serverMismatch: false,
            accountMismatch: true,
            pairingRequired: false,
        });
    });

    it('requires pairing when machine is not registered even if needsAuth is false', () => {
        expect(computeThisComputerMismatches({
            activeRelayUrl: 'https://relay.example.test',
            activeLocalRelayUrl: null,
            daemonComparableKey: 'https://relay.example.test',
            daemonAccountId: 'acct_1',
            uiAccountId: 'acct_1',
            needsAuth: false,
            machineId: null,
            machineRegistered: false,
        })).toEqual({
            serverMismatch: false,
            accountMismatch: false,
            pairingRequired: true,
        });
    });
});
