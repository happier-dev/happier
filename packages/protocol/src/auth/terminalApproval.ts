import { z } from "../zodRuntimePolicy.js";

/** Receipt for POST /v1/auth/response. Team policies qualify the credential at use. */
export const TerminalApprovalSuccessSchema = z.object({
    success: z.literal(true),
    unattendedTeamAccess: z.optional(z.literal("authentication_evidence_unavailable")),
});

export type TerminalApprovalSuccess = z.infer<typeof TerminalApprovalSuccessSchema>;
