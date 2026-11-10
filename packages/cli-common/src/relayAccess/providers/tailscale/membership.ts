import type { MachineRecipeTargetFactKeyV1, MachineRecipeV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';

const inputSchema = {
    type: 'object', additionalProperties: false,
    properties: {
        setupCredentialFile: { type: 'string', minLength: 1 },
        switchNetwork: { type: 'boolean' },
        setOperator: { type: 'boolean' },
    },
    required: ['switchNetwork', 'setOperator'],
} satisfies NonNullable<MachineRecipeV1['inputSchema']>;

const connected = { op: 'and' as const, all: [
    { op: 'eq' as const, path: 'BackendState', value: 'Running' },
    { op: 'eq' as const, path: 'Self.Online', value: true },
] };

/** A selected key is a reviewed finite intent, not a persistent desired network.
 * `down` preserves the existing login/profile; it does not perform logout.
 * The ordinary P20 interpreter reobserves join after the first drifted step,
 * so a Running old profile cannot suppress the selected key's authentication.
 */
export function createTailscaleJoinSteps(binding: Readonly<{
    credentialFile: string | Readonly<{ kind: 'input'; path: string }> | Readonly<{ kind: 'targetFact'; fact: MachineRecipeTargetFactKeyV1 }>;
    credentialInputPath: string;
    switchNetworkInputPath?: string;
}> = { credentialFile: { kind: 'input', path: 'setupCredentialFile' }, credentialInputPath: 'setupCredentialFile' }): MachineRecipeV1['steps'] {
    return [
            { id: 'tailscale-switch', kind: 'command', executable: 'tailscale', args: ['down'],
                review: { title: 'Switch Tailscale network', description: 'Disconnect the observed profile before authenticating with the selected key. A failed authentication leaves that profile stopped; its saved login is retained.' },
                when: [{ input: { op: 'truthy', path: binding.switchNetworkInputPath ?? 'switchNetwork' } }],
                check: { executable: 'tailscale', args: ['status', '--json'], unsatisfiedExitCodes: [],
                    stdoutJson: { op: 'eq', path: 'BackendState', value: 'Stopped' } } },
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
                when: [{ input: { op: 'truthy', path: 'setOperator' } }],
                check: { executable: 'tailscale', args: ['debug', 'prefs'], unsatisfiedExitCodes: [],
                    stdoutJson: { op: 'eq', path: 'OperatorUser', value: { kind: 'targetFact', fact: 'daemon.username' } } } },
    ];
}

export const tailscaleMembershipPrograms: Readonly<{ join: MachineRecipeV1; leave: MachineRecipeV1 }> = {
    join: {
        id: 'tailscale-join', revision: '1', title: 'Join Tailscale', inputSchema,
        steps: createTailscaleJoinSteps(),
    },
    leave: {
        id: 'tailscale-leave', revision: '1', title: 'Leave Tailscale', inputSchema,
        steps: [{ id: 'tailscale-leave', kind: 'command', executable: 'tailscale', args: ['down'],
            review: { title: 'Disconnect Tailscale', description: 'Stop this Machine’s current Tailscale connection without deleting its saved login.' },
            check: { executable: 'tailscale', args: ['status', '--json'], unsatisfiedExitCodes: [],
                stdoutJson: { op: 'eq', path: 'BackendState', value: 'Stopped' } } }],
    },
};
