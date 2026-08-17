import { z } from 'zod';

import {
  SessionRuntimeActivityProjectionSchema,
  SessionRuntimeActivitySnapshotSchema,
} from './sessionRuntimeActivity.js';

export const SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT = 'session-runtime-activity-snapshot';
export const SESSION_RUNTIME_ACTIVITY_CLOSE_EVENT = 'session-runtime-activity-close';
export const SESSION_PUBLISHER_AUTHORITY_CHECK_EVENT =
  'session-publisher-authority-check';

export const SessionRuntimeActivitySnapshotRequestSchema = z.object({
  sessionId: z.string().trim().min(1),
  mutationId: z.string().trim().min(1),
  snapshot: SessionRuntimeActivitySnapshotSchema,
}).strict();

const SessionRuntimeActivityTransportIdentitySchema = z.object({
  sessionId: z.string().trim().min(1),
  mutationId: z.string().trim().min(1),
}).strict();

export const SessionRuntimeActivitySnapshotAckSchema = z.union([
  SessionRuntimeActivityTransportIdentitySchema.extend({
    status: z.literal('applied'),
    projection: SessionRuntimeActivityProjectionSchema,
  }).strict(),
  SessionRuntimeActivityTransportIdentitySchema.extend({
    status: z.literal('unchanged'),
    projection: SessionRuntimeActivityProjectionSchema,
  }).strict(),
  SessionRuntimeActivityTransportIdentitySchema.extend({
    status: z.literal('rejected'),
    reason: z.enum(['not_found', 'unauthorized', 'archived', 'superseded', 'revision_overflow']),
  }).strict(),
  z.object({
    status: z.literal('rejected'),
    reason: z.literal('invalid_request'),
  }).strict(),
  SessionRuntimeActivityTransportIdentitySchema.extend({
    status: z.literal('retryable'),
    reason: z.literal('internal'),
  }).strict(),
]);

export const SessionRuntimeActivityCloseRequestSchema = z.object({
  sessionId: z.string().trim().min(1),
}).strict();

export const SessionRuntimeActivityCloseAckSchema = z.union([
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
]);

export const SessionPublisherAuthorityCheckRequestSchema = z.object({
  sessionId: z.string().trim().min(1),
}).strict();

export const SessionPublisherAuthorityCheckAckSchema = z.union([
  z.object({
    status: z.literal('current'),
    sessionId: z.string().trim().min(1),
    publisherPrecondition: z.object({
      machineId: z.string().trim().min(1).max(256),
      committedFenceMs: z.number().int().nonnegative()
        .max(Number.MAX_SAFE_INTEGER),
    }).strict(),
  }).strict(),
  z.object({
    status: z.literal('superseded'),
    sessionId: z.string().trim().min(1),
  }).strict(),
  z.object({
    status: z.literal('rejected'),
    reason: z.literal('invalid_request'),
  }).strict(),
  z.object({
    status: z.literal('retryable'),
    sessionId: z.string().trim().min(1),
    reason: z.literal('internal'),
  }).strict(),
]);

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
