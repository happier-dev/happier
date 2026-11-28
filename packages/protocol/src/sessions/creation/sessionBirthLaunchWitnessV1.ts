import { AccountEncryptionModeSchema } from '../../features/payload/capabilities/encryptionCapabilities.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { SessionTeamCredentialBindingIntentV1Schema } from '../../teams/credentials/sessionBindingIntentV1.js';
import { z } from '../../zodRuntimePolicy.js';

export const SESSION_BIRTH_LAUNCH_WITNESS_HEADER_V1 = 'x-happier-session-launch-witness';

export const SessionBirthLaunchWitnessV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    accountEncryptionMode: AccountEncryptionModeSchema,
    acceptedTeamCredentialBinding: z.nullable(SessionTeamCredentialBindingIntentV1Schema),
    projectKey: z.nullable(z.string()),
    pendingExecutionRunIds: z.array(z.string().check(z.minLength(1))),
}));

export type SessionBirthLaunchWitnessV1 = z.infer<typeof SessionBirthLaunchWitnessV1Schema>;
