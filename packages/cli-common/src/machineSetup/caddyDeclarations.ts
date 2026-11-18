import type { MachineRecipeStepDeclarationV1, MachineRecipeStepV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { machineStateRootStep } from './stateRoot.js';

/** Shared P20 prerequisites; P41 owns the container, listeners and route topology. */
export const nativeCaddyProfile = {
    id: 'caddy', revision: 1, containerName: 'happier-caddy',
    stateDirectory: '/var/lib/happier/caddy', adminDirectory: '/run/happier-caddy',
    portRequirement: { id: 'caddy-private-origin', exposure: 'privateNetwork', protocol: 'tcp',
        containerPort: 8080, hostPort: 8080 },
    publicPortRequirements: [
        { id: 'caddy-public-http', exposure: 'public', protocol: 'tcp', containerPort: 80, hostPort: 80 },
        { id: 'caddy-public-https', exposure: 'public', protocol: 'tcp', containerPort: 443, hostPort: 443 },
    ],
} as const;

type Directory = Extract<MachineRecipeStepDeclarationV1, { kind: 'directory' }>;
type File = Extract<MachineRecipeStepDeclarationV1, { kind: 'file' }>;
type LiteralContent = Extract<NonNullable<File['content']>, { kind: 'literal' }>;

/** Pure declarations consumed by cold recipes and the native setup adapter. */
export function createCaddyContainerSetupDeclarations(input: Readonly<{
    stateDirectory?: string; stateRootDirectory?: string; adminDirectory?: string;
    daemonGroup: string; initialConfig: string; expectedContentDigest?: string;
}>): MachineRecipeStepV1[];
export function createCaddyContainerSetupDeclarations(input: Readonly<{
    stateDirectory?: string; stateRootDirectory?: string; adminDirectory?: string;
    daemonGroup: Directory['group']; initialConfig: LiteralContent['value']; expectedContentDigest?: string;
}>): MachineRecipeStepDeclarationV1[];
export function createCaddyContainerSetupDeclarations(input: Readonly<{
    stateDirectory?: string; stateRootDirectory?: string; adminDirectory?: string;
    daemonGroup: Directory['group']; initialConfig: LiteralContent['value'];
    expectedContentDigest?: string;
}>): MachineRecipeStepV1[] | MachineRecipeStepDeclarationV1[] {
    const stateDirectory = input.stateDirectory ?? nativeCaddyProfile.stateDirectory;
    const adminDirectory = input.adminDirectory ?? nativeCaddyProfile.adminDirectory;
    const daemonGroup = input.daemonGroup;
    // Docker restarts the retained container after /run has been cleared. Its
    // bind source must exist before Docker starts, independently of the daemon.
    const bootRule = `d ${JSON.stringify(adminDirectory.replaceAll('%', '%%'))} 0750 root `;
    const bootContent: File['content'] = typeof daemonGroup === 'string'
        ? { kind: 'literal', value: `${bootRule}${daemonGroup} -\n` }
        : { kind: 'template', value: `${bootRule}${daemonGroup.kind === 'template' ? daemonGroup.value : '{daemonGroup}'} -\n`,
            variables: daemonGroup.kind === 'template' ? daemonGroup.variables : { daemonGroup } };
    return [
        { ...machineStateRootStep, path: input.stateRootDirectory ?? machineStateRootStep.path },
        { id: 'caddy-state-directory', kind: 'directory', path: stateDirectory, owner: 'root', group: input.daemonGroup, mode: 0o750 },
        ...['data', 'config', 'logs'].map((name): MachineRecipeStepDeclarationV1 => ({
            id: `caddy-${name}-directory`, kind: 'directory', path: `${stateDirectory}/${name}`, owner: 'root', group: 'root', mode: 0o700,
        })),
        { id: 'caddy-admin-directory', kind: 'directory', path: adminDirectory, owner: 'root', group: input.daemonGroup, mode: 0o750 },
        { id: 'caddy-initial-config', kind: 'file', path: `${stateDirectory}/initial.json`, owner: 'root', group: input.daemonGroup, mode: 0o640,
            ...(input.expectedContentDigest !== undefined ? { expectedContentDigest: input.expectedContentDigest } : {}),
            content: { kind: 'literal', value: input.initialConfig } },
        { id: 'caddy-boot-config-directory', kind: 'directory', path: '/etc/tmpfiles.d', owner: 'root', group: 'root', mode: 0o755 },
        { id: 'caddy-admin-boot-directory', kind: 'file', path: '/etc/tmpfiles.d/happier-caddy.conf', owner: 'root', group: 'root', mode: 0o644,
            content: bootContent },
    ];
}
