import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';
import { SessionMetadataPublisherPreconditionV1Schema } from '../../metadata/sessionMetadataSchemasV1.js';

import {
  SessionRuntimeActivityProjectionSchema,
  SessionRuntimeActivitySnapshotSchema,
} from './sessionRuntimeActivity.js';

export const SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT = 'session-runtime-activity-snapshot';
export const SESSION_RUNTIME_ACTIVITY_CLOSE_EVENT = 'session-runtime-activity-close';
export const SESSION_PUBLISHER_AUTHORITY_CHECK_EVENT =
  'session-publisher-authority-check';

export const SessionRuntimeActivitySnapshotRequestSchema = lazyZodSchema(() => z.strictObject({
  sessionId: z.string().check(z.trim(), z.minLength(1)),
  mutationId: z.string().check(z.trim(), z.minLength(1)),
  snapshot: SessionRuntimeActivitySnapshotSchema,
}));

const SessionRuntimeActivityTransportIdentitySchema = lazyZodSchema(() => z.strictObject({
  sessionId: z.string().check(z.trim(), z.minLength(1)),
  mutationId: z.string().check(z.trim(), z.minLength(1)),
}));

export const SessionRuntimeActivitySnapshotAckSchema = lazyZodSchema(() => z.union([
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionRuntimeActivityTransportIdentitySchema, {
    status: z.literal('applied'),
    projection: SessionRuntimeActivityProjectionSchema,
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionRuntimeActivityTransportIdentitySchema, {
    status: z.literal('unchanged'),
    projection: SessionRuntimeActivityProjectionSchema,
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionRuntimeActivityTransportIdentitySchema, {
    status: z.literal('rejected'),
    reason: z.enum(['not_found', 'unauthorized', 'archived', 'superseded', 'revision_overflow']),
  })),
  z.strictObject({
    status: z.literal('rejected'),
    reason: z.literal('invalid_request'),
  }),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionRuntimeActivityTransportIdentitySchema, {
    status: z.literal('retryable'),
    reason: z.literal('internal'),
  })),
]));

export const SessionRuntimeActivityCloseRequestSchema = lazyZodSchema(() => z.strictObject({
  sessionId: z.string().check(z.trim(), z.minLength(1)),
}));

export const SessionRuntimeActivityCloseAckSchema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('closed'), sessionId: z.string().check(z.trim(), z.minLength(1)) }),
  z.strictObject({ status: z.literal('already_inactive'), sessionId: z.string().check(z.trim(), z.minLength(1)) }),
  z.strictObject({
    status: z.literal('rejected'),
    sessionId: z.string().check(z.trim(), z.minLength(1)),
    reason: z.enum(['not_found', 'unauthorized', 'archived', 'superseded']),
  }),
  z.strictObject({
    status: z.literal('retryable'),
    sessionId: z.string().check(z.trim(), z.minLength(1)),
    reason: z.literal('internal'),
  }),
  z.strictObject({ status: z.literal('rejected'), reason: z.literal('invalid_request') }),
]));

export const SessionPublisherAuthorityCheckRequestSchema = lazyZodSchema(() => z.strictObject({
  sessionId: z.string().check(z.trim(), z.minLength(1)),
}));

export const SessionPublisherAuthorityCheckAckSchema = lazyZodSchema(() => z.union([
  z.strictObject({
    status: z.literal('current'),
    sessionId: z.string().check(z.trim(), z.minLength(1)),
    publisherPrecondition: SessionMetadataPublisherPreconditionV1Schema,
  }),
  z.strictObject({
    status: z.literal('superseded'),
    sessionId: z.string().check(z.trim(), z.minLength(1)),
  }),
  z.strictObject({
    status: z.literal('rejected'),
    reason: z.literal('invalid_request'),
  }),
  z.strictObject({
    status: z.literal('retryable'),
    sessionId: z.string().check(z.trim(), z.minLength(1)),
    reason: z.literal('internal'),
  }),
]));

export type SessionRuntimeActivitySnapshotRequest = z.infer<typeof SessionRuntimeActivitySnapshotRequestSchema>;
export type SessionRuntimeActivitySnapshotAck = z.infer<typeof SessionRuntimeActivitySnapshotAckSchema>;
export type SessionRuntimeActivityCloseRequest = z.infer<typeof SessionRuntimeActivityCloseRequestSchema>;
export type SessionRuntimeActivityCloseAck = z.infer<typeof SessionRuntimeActivityCloseAckSchema>;
export type SessionPublisherAuthorityCheckRequest = z.infer<
  typeof SessionPublisherAuthorityCheckRequestSchema
>;
export type SessionPublisherAuthorityCheckAck = z.infer<
  typeof SessionPublisherAuthorityCheckAckSchema
>;
