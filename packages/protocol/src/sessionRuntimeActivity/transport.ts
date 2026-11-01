import { z } from 'zod';

import {
  SessionRuntimeActivityProjectionSchema,
  SessionRuntimeActivitySnapshotSchema,
} from './projection.js';
import { lazySchema } from '../lazySchema.js';

export const SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT = 'session-runtime-activity-snapshot';
export const SESSION_RUNTIME_ACTIVITY_CLOSE_EVENT = 'session-runtime-activity-close';
export const SESSION_PUBLISHER_LEGACY_ALIVE_EVENT = 'session-alive';
export const SESSION_PUBLISHER_LEGACY_END_EVENT = 'session-end';

/** Released stable/preview CLI reachability vector, retained only at the machine-bound socket seam. */
export const SessionPublisherLegacyAliveSchema = lazySchema(() => z.object({
  sid: z.string().trim().min(1),
  time: z.number().finite(),
  thinking: z.boolean(),
  mode: z.enum(['local', 'remote']).optional(),
}).passthrough());

/** Released stable/preview CLI clean-end vector, retained only at the machine-bound socket seam. */
export const SessionPublisherLegacyEndSchema = lazySchema(() => z.object({
  sid: z.string().trim().min(1),
  time: z.number().finite(),
}).passthrough());

export type SessionPublisherLegacyAlive = z.infer<typeof SessionPublisherLegacyAliveSchema>;
export type SessionPublisherLegacyEnd = z.infer<typeof SessionPublisherLegacyEndSchema>;

const SessionRuntimeActivityTransportIdentitySchema = lazySchema(() => z.object({
  sessionId: z.string().trim().min(1),
  mutationId: z.string().trim().min(1),
}).strict());

export const SessionRuntimeActivitySnapshotRequestSchema = lazySchema(() => z.object({
  sessionId: z.string().trim().min(1),
  mutationId: z.string().trim().min(1),
  snapshot: SessionRuntimeActivitySnapshotSchema,
}).strict());

const SessionRuntimeActivitySnapshotAppliedAckSchema = lazySchema(() => SessionRuntimeActivityTransportIdentitySchema.extend({
  status: z.literal('applied'),
  projection: SessionRuntimeActivityProjectionSchema,
}).strict());

const SessionRuntimeActivitySnapshotUnchangedAckSchema = lazySchema(() => SessionRuntimeActivityTransportIdentitySchema.extend({
  status: z.literal('unchanged'),
  projection: SessionRuntimeActivityProjectionSchema,
}).strict());

const SessionRuntimeActivitySnapshotRejectedAckSchema = lazySchema(() => SessionRuntimeActivityTransportIdentitySchema.extend({
  status: z.literal('rejected'),
  reason: z.enum([
    'not_found',
    'unauthorized',
    'archived',
    'superseded',
    'revision_overflow',
  ]),
}).strict());

const SessionRuntimeActivitySnapshotInvalidRequestAckSchema = lazySchema(() => z.object({
  status: z.literal('rejected'),
  reason: z.literal('invalid_request'),
}).strict());

const SessionRuntimeActivitySnapshotRetryableAckSchema = lazySchema(() => SessionRuntimeActivityTransportIdentitySchema.extend({
  status: z.literal('retryable'),
  reason: z.literal('internal'),
}).strict());

export const SessionRuntimeActivitySnapshotAckSchema = lazySchema(() => z.union([
  SessionRuntimeActivitySnapshotAppliedAckSchema,
  SessionRuntimeActivitySnapshotUnchangedAckSchema,
  SessionRuntimeActivitySnapshotRejectedAckSchema,
  SessionRuntimeActivitySnapshotInvalidRequestAckSchema,
  SessionRuntimeActivitySnapshotRetryableAckSchema,
]));

export type SessionRuntimeActivitySnapshotRequest = z.infer<typeof SessionRuntimeActivitySnapshotRequestSchema>;
export type SessionRuntimeActivitySnapshotAck = z.infer<typeof SessionRuntimeActivitySnapshotAckSchema>;

export const SessionRuntimeActivityCloseRequestSchema = lazySchema(() => z.object({
  sessionId: z.string().trim().min(1),
}).strict());

export const SessionRuntimeActivityCloseAckSchema = lazySchema(() => z.union([
  z.object({ status: z.literal('closed'), sessionId: z.string().trim().min(1) }).strict(),
  z.object({ status: z.literal('already_inactive'), sessionId: z.string().trim().min(1) }).strict(),
  z.object({
    status: z.literal('rejected'),
    sessionId: z.string().trim().min(1),
    reason: z.enum(['not_found', 'unauthorized', 'archived', 'superseded']),
  }).strict(),
  z.object({
    status: z.literal('retryable'),
    sessionId: z.string().trim().min(1),
    reason: z.literal('internal'),
  }).strict(),
  z.object({ status: z.literal('rejected'), reason: z.literal('invalid_request') }).strict(),
]));

export type SessionRuntimeActivityCloseRequest = z.infer<typeof SessionRuntimeActivityCloseRequestSchema>;
export type SessionRuntimeActivityCloseAck = z.infer<typeof SessionRuntimeActivityCloseAckSchema>;
