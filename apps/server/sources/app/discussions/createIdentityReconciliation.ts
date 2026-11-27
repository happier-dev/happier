import { isPrismaErrorCode } from "@/storage/prisma";
import { readPrismaUniqueConstraint } from "@/storage/prismaErrors";
import { discussionFailure, type DiscussionFailureCode, type DiscussionResult } from './serviceTypes';

/** A declined initial invitation must unwind the entire create transaction before returning its refusal. */
export class DiscussionCreationRejectedError extends Error {
    constructor(readonly code: DiscussionFailureCode) {
        super(code);
        this.name = 'DiscussionCreationRejectedError';
    }
}

const DISCUSSION_CREATION_IDENTITY_CONSTRAINT = "Discussion_createdByAccountId_creationLocalId_key";

/**
 * Identifies only the database identity used to adjudicate Discussion-create
 * replay. Other unique failures are defects and must remain visible rather than
 * being reinterpreted as idempotency races.
 */
export function isDiscussionCreationIdentityConflict(error: unknown): boolean {
    if (!isPrismaErrorCode(error, "P2002")) return false;
    const constraint = readPrismaUniqueConstraint(error);
    if (constraint === null) return false;
    if (constraint.modelName !== undefined && constraint.modelName !== "Discussion") return false;
    if (constraint.index !== undefined) return constraint.index === DISCUSSION_CREATION_IDENTITY_CONSTRAINT;
    const fields = constraint.fields ?? [];
    return fields.length === 2 && fields.includes("createdByAccountId") && fields.includes("creationLocalId");
}

/**
 * A concurrent insert can invalidate the create transaction's initial identity
 * lookup. Restart the complete domain transaction once so its existing-row
 * actor/equality checks adjudicate the winner from committed state.
 */
export async function reconcileDiscussionCreationIdentityRace<T>(
    operation: () => Promise<T>,
    taskAnchored = false,
): Promise<T | DiscussionResult<never>> {
    const attempt = async () => {
        try { return await operation(); }
        catch (error) {
            if (error instanceof DiscussionCreationRejectedError) return discussionFailure(error.code);
            throw error;
        }
    };
    try {
        return await attempt();
    } catch (error) {
        const constraint = taskAnchored && isPrismaErrorCode(error, 'P2002') ? readPrismaUniqueConstraint(error) : null;
        const anchorConflict = constraint !== null && (constraint.modelName === undefined || constraint.modelName === 'Discussion')
            && (constraint.index === 'Discussion_pkey' || (constraint.fields?.length === 1 && constraint.fields[0] === 'id'));
        if (!isDiscussionCreationIdentityConflict(error) && !anchorConflict) throw error;
        return await attempt();
    }
}
