import { z } from 'zod';

import type { AccountSettingsDefaults } from '@happier-dev/protocol';
import { SecretStringSchema, type SecretString } from '@/sync/encryption/secretSettings';

export type RemoteHostId = string;

export const RemoteHostAuthModeSchema = z.enum(['agent', 'keyfile', 'password']);
export type RemoteHostAuthMode = z.infer<typeof RemoteHostAuthModeSchema>;

export const RemoteHostSshProfileSchema = z.object({
    target: z.string().min(1),
    port: z.number().int().min(1).max(65535).nullable().optional(),
    authMode: RemoteHostAuthModeSchema,
    passwordEnc: SecretStringSchema.nullable().optional(),
    identityPrivateKeyEnc: SecretStringSchema.nullable().optional(),
}).strict();

export type RemoteHostSshProfile = Readonly<{
    target: string;
    port?: number | null;
    authMode: RemoteHostAuthMode;
    passwordEnc?: SecretString | null;
    identityPrivateKeyEnc?: SecretString | null;
}>;

export const RemoteHostSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    ssh: RemoteHostSshProfileSchema,
    createdAt: z.number(),
    updatedAt: z.number(),
    lastUsedAt: z.number().nullable(),
    linkedMachineId: z.string().nullable().optional(),
    linkedRelayProfileId: z.string().nullable().optional(),
}).strict();

export type RemoteHost = z.infer<typeof RemoteHostSchema>;
export type RemoteHostsV1Raw = AccountSettingsDefaults['remoteHostsV1'];

/**
 * `remoteHostsV1` remains a bounded legacy Account collection. Only records
 * matching the current host model are safe for SSH and task consumers.
 */
export function readRemoteHosts(raw: unknown): RemoteHost[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((candidate) => {
        const parsed = RemoteHostSchema.safeParse(candidate);
        return parsed.success ? [parsed.data] : [];
    });
}

/**
 * Updates only a row known to match the current remote-host contract. Every
 * opaque retained row remains the original raw value so an older UI never
 * strips a future or malformed entry while editing a current host.
 */
export function upsertRemoteHost(raw: RemoteHostsV1Raw, remoteHost: RemoteHost): RemoteHostsV1Raw {
    let replaced = false;
    const next = raw.map((candidate) => {
        const parsed = RemoteHostSchema.safeParse(candidate);
        if (!parsed.success || parsed.data.id !== remoteHost.id) return candidate;
        replaced = true;
        return remoteHost;
    });
    return replaced ? next : [...next, remoteHost];
}

/**
 * Removes only a current-contract row. Opaque rows, including a future row
 * that happens to reuse the requested id, are retained unchanged.
 */
export function removeRemoteHost(raw: RemoteHostsV1Raw, remoteHostId: string): RemoteHostsV1Raw {
    return raw.filter((candidate) => {
        const parsed = RemoteHostSchema.safeParse(candidate);
        return !parsed.success || parsed.data.id !== remoteHostId;
    });
}
