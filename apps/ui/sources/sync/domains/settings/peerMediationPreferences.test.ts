import { describe, expect, it } from 'vitest';

import {
    DEFAULT_PEER_MEDIATION_PREFERENCES_V1,
    PeerMediationFlowKindV1Schema,
    type PeerMediationFlowKindV1,
    type PeerMediationPreferencesV1,
} from '@happier-dev/protocol/account/settings/peerMediationPreferencesV1';
import { resolveEffectivePeerDirectRoutePolicy } from '@happier-dev/peer-mediation';

import {
    readDirectConnectionsEnabled,
    readMachineDirectConnectionChoice,
    withDirectConnectionsEnabled,
    withMachineDirectConnectionChoice,
} from './peerMediationPreferences';

const FLOWS = PeerMediationFlowKindV1Schema.options;

/** What the canonical fold decides for one flow, given the stored preferences and a permissive server. */
function allowed(preferences: PeerMediationPreferencesV1, flowKind: PeerMediationFlowKindV1, machineId = 'machine-a'): boolean {
    return resolveEffectivePeerDirectRoutePolicy({
        flowKind,
        routeKind: 'loopback_direct',
        serverGateEnabled: true,
        daemonPolicy: null,
        accountDefaultPreference: preferences.flows[flowKind]?.direct ?? 'inherit',
        accountMachinePreference: preferences.byMachineId[machineId]?.flows[flowKind]?.direct ?? 'inherit',
        productDefaultPreference: 'enabled',
        grant: { status: 'valid' },
    }).allowed;
}

describe('direct connection preferences', () => {
    it('reads the untouched account as connecting directly (the product default)', () => {
        expect(readDirectConnectionsEnabled(DEFAULT_PEER_MEDIATION_PREFERENCES_V1)).toBe(true);
        expect(readMachineDirectConnectionChoice(DEFAULT_PEER_MEDIATION_PREFERENCES_V1, 'machine-a')).toBe('default');
    });

    it('turning direct connections off stops every flow from connecting directly, and on restores the default', () => {
        const off = withDirectConnectionsEnabled(DEFAULT_PEER_MEDIATION_PREFERENCES_V1, false);
        expect(readDirectConnectionsEnabled(off)).toBe(false);
        for (const flow of FLOWS) expect(allowed(off, flow)).toBe(false);

        const on = withDirectConnectionsEnabled(off, true);
        expect(readDirectConnectionsEnabled(on)).toBe(true);
        for (const flow of FLOWS) expect(allowed(on, flow)).toBe(true);
    });

    it('lets one machine differ from the account and return to following it', () => {
        const accountOff = withDirectConnectionsEnabled(DEFAULT_PEER_MEDIATION_PREFERENCES_V1, false);

        const direct = withMachineDirectConnectionChoice(accountOff, 'machine-a', 'direct');
        expect(readMachineDirectConnectionChoice(direct, 'machine-a')).toBe('direct');
        for (const flow of FLOWS) {
            expect(allowed(direct, flow, 'machine-a')).toBe(true);
            // Another machine still follows the account.
            expect(allowed(direct, flow, 'machine-b')).toBe(false);
        }

        const relay = withMachineDirectConnectionChoice(DEFAULT_PEER_MEDIATION_PREFERENCES_V1, 'machine-a', 'relay');
        for (const flow of FLOWS) expect(allowed(relay, flow, 'machine-a')).toBe(false);

        const back = withMachineDirectConnectionChoice(relay, 'machine-a', 'default');
        expect(readMachineDirectConnectionChoice(back, 'machine-a')).toBe('default');
        expect(back.byMachineId['machine-a']).toBeUndefined();
        for (const flow of FLOWS) expect(allowed(back, flow, 'machine-a')).toBe(true);
    });

    it('keeps other machines and fields untouched when one choice changes', () => {
        const withB = withMachineDirectConnectionChoice(DEFAULT_PEER_MEDIATION_PREFERENCES_V1, 'machine-b', 'relay');
        const next = withDirectConnectionsEnabled(withB, false);
        expect(readMachineDirectConnectionChoice(next, 'machine-b')).toBe('relay');
        expect(next.v).toBe(1);
    });
});
