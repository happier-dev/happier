import type { MachineRecipeTargetFactKeyV1, MachineRecipeV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { defineAccessProviderSchemas } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import { defineProtocolObject } from '@happier-dev/protocol/plugins/actions/protocolComposableSchema';

const roles = defineAccessProviderSchemas({ config: defineProtocolObject({}, { policy: 'closed' }) });

const connected = { op: 'and' as const, all: [
    { op: 'eq' as const, path: 'BackendState', value: 'Running' },
    { op: 'eq' as const, path: 'Self.Online', value: true },
] };

// Switching networks disconnects the previous profile while retaining its login.
const stopped = {
    executable: 'tailscale', args: ['debug', 'prefs'], unsatisfiedExitCodes: [],
    stdoutJson: { op: 'eq', path: 'WantRunning', value: false },
} satisfies Extract<MachineRecipeV1['steps'][number], { kind: 'command' }>['check'];

export const tailscaleLogoutCommand = { executable: 'tailscale', args: ['logout'] } as const;

const loggedOut = {
    executable: 'tailscale', args: ['status', '--json'], unsatisfiedExitCodes: [],
    stdoutJson: { op: 'and', all: [
        { op: 'eq', path: 'BackendState', value: 'NeedsLogin' },
        { op: 'not', predicate: { op: 'truthy', path: 'HaveNodeKey' } },
    ] },
} satisfies Extract<MachineRecipeV1['steps'][number], { kind: 'command' }>['check'];

/** A selected key is a reviewed finite intent, not a persistent desired network.
 * `down` preserves the existing login/profile; it does not perform logout.
 * The ordinary P20 interpreter reobserves join after the first drifted step,
 * so a Running old profile cannot suppress the selected key's authentication.
 */
export function createTailscaleJoinSteps(binding: Readonly<{
    credentialFile: string | Readonly<{ kind: 'input'; path: string }> | Readonly<{ kind: 'targetFact'; fact: MachineRecipeTargetFactKeyV1 }>;
    credentialInputPath: string;
    switchNetworkInputPath?: string;
    membershipFlagsPath?: string;
}> = { credentialFile: { kind: 'input', path: 'setupCredentialFile' }, credentialInputPath: 'setupCredentialFile' }): MachineRecipeV1['steps'] {
    return [
            { id: 'tailscale-switch', kind: 'command', executable: 'tailscale', args: ['down'],
                review: { title: 'Switch Tailscale network', description: 'Disconnect the observed profile before authenticating with the selected key. A failed authentication leaves that profile stopped; its saved login is retained.' },
                when: [{ input: binding.membershipFlagsPath
                    ? { op: 'includes', path: binding.membershipFlagsPath, value: 'switch-network' }
                    : { op: 'truthy', path: binding.switchNetworkInputPath ?? 'switchNetwork' } }],
                check: stopped },
            { id: 'tailscale-join', kind: 'command', executable: 'tailscale',
                args: ['up', '--force-reauth', { kind: 'template', value: '--auth-key=file:{file}',
                    variables: { file: binding.credentialFile } }],
                when: [{ input: { op: 'truthy', path: binding.credentialInputPath } }],
                check: { executable: 'tailscale', args: ['status', '--json'], unsatisfiedExitCodes: [],
                    stdoutJson: connected } },
            { id: 'tailscale-resume', kind: 'command', executable: 'tailscale', args: ['up'],
                when: [{ input: { op: 'not', predicate: { op: 'truthy', path: binding.credentialInputPath } } }],
                check: { executable: 'tailscale', args: ['status', '--json'], unsatisfiedExitCodes: [],
                    stdoutJson: connected } },
            { id: 'tailscale-operator', kind: 'command', executable: 'tailscale',
                args: ['set', { kind: 'template', value: '--operator={daemon}',
                    variables: { daemon: { kind: 'targetFact', fact: 'daemon.username' } } }],
                // Only an explicit `false` opts out; the Tailscale server recipe leaves it unset by default.
                when: [{ input: binding.membershipFlagsPath
                    ? { op: 'includes', path: binding.membershipFlagsPath, value: 'set-operator' }
                    : { op: 'not', predicate: { op: 'eq', path: 'setOperator', value: false } } }],
                check: { executable: 'tailscale', args: ['debug', 'prefs'], unsatisfiedExitCodes: [],
                    stdoutJson: { op: 'eq', path: 'OperatorUser', value: { kind: 'targetFact', fact: 'daemon.username' } } } },
    ];
}

export const tailscaleMembershipPrograms: Readonly<{ join: MachineRecipeV1; leave: MachineRecipeV1 }> = {
    join: {
        id: 'tailscale-join', revision: '1', title: 'Join Tailscale', inputSchema: roles.joinInput.jsonSchema,
        steps: createTailscaleJoinSteps({
            credentialFile: { kind: 'input', path: 'setupCredentialFile' },
            credentialInputPath: 'setupCredentialFile',
            membershipFlagsPath: 'membership.flags',
        }),
    },
    leave: {
        id: 'tailscale-leave', revision: '2', title: 'Leave Tailscale', inputSchema: roles.leaveInput.jsonSchema,
        steps: [{ id: 'tailscale-leave', kind: 'command',
            executable: tailscaleLogoutCommand.executable, args: [...tailscaleLogoutCommand.args],
            review: { title: 'Log out of Tailscale', description: 'Leave the current tailnet. This Machine will need to authenticate to join again.' },
            check: loggedOut }],
    },
};
