import { describe, expect, it } from 'vitest';

import { buildRemoteSshBootstrapMachineSystemTaskSpec } from './buildRemoteSshBootstrapMachineSystemTaskSpec';

describe('buildRemoteSshBootstrapMachineSystemTaskSpec', () => {
    it('respects serviceMode=none', () => {
        const spec = buildRemoteSshBootstrapMachineSystemTaskSpec({
            relayUrl: 'http://localhost:53288',
            sshAuth: 'agent',
            sshUsername: 'root',
            sshHost: 'example.com',
            serviceMode: 'none',
        });

        const params = spec.params as Record<string, unknown>;
        expect(params.serviceMode).toBe('none');
    });
});
