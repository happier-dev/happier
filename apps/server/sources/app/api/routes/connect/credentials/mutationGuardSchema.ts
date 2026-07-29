import { z } from "zod";

export const connectedServiceCredentialMutationGuardFields = {
    expectedCredentialRevision: z.string().trim().min(1).max(128).nullable().optional(),
    refreshLeaseOwnerId: z.string().trim().min(1).max(256).optional(),
} as const;

export function validateConnectedServiceCredentialMutationGuard(
    value: Readonly<{ expectedCredentialRevision?: string | null; refreshLeaseOwnerId?: string }>,
    context: z.RefinementCtx,
): void {
    if (value.refreshLeaseOwnerId && typeof value.expectedCredentialRevision !== "string") {
        context.addIssue({
            code: "custom",
            message: "refreshLeaseOwnerId requires expectedCredentialRevision",
            path: ["expectedCredentialRevision"],
        });
    }
}
