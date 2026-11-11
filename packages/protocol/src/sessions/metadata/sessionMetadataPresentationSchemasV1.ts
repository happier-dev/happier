import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { SessionDirectoryV1Schema } from './sessionDirectoryV1.js';
import { SessionWorkspaceLocationV1Schema } from './sessionWorkspaceLocationV1.js';

const TimestampSchema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)));
const OptionalOwnerStringSchema = lazyZodSchema(() => z.nullable(z.string().check(z.maxLength(100_000))));
const OptionalOwnerIdentifierSchema = lazyZodSchema(() => z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(2_000))));

export const SessionSharedAgentPresentationV1Schema = lazyZodSchema(() => z.strictObject({
  agentId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  label: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
}));
export type SessionSharedAgentPresentationV1 = z.infer<typeof SessionSharedAgentPresentationV1Schema>;

export const SessionOwnerWorkspaceV1Schema = lazyZodSchema(() => z.strictObject({
  path: z.optional(OptionalOwnerStringSchema),
  host: z.optional(OptionalOwnerStringSchema),
  version: z.optional(OptionalOwnerStringSchema),
  name: z.optional(OptionalOwnerStringSchema),
  os: z.optional(OptionalOwnerStringSchema),
  machineId: z.optional(OptionalOwnerIdentifierSchema),
  profileId: z.optional(OptionalOwnerIdentifierSchema),
  homeDir: z.optional(OptionalOwnerStringSchema),
  happyHomeDir: z.optional(OptionalOwnerStringSchema),
  happyLibDir: z.optional(OptionalOwnerStringSchema),
  happyToolsDir: z.optional(OptionalOwnerStringSchema),
  flavor: z.optional(OptionalOwnerIdentifierSchema),
  projectId: z.optional(OptionalOwnerIdentifierSchema),
  workspaceId: z.optional(OptionalOwnerIdentifierSchema),
  workspaceLocationId: z.optional(OptionalOwnerIdentifierSchema),
  workspaceCheckoutId: z.optional(OptionalOwnerIdentifierSchema),
  /** Last observed actual checkout branch; absent is unavailable and null is detached. */
  branch: z.optional(OptionalOwnerStringSchema),
  sessionWorkspaceLocationV1: z.optional(SessionWorkspaceLocationV1Schema),
  sessionDirectoryV1: z.optional(SessionDirectoryV1Schema),
}));

export const SessionOwnerCursorsV1Schema = lazyZodSchema(() => z.strictObject({
  /** Last immediate manager whose notice was accepted into this Session. Null is detached. */
  lastNotifiedManagerSessionId: z.optional(OptionalOwnerIdentifierSchema),
  externalSessionAttentionV1: z.optional(z.strictObject({
    v: z.literal(1),
    observedProgressToken: z.optional(z.string().check(z.maxLength(20_000))),
    viewedProgressToken: z.optional(z.string().check(z.maxLength(20_000))),
    observedAtMs: z.optional(TimestampSchema),
    viewedAtMs: z.optional(TimestampSchema),
  })),
  readStateV1: z.optional(z.strictObject({
    v: z.literal(1), sessionSeq: z.number().check(z.int(), z.nonnegative()),
    pendingActivityAt: TimestampSchema, updatedAt: TimestampSchema,
  })),
  discardedCommittedMessageLocalIds: z.optional(z.array(z.string().check(z.maxLength(2_000))).check(z.maxLength(20_000))),
  locallyConsumedUserMessageSeqsV1: z.optional(z.array(z.number().check(z.int(), z.nonnegative())).check(z.maxLength(20_000))),
}));
