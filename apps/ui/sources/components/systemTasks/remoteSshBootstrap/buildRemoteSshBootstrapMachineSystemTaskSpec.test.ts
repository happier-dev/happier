import { describe, expect, it } from 'vitest';
import { parseRemoteBootstrapMachineParams } from '@happier-dev/cli-common/systemTasks';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';

import { buildRemoteSshBootstrapMachineSystemTaskSpec } from './buildRemoteSshBootstrapMachineSystemTaskSpec';

describe('buildRemoteSshBootstrapMachineSystemTaskSpec', () => {
    it.each(['none', 'ask'] as const)('carries dedicated %s identity through the real remote task parser', adminAccessAtCreation => {
        const enrollmentIdentity = { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'server',
            adminAccessAtCreation, ...(adminAccessAtCreation === 'ask' ? { administrator: { username: 'operator' } } : {}) } as const;
        const spec = buildRemoteSshBootstrapMachineSystemTaskSpec({ relayUrl: 'https://home.example.test', channel: 'stable',
            sshAuth: 'keyfile', sshHost: 'server.example.test', enrollmentIdentity });
        expect(parseRemoteBootstrapMachineParams(spec.params).enrollmentIdentity).toEqual(enrollmentIdentity);
    });

    it('respects serviceMode=none', () => {
        const spec = buildRemoteSshBootstrapMachineSystemTaskSpec({
            relayUrl: 'http://localhost:53288',
            channel: 'stable',
            sshAuth: 'agent',
            sshUsername: 'root',
            sshHost: 'example.com',
            serviceMode: 'none',
        });

        const params = spec.params as Record<string, unknown>;
        expect(params.serviceMode).toBe('none');
        expect(params.channel).toBe('stable');
    });

    it('emits a canonical Home target that the remote task parser retains', () => {
        const homeTarget = resolveHomeTargetFromDescriptor({
            authority: 'current_connection',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_ui_home',
                canonicalServerUrl: 'https://home.example.test',
                revision: 1,
                endpoints: [{ kind: 'https', url: 'https://home.example.test' }],
            },
        });
        const spec = buildRemoteSshBootstrapMachineSystemTaskSpec({
            relayUrl: 'https://home.example.test',
            homeTarget,
            channel: 'dev',
            sshAuth: 'agent',
            sshUsername: 'dev',
            sshHost: 'remote.example.test',
        });

        expect(parseRemoteBootstrapMachineParams(spec.params).homeTarget).toEqual(homeTarget);
    });
});
