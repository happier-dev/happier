import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

/**
 * Link from a visible child Session to the execution run that drives it. The parent run state is
 * authoritative; the link only tells the child runner where to send turn wake-ups. It is seeded
 * before a created child's first turn (spawn ingress, child environment, initial metadata) and
 * written through the CAS metadata writer before the task message for a bound child.
 */
/**
 * R21 turn-report record, written only by the child's runner from the outcome of its
 * `session.executionRun.childTurn.report.v1` call: the parent's RPC response is the acknowledgement.
 */
export const ExecutionRunLinkReportV1Schema = lazySchema(() => z.object({
    turnEpoch: z.number().int().min(0),
    reportedAt: z.number().int().nonnegative(),
    ack: z.enum(['pending', 'accepted', 'failed']),
    attempts: z.number().int().min(0),
}).passthrough());
export type ExecutionRunLinkReportV1 = z.infer<typeof ExecutionRunLinkReportV1Schema>;

/**
 * R21 relay record, written only by the parent runner from its completion-relay enqueue outcome.
 * A queued relay is queue acceptance, not delivery.
 */
export const ExecutionRunLinkRelayV1Schema = lazySchema(() => z.object({
    turnEpoch: z.number().int().min(0),
    status: z.enum(['queued', 'failed']),
    /** The completion input's pending local id in the Lead's queue. */
    localId: z.string().trim().min(1),
    at: z.number().int().nonnegative(),
}).passthrough());
export type ExecutionRunLinkRelayV1 = z.infer<typeof ExecutionRunLinkRelayV1Schema>;

/**
 * R21 delivery record, written only by the parent runner after it read the Lead's persisted
 * transcript and found the completion input with this `localId` for this run. The transcript row
 * sequence is the receipt; completion or a queued relay never produces it.
 */
export const ExecutionRunLinkDeliveryV1Schema = lazySchema(() => z.object({
    turnEpoch: z.number().int().min(0),
    status: z.literal('verified'),
    localId: z.string().trim().min(1),
    transcriptSeq: z.number().int().nonnegative(),
    verifiedAt: z.number().int().nonnegative(),
}).passthrough());
export type ExecutionRunLinkDeliveryV1 = z.infer<typeof ExecutionRunLinkDeliveryV1Schema>;

export const ExecutionRunLinkV1Schema = lazySchema(() => z.object({
    v: z.literal(1),
    parentSessionId: z.string().trim().min(1),
    runId: z.string().trim().min(1),
    /** Child turn epoch at task delivery; each later completed child turn reports a greater epoch. */
    turnEpoch: z.number().int().min(0),
    report: ExecutionRunLinkReportV1Schema.optional(),
    relay: ExecutionRunLinkRelayV1Schema.optional(),
    delivery: ExecutionRunLinkDeliveryV1Schema.optional(),
}).passthrough());
export type ExecutionRunLinkV1 = z.infer<typeof ExecutionRunLinkV1Schema>;

/** The three R21 records as carried on the child link and mirrored on the parent's run state. */
export const ExecutionRunLinkStateV1Schema = lazySchema(() => z.object({
    report: ExecutionRunLinkReportV1Schema.optional(),
    relay: ExecutionRunLinkRelayV1Schema.optional(),
    delivery: ExecutionRunLinkDeliveryV1Schema.optional(),
}).passthrough());
export type ExecutionRunLinkStateV1 = z.infer<typeof ExecutionRunLinkStateV1Schema>;

/** Child environment variable carrying the link for a daemon-spawned child, like `HAPPIER_SESSION_ROLE_V1_JSON`. */
export const EXECUTION_RUN_LINK_V1_ENV_KEY = 'HAPPIER_EXECUTION_RUN_LINK_V1_JSON';

/** Message meta key carrying the link on a bound child's task message. Only the run host writes it. */
export const EXECUTION_RUN_LINK_V1_META_KEY = 'happierExecutionRunLinkV1';

/** Missing, malformed, and newer links read as unlinked. */
export function readExecutionRunLinkV1(metadata: unknown): ExecutionRunLinkV1 | null {
    if (!metadata || typeof metadata !== 'object' || !('executionRunLinkV1' in metadata)) return null;
    const parsed = ExecutionRunLinkV1Schema.safeParse((metadata as { executionRunLinkV1?: unknown }).executionRunLinkV1);
    return parsed.success ? parsed.data : null;
}

/** The single link patch; every other key, including creator provenance and role, is preserved by reference. */
export function applyExecutionRunLinkV1ToMetadata<M extends Record<string, unknown>>(metadata: M, link: ExecutionRunLinkV1): M {
    return { ...metadata, executionRunLinkV1: ExecutionRunLinkV1Schema.parse(link) };
}

function patchCurrentLink<M extends Record<string, unknown>>(
    metadata: M,
    runId: string,
    patch: (link: ExecutionRunLinkV1) => ExecutionRunLinkV1 | null,
): M {
    const link = readExecutionRunLinkV1(metadata);
    // A record for another run never lands on the current link, and an unlinked session gets none.
    if (!link || link.runId !== runId) return metadata;
    const next = patch(link);
    return next ? { ...metadata, executionRunLinkV1: ExecutionRunLinkV1Schema.parse(next) } : metadata;
}

