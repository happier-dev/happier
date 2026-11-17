import { lazyZodSchema } from '@happier-dev/protocol/lazyZodSchema';
import { FileChangeEvidenceSchema, RepositoryCheckpointReceiptSchema, RepositoryCheckpointTurnMetadataSchema } from '@happier-dev/protocol/sessions/changes/schemas';
import { z } from 'zod/mini';

import {
    REPOSITORY_CHECKPOINT_TURN_PROJECTION_UNAVAILABLE_REASONS,
    type GitCheckpointRepositoryPaths,
    type RepositoryCheckpointCaptureResult,
    type RepositoryCheckpointDiffBaseRefSource,
    type RepositoryCheckpointDiffResult,
    type RepositoryCheckpointRef,
} from './types';

/**
 * One checkpoint phase: capture `checkpointRef`, then (turn end) diff it against `diff.baseRef`.
 * The Git work runs where the repository's Git runs, as one operation, so a remote host pays one
 * round trip per phase instead of one per Git process.
 */
export type RepositoryCheckpointPhaseRequest = Readonly<{
    repository: Readonly<{ cwd: string; projectKey: string; rootPath: string; checkpointGitPaths?: GitCheckpointRepositoryPaths }>;
    checkpointRef: RepositoryCheckpointRef;
    diff?: Readonly<{
        baseRef: RepositoryCheckpointRef;
        baseRefSource: Exclude<RepositoryCheckpointDiffBaseRefSource, 'unavailable'>;
        /** The commit this lifecycle's own message-start capture wrote to `baseRef`. */
        baseCommitSha?: string;
    }>;
}>;

/** `diff.attributionScope` is the caller's to decide; the phase reports `unknown`. */
export type RepositoryCheckpointPhaseResult = Readonly<{
    captured: RepositoryCheckpointCaptureResult;
    /**
     * Wall clock (`performance.timeOrigin + now`, one clock per host) when the capture ended. Attribution
     * counts only peers that began by then: a peer starting during the diff did not touch the captured bytes.
     */
    capturedAtMs?: number;
    diff?: RepositoryCheckpointDiffResult;
}>;

export type RepositoryCheckpointPhaseRunner = (request: RepositoryCheckpointPhaseRequest) => Promise<RepositoryCheckpointPhaseResult>;

const ShaSchema = z.string().check(z.minLength(1));
const RefSchema = lazyZodSchema(() => z.strictObject({
    scopeId: z.string().check(z.minLength(1)),
    encodedScope: z.string().check(z.minLength(1)),
    phase: z.enum(['message-start', 'turn-start', 'turn-final']),
    checkpointId: z.string().check(z.minLength(1)),
    ref: z.string().check(z.minLength(1)),
}));
const ReasonSchema = z.enum(REPOSITORY_CHECKPOINT_TURN_PROJECTION_UNAVAILABLE_REASONS);
const AttributionScopeSchema = lazyZodSchema(() => RepositoryCheckpointTurnMetadataSchema.shape.attributionScope);
const BaseRefSourceSchema = lazyZodSchema(() => RepositoryCheckpointTurnMetadataSchema.shape.baseRefSource);
const KnownBaseRefSourceSchema = lazyZodSchema(() => BaseRefSourceSchema.check(z.refine(source => source !== 'unavailable')));
const ReceiptsSchema = lazyZodSchema(() => z.array(RepositoryCheckpointReceiptSchema));

export const RepositoryCheckpointPhaseRequestSchema = lazyZodSchema(() => z.strictObject({
    repository: z.strictObject({
        cwd: z.string().check(z.minLength(1)),
        projectKey: z.string().check(z.minLength(1)),
        rootPath: z.string().check(z.minLength(1)),
        checkpointGitPaths: z.optional(z.strictObject({
            index: z.string().check(z.minLength(1)),
            checkpointEvidence: z.string().check(z.minLength(1)),
        })),
    }),
    checkpointRef: RefSchema,
    diff: z.optional(z.strictObject({
        baseRef: RefSchema,
        baseRefSource: KnownBaseRefSourceSchema,
        baseCommitSha: z.optional(ShaSchema),
    })),
}));

export const RepositoryCheckpointPhaseResultSchema = lazyZodSchema(() => z.strictObject({
    captured: z.union([
        z.strictObject({ success: z.literal(true), checkpointRef: RefSchema, commitSha: ShaSchema, treeSha: ShaSchema, receipts: ReceiptsSchema }),
        z.strictObject({ success: z.literal(false), kind: z.enum(['unavailable', 'failed']), reason: ReasonSchema,
            error: z.string(), receipts: ReceiptsSchema }),
    ]),
    capturedAtMs: z.optional(z.number()),
    diff: z.optional(z.union([
        z.strictObject({ success: z.literal(true), baseRef: RefSchema, finalRef: RefSchema,
            baseRefSource: KnownBaseRefSourceSchema, contentConfidence: z.enum(['exact', 'unavailable']),
            attributionScope: AttributionScopeSchema, files: z.array(FileChangeEvidenceSchema), receipts: ReceiptsSchema }),
        z.strictObject({ success: z.literal(false), kind: z.enum(['unavailable', 'failed']), reason: ReasonSchema, error: z.string(),
            baseRefSource: BaseRefSourceSchema,
            contentConfidence: z.literal('unavailable'), attributionScope: AttributionScopeSchema, receipts: ReceiptsSchema }),
    ])),
}));
