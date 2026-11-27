import { SupporterCodeV1Schema } from "@happier-dev/protocol";
import { z } from "zod/mini";

export const supporterProofSchema = z.strictObject({ code: z.optional(SupporterCodeV1Schema) });
const supporterRecordProofSchema = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("account"), accountId: z.string().check(z.minLength(1)) }),
    z.strictObject({ kind: z.literal("code"), code: SupporterCodeV1Schema }),
]);
export type SupporterProof = z.infer<typeof supporterRecordProofSchema>;

export const supporterGitHubAttemptSchema = z.strictObject({
    proof: supporterRecordProofSchema,
    recordId: z.nullable(z.string().check(z.minLength(1))),
    publishGitHubLogin: z.boolean(),
});
export type SupporterGitHubAttempt = z.infer<typeof supporterGitHubAttemptSchema>;

export const supporterDiscordRecordBindingSchema = z.union([
    z.strictObject({ id: z.string().check(z.minLength(1)), accountId: z.string().check(z.minLength(1)) }),
    z.strictObject({ id: z.string().check(z.minLength(1)), accountId: z.null(), codeDigest: z.string() }),
]);
export type SupporterDiscordRecordBinding = z.infer<typeof supporterDiscordRecordBindingSchema>;
