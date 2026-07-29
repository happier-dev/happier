import { z } from "zod";
import { ConnectedServiceCredentialRevisionV1Schema } from "@happier-dev/protocol";

function parseBooleanQueryFlag(value: unknown): unknown {
    if (typeof value !== "string") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    return value;
}

export const ConnectedServiceCredentialDeleteQuerySchema = z.object({
    cleanupGroupReferences: z.preprocess(parseBooleanQueryFlag, z.boolean().optional()),
    expectedCredentialRevision: ConnectedServiceCredentialRevisionV1Schema.optional(),
}).strict();
