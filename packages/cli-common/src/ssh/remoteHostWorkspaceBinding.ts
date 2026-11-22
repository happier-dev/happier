import { z } from 'zod';

export const REMOTE_HOST_SSH_PROVISIONER = { pluginId: 'happier.machine.ssh', localId: 'ssh' } as const;

const versionOne = {
    v: z.literal(1),
    target: z.string().min(1),
    port: z.number().int().min(1).max(65535).optional(),
    knownHostsPath: z.string().min(1).refine(path => !path.includes('\0')),
    credential: z.string().min(1).refine(value => !value.includes('\0')),
};

const envelopeSchema = z.discriminatedUnion('authMode', [
    z.strictObject({ ...versionOne, authMode: z.literal('keyfile') }),
    z.strictObject({ ...versionOne, authMode: z.literal('password') }),
]);

export type RemoteHostWorkspaceBindingV1 = z.infer<typeof envelopeSchema>;

export function parseRemoteHostWorkspaceBindingV1(bytes: Uint8Array): RemoteHostWorkspaceBindingV1 {
    try {
        return envelopeSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    } catch {
        // Decode/validation failures must never carry the lease contents.
        throw Object.assign(new Error('The Remote Host SSH binding is unavailable'), { code: 'credential_unavailable' });
    }
}
