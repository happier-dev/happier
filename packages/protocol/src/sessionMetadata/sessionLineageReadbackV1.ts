import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';
import {
    readExecutionRunLinkV1,
    resolveExecutionRunLinkDeliveryStateV1,
    type ExecutionRunLinkDeliveryStateV1,
    type ExecutionRunLinkDeliveryV1,
    type ExecutionRunLinkRelayV1,
    type ExecutionRunLinkReportV1,
} from './executionRunLinkV1.js';
import { readSessionOriginV1, readSessionOriginViaV1, type SessionOriginViaV1 } from './sessionOrigin.js';
import { readSessionRoleAssignmentV1, resolveSessionRolePromptNameV1, type SessionRole } from './sessionRole.js';
import { readTeamAssemblyV1, type TeamAssemblyV1 } from './teamAssemblyV1.js';

/**
 * Role and lineage readback for `session.status.get` and `session.list` rows. The one projection
 * every executor uses, so the Lead can confirm a child's role, creator, run link, and delivery
 * state without relying only on a spawn receipt.
 */
export type SessionLineageReadbackV1 = Readonly<{
    role: Readonly<{ id: SessionRole; name: string; assignmentId: string | null }> | null;
    origin: Readonly<{ creatorSessionId: string; via?: SessionOriginViaV1 }> | null;
    executionRunLink: Readonly<{
        parentSessionId: string;
        runId: string;
        report?: ExecutionRunLinkReportV1;
        relay?: ExecutionRunLinkRelayV1;
        delivery?: ExecutionRunLinkDeliveryV1;
        /** Derived from the three records only; `sent` requires verified delivery. */
        deliveryState: ExecutionRunLinkDeliveryStateV1;
    }> | null;
    /** Present only on a Lead whose runner recorded a team assembly. */
    teamAssembly?: TeamAssemblyV1;
}>;

/** Wire schema for the readback fields on status and list rows (all nullable, all optional for older producers). */
export const SessionLineageReadbackV1RowFieldsSchema = lazySchema(() => z.object({
    role: z.object({ id: z.string().min(1), name: z.string().min(1), assignmentId: z.string().nullable() }).passthrough().nullable().optional(),
    origin: z.object({ creatorSessionId: z.string().min(1), via: z.unknown().optional() }).passthrough().nullable().optional(),
    executionRunLink: z.object({
        parentSessionId: z.string().min(1),
        runId: z.string().min(1),
        report: z.unknown().optional(),
        relay: z.unknown().optional(),
        delivery: z.unknown().optional(),
        deliveryState: z.string().min(1),
    }).passthrough().nullable().optional(),
    teamAssembly: z.unknown().optional(),
}));

export function readSessionLineageReadbackV1(metadata: unknown): SessionLineageReadbackV1 {
    const assignment = readSessionRoleAssignmentV1(metadata);
    const origin = readSessionOriginV1(metadata);
    const via = readSessionOriginViaV1(metadata);
    const link = readExecutionRunLinkV1(metadata);
    const teamAssembly = readTeamAssemblyV1(metadata);
    return {
        role: assignment
            ? { id: assignment.role, name: resolveSessionRolePromptNameV1(assignment), assignmentId: assignment.assignmentId }
            : null,
        origin: origin ? { creatorSessionId: origin.creatorSessionId, ...(via ? { via } : {}) } : null,
        executionRunLink: link
            ? {
                parentSessionId: link.parentSessionId,
                runId: link.runId,
                ...(link.report ? { report: link.report } : {}),
                ...(link.relay ? { relay: link.relay } : {}),
                ...(link.delivery ? { delivery: link.delivery } : {}),
                deliveryState: resolveExecutionRunLinkDeliveryStateV1(link),
            }
            : null,
        ...(teamAssembly ? { teamAssembly } : {}),
    };
}
