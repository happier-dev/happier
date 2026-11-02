import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import { ManagedControllerV1Schema } from './managedMachineV1.js';
import { ManagedResourceV1Schema } from './providerFactsV1.js';

const id = () => z.string().check(z.trim(), z.minLength(1));
const purpose = () => ({ homeId: id(), managedId: id(), requestId: id(), operationId: id(), taskId: id(),
    controller: z.optional(ManagedControllerV1Schema), expectedIntentRevision: z.number().check(z.int(), z.nonnegative()),
    resource: ManagedResourceV1Schema,
    expectedPromptKind: z.enum(['auth.approveRemoteProvisioning', 'ssh.trustHost', 'ssh.replaceHostKey',
        'daemon.replaceRemoteBackgroundServices', 'administrator.establish']), expectedPromptId: z.optional(id()) });
/** Exact nonsecret creation/task correlation; current task ownership remains with the installed runner. */
export const ManagedInstallationPurposeV1Schema = lazyZodSchema(() => z.strictObject({ ...purpose(), phase: z.enum(['delivery', 'answer']) }));
export type ManagedInstallationPurposeV1 = z.infer<typeof ManagedInstallationPurposeV1Schema>;
export const ManagedInstallationResponseV1Schema = lazyZodSchema(() => z.strictObject({ ...purpose(),
    requestId: z.optional(id()),
    delivery: z.optional(z.strictObject({ kind: z.literal('terminalPairing') })), answer: z.optional(StrictJsonValueSchema),
}).check(z.refine(value => (value.delivery === undefined) !== (value.answer === undefined)
    && (value.delivery === undefined || value.expectedPromptKind === 'auth.approveRemoteProvisioning'))));
export type ManagedInstallationResponseV1 = z.infer<typeof ManagedInstallationResponseV1Schema>;
export const ManagedInstallationCapabilityRequestV1Schema = lazyZodSchema(() => z.strictObject({
    id: z.literal('tool.systemTasks'), method: z.literal('respond'), params: ManagedInstallationResponseV1Schema,
}));
/** Home-only transient origin, accepted only from the controller's authenticated Home socket. Public callers never supply it. */
export const ManagedInstallationServerOriginV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('machine.managedInstallation.serverOrigin'), actorAccountId: id(), custodianAccountId: id(),
    purpose: ManagedInstallationPurposeV1Schema,
}));
export type ManagedInstallationServerOriginV1 = z.infer<typeof ManagedInstallationServerOriginV1Schema>;
export function readManagedInstallationPurposeV1(input: ManagedInstallationResponseV1): Omit<ManagedInstallationPurposeV1, 'requestId'> & Readonly<{ requestId?: string }> {
    const { delivery: _delivery, answer: _answer, ...value } = input;
    return { ...value, phase: input.delivery === undefined ? 'answer' : 'delivery' };
}
/** Secret-bearing return value. It must never enter an Action operation, task snapshot or log. */
export const ManagedTerminalPairingContextV1Schema = lazyZodSchema(() => z.strictObject({
    publicKey: id(), homeServerIdentityId: id(), pairing: z.strictObject({ secretB64Url: id(),
        createdAtMs: z.number().check(z.int(), z.nonnegative()), expiresAtMs: z.number().check(z.int(), z.nonnegative()) }),
    supportsTokenOnly: z.literal(true), pairingRequirement: z.literal('v3'), enrollmentAccountId: id(),
    /** F2-issued admission facts, delivered only over this requester-private response, never an input or published snapshot. */
    reviewedParent: z.optional(z.strictObject({ actionId: id() })),
}));
export type ManagedTerminalPairingContextV1 = z.infer<typeof ManagedTerminalPairingContextV1Schema>;
