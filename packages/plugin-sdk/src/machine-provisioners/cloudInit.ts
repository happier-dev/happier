import { computeSshHostKeyFingerprint } from '@happier-dev/protocol/ssh/hostTrust';

export { computeSshHostKeyFingerprint };
import type { MachineProvisionerBootstrapCarrierV1 } from '../machineProvisioners.js';

/** Bootstrap-only login; enrollment creates the dedicated daemon identity. */
export const MACHINE_PROVISIONER_CLOUD_SSH_USER = 'happier-bootstrap';

/** Invocation-private material from the retained bootstrap bundle, never an Action operand. */
export type MachineProvisionerCloudHostKeyV1 = Readonly<{ publicKey: string; privateKey: string }>;

/** Key-only bootstrap principal shared by cloud-init creation and SSH connection. */
export function buildMachineProvisionerCloudInit(bootstrapPublicKey: string, guestHostKey?: MachineProvisionerCloudHostKeyV1): string {
    // JSON is a YAML subset and preserves public-key bytes without YAML interpolation.
    // This temporary principal's sudo grant is separate from the daemon's policy.
    return `#cloud-config\n${JSON.stringify({
        users: [{ name: MACHINE_PROVISIONER_CLOUD_SSH_USER, shell: '/bin/bash', lock_passwd: true,
            sudo: 'ALL=(ALL) NOPASSWD:ALL', ssh_authorized_keys: [bootstrapPublicKey] }],
        ssh_pwauth: false,
        // cloud-init's SSH init module runs before sshd; runcmd is too late.
        ...(guestHostKey ? { ssh_keys: { ed25519_private: guestHostKey.privateKey, ed25519_public: guestHostKey.publicKey } } : {}),
    })}\n`;
}

/** The native/OpenSSH transport authenticates this generated pin before any pairing bytes. */
export function buildMachineProvisionerPinnedSshBootstrap(input: Readonly<{
    connection: Readonly<{ address: string; user: string; port?: number }>;
    guestHostPublicKey: string;
    credentialRef: Readonly<{ kind: 'shared_resource'; resourceId: string }>;
}>): Extract<MachineProvisionerBootstrapCarrierV1, { kind: 'ssh' }> & Readonly<{
    hostKeyEvidence: NonNullable<Extract<MachineProvisionerBootstrapCarrierV1, { kind: 'ssh' }>['hostKeyEvidence']>;
}> {
    const [algorithm, key] = input.guestHostPublicKey.split(' ');
    const host = input.connection.port && input.connection.port !== 22
        ? `[${input.connection.address}]:${input.connection.port}` : input.connection.address;
    return { kind: 'ssh', ...input.connection, credentialRef: input.credentialRef, hostKeySource: 'retained-credential',
        hostKeyEvidence: { hostKey: `${host} ${algorithm} ${key}`, fingerprint: computeSshHostKeyFingerprint(key!) } };
}