/** Child runner only: the outcome of its own turn report. Other writers' records are preserved. */
export function applyExecutionRunLinkReportV1<M extends Record<string, unknown>>(
    metadata: M,
    params: Readonly<{ runId: string; report: ExecutionRunLinkReportV1 }>,
): M {
    return patchCurrentLink(metadata, params.runId, (link) => ({ ...link, report: ExecutionRunLinkReportV1Schema.parse(params.report) }));
}

/** Parent runner only: the outcome of its completion-relay enqueue. */
export function applyExecutionRunLinkRelayV1<M extends Record<string, unknown>>(
    metadata: M,
    params: Readonly<{ runId: string; relay: ExecutionRunLinkRelayV1 }>,
): M {
    return patchCurrentLink(metadata, params.runId, (link) => ({ ...link, relay: ExecutionRunLinkRelayV1Schema.parse(params.relay) }));
}

/**
 * Parent runner only, after verifying the completion input in the Lead's persisted transcript.
 * Admitted only for a queued relay of the same turn and local id, so delivery can never be
 * recorded from completion alone or from a failed relay.
 */
export function applyExecutionRunLinkDeliveryV1<M extends Record<string, unknown>>(
    metadata: M,
    params: Readonly<{ runId: string; delivery: ExecutionRunLinkDeliveryV1 }>,
): M {
    const delivery = ExecutionRunLinkDeliveryV1Schema.parse(params.delivery);
    return patchCurrentLink(metadata, params.runId, (link) => (
        link.relay?.status === 'queued' && link.relay.localId === delivery.localId && link.relay.turnEpoch === delivery.turnEpoch
            ? { ...link, delivery }
            : null
    ));
}

/** Delivery-to-Lead state for display; derived only from the link records. */
export type ExecutionRunLinkDeliveryStateV1 =
    | 'sent'
    | 'queued'
    | 'relay_failed'
    | 'reported'
    | 'report_pending'
    | 'report_failed'
    | 'not_sent';

/**
 * The one derivation of a child's delivery-to-Lead state for its latest known turn. Only a
 * verified delivery is `sent`; an accepted report or a queued relay is still pending.
 */
export function resolveExecutionRunLinkDeliveryStateV1(link: ExecutionRunLinkStateV1 | null | undefined): ExecutionRunLinkDeliveryStateV1 {
    if (!link) return 'not_sent';
    const { report, relay, delivery } = link;
    const epochs = [report?.turnEpoch, relay?.turnEpoch, delivery?.turnEpoch].filter((value): value is number => typeof value === 'number');
    if (epochs.length === 0) return 'not_sent';
    const epoch = Math.max(...epochs);
    if (delivery?.status === 'verified' && delivery.turnEpoch === epoch) return 'sent';
    if (relay?.turnEpoch === epoch) return relay.status === 'failed' ? 'relay_failed' : 'queued';
    if (report?.turnEpoch === epoch) {
        if (report.ack === 'accepted') return 'reported';
        return report.ack === 'failed' ? 'report_failed' : 'report_pending';
    }
    return 'not_sent';
}

export function readExecutionRunLinkV1FromMessageMeta(meta: unknown): ExecutionRunLinkV1 | null {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
    const parsed = ExecutionRunLinkV1Schema.safeParse((meta as Record<string, unknown>)[EXECUTION_RUN_LINK_V1_META_KEY]);
    return parsed.success ? parsed.data : null;
}

/** User-facing sends never carry a caller-supplied link, so the run state stays authoritative. */
export function stripExecutionRunLinkV1FromMessageMeta<M extends Record<string, unknown>>(meta: M): M {
    if (!Object.prototype.hasOwnProperty.call(meta, EXECUTION_RUN_LINK_V1_META_KEY)) return meta;
    const { [EXECUTION_RUN_LINK_V1_META_KEY]: _removed, ...rest } = meta;
    return rest as M;
}

/**
 * `session.executionRun.childTurn.report.v1` on the parent runner, sent by the linked child through
 * the server-relayed session RPC. A report is a wake-up only: the parent validates the run, the
 * linked session and a monotonic epoch, then reads the child's transcript forward from the task
 * message. `linked` is the handshake sent at child startup or on bind.
 */
export const SessionExecutionRunChildTurnReportV1RequestSchema = lazySchema(() => z.object({
    runId: z.string().trim().min(1),
    linkedSessionId: z.string().trim().min(1),
    turnEpoch: z.number().int().min(0),
    kind: z.enum(['linked', 'turn_completed']),
    /** How the reported child turn ended; absent means completed. A failed turn lets the parent evaluate or fail the run. */
    turnStatus: z.enum(['completed', 'failed']).optional(),
}).passthrough());
export type SessionExecutionRunChildTurnReportV1Request = z.infer<typeof SessionExecutionRunChildTurnReportV1RequestSchema>;

export const SessionExecutionRunChildTurnReportV1ResponseSchema = lazySchema(() => z.object({
    ok: z.literal(true),
    /** False when the report was valid but changed nothing (an unknown, finished, or foreign run, or a stale epoch). */
    accepted: z.boolean(),
    reason: z.enum(['unknown_run', 'run_terminal', 'foreign_child', 'stale_epoch']).optional(),
}).passthrough());
export type SessionExecutionRunChildTurnReportV1Response = z.infer<typeof SessionExecutionRunChildTurnReportV1ResponseSchema>;
