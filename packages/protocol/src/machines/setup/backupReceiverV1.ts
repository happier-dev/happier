import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';

/** Reviewed network endpoint; reachability stays with the private route owner. */
export const BackupReceiverEndpointV1Schema = lazyZodSchema(() => z.strictObject({
  host: z.string().check(z.minLength(1), z.regex(/^[^\s\[\]\/\\,@]+$/u)),
  port: z.number().check(z.int(), z.minimum(1), z.maximum(65535)),
}));
export type BackupReceiverEndpointV1 = z.infer<typeof BackupReceiverEndpointV1Schema>;

/** Public evidence from the selected receiving daemon, never a backup-ready claim. */
export const MachineSetupBackupReceiverResultV1Schema = lazyZodSchema(() => {
  const identity = { sourceIndex: z.number().check(z.int(), z.minimum(0)), itemIndex: z.number().check(z.int(), z.minimum(0)),
    machineId: z.string().check(z.minLength(1)), installationId: z.string().check(z.minLength(1)) };
  return z.discriminatedUnion('status', [
    z.strictObject({ ...identity, status: z.literal('ready'), endpoint: BackupReceiverEndpointV1Schema,
      username: z.string().check(z.minLength(1)), path: z.string().check(z.minLength(1)),
      hostKey: z.string().check(z.minLength(1)), fingerprint: z.string().check(z.minLength(1)) }),
    z.strictObject({ ...identity, status: z.literal('unavailable'), endpoint: z.optional(BackupReceiverEndpointV1Schema),
      reason: z.enum(['receiver_inputs_unavailable', 'ssh_configuration_unavailable',
        'host_key_unreadable', 'host_key_invalid']) }),
  ]);
});
export type MachineSetupBackupReceiverResultV1 = z.infer<typeof MachineSetupBackupReceiverResultV1Schema>;

/** Public-only witness captured by the existing effective SSH probe. */
export const MachineSetupSshHostKeyEvidenceV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ready'), publicKey: z.string().check(z.minLength(1)), fingerprint: z.string().check(z.minLength(1)) }),
  z.strictObject({ status: z.literal('unavailable'), reason: z.enum(['host_key_unreadable', 'host_key_invalid']) }),
]));
export type MachineSetupSshHostKeyEvidenceV1 = z.infer<typeof MachineSetupSshHostKeyEvidenceV1Schema>;
export const MachineSetupNativeSshHostKeyV1Schema = lazyZodSchema(() => z.strictObject({
  planIndex: z.number().check(z.int(), z.minimum(0)), stepId: z.string().check(z.minLength(1)),
  evidence: MachineSetupSshHostKeyEvidenceV1Schema,
}));
export type MachineSetupNativeSshHostKeyV1 = z.infer<typeof MachineSetupNativeSshHostKeyV1Schema>;
