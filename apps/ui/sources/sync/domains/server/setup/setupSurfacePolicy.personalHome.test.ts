import { describe, expect, it } from 'vitest';

import { canHostPersonalHomeHere, resolvePersonalHomeAdmission, type SetupSurfacePolicy } from './setupSurfacePolicy';

const policy: SetupSurfacePolicy = {
    relay: {
        allowRelaySelection: true, allowHappierCloud: true, allowCustomRelayUrl: true,
        allowLocalRelayHost: true, allowRemoteSshRelayHost: true, enforcedServerUrl: null,
    },
    machine: { allowLocalMachineSetup: true, allowRemoteSshMachineSetup: true },
    providers: { allowProviderSetup: true },
    relayAccess: { allowTailscale: true, allowCloudflareTunnel: true },
};

describe('Personal Home admission', () => {
    it.each(['auto', 'offer', 'off'] as const)('admits %s only on a bootstrap host', (personalHome) => {
        expect(resolvePersonalHomeAdmission(policy, { host: true, personalHome })).toBe(personalHome);
        expect(resolvePersonalHomeAdmission(policy, { host: false, personalHome })).toBe('off');
    });

    it.each(['allowRelaySelection', 'allowLocalRelayHost'] as const)('honors the build denial %s for both automatic and manual creation', (key) => {
        const denied = { ...policy, relay: { ...policy.relay, [key]: false } };
        expect(resolvePersonalHomeAdmission(denied, { host: true, personalHome: 'auto' })).toBe('off');
        expect(resolvePersonalHomeAdmission(denied, { host: true, personalHome: 'offer' })).toBe('off');
        expect(canHostPersonalHomeHere(denied)).toBe(false);
    });
});
