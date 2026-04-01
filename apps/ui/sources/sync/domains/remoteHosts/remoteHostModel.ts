import { z } from 'zod';

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
    lastUsedAt: z.number(),
    linkedMachineId: z.string().nullable().optional(),
    linkedRelayProfileId: z.string().nullable().optional(),
}).strict();

export type RemoteHost = z.infer<typeof RemoteHostSchema>;
