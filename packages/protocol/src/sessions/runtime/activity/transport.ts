import { z } from 'zod';

import {
  SessionRuntimeActivityProjectionSchema,
  SessionRuntimeActivitySnapshotSchema,
} from './sessionRuntimeActivity.js';

export const SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT = 'session-runtime-activity-snapshot';
export const SESSION_RUNTIME_ACTIVITY_CLOSE_EVENT = 'session-runtime-activity-close';

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

export type SessionRuntimeActivitySnapshotRequest = z.infer<typeof SessionRuntimeActivitySnapshotRequestSchema>;
export type SessionRuntimeActivitySnapshotAck = z.infer<typeof SessionRuntimeActivitySnapshotAckSchema>;
export type SessionRuntimeActivityCloseRequest = z.infer<typeof SessionRuntimeActivityCloseRequestSchema>;
export type SessionRuntimeActivityCloseAck = z.infer<typeof SessionRuntimeActivityCloseAckSchema>;
