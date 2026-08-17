import { z } from 'zod';

import { SessionIdSchema } from '../idsV1.js';
import { HappierManagedSessionRuntimeModeV1Schema } from '../runtimeModeV1.js';
import { LinkedExternalSessionQualifiedIdentityV1Schema } from './linkedSessionMetadata.js';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";

export const ExternalSessionTakeoverStorageModeV1Schema = z.enum(['external-linked', 'persisted']);
export type ExternalSessionTakeoverStorageModeV1 = z.infer<typeof ExternalSessionTakeoverStorageModeV1Schema>;

export const ExternalSessionTakeoverInputV1Schema = z.object({
  linkedSessionId: asProtocolZod(SessionIdSchema),
  machineId: z.string().trim().min(1).max(2_000).optional(),
  targetRuntimeMode: HappierManagedSessionRuntimeModeV1Schema,
  storageMode: ExternalSessionTakeoverStorageModeV1Schema,
}).strict();
export type ExternalSessionTakeoverInputV1 = z.infer<typeof ExternalSessionTakeoverInputV1Schema>;

export const ExternalSessionDestructiveQuiescenceStatusV1Schema = z.enum([
  'verified_running',
  'verified_stopped',
  'unknown',
]);
export type ExternalSessionDestructiveQuiescenceStatusV1 = z.infer<
  typeof ExternalSessionDestructiveQuiescenceStatusV1Schema
>;

export const ExternalSessionDestructiveSourceIdentityV1Schema = z.object({
  machineId: z.string().trim().min(1).max(2_000),
  linkedSessionId: asProtocolZod(SessionIdSchema),
  remoteSessionId: z.string().trim().min(1).max(2_000),
  linkGeneration: z.string().trim().min(1).max(2_000),
  sourceKey: z.string().trim().min(1).max(10_000),
  qualifiedIdentity: LinkedExternalSessionQualifiedIdentityV1Schema,
}).strict();
export type ExternalSessionDestructiveSourceIdentityV1 = z.infer<
  typeof ExternalSessionDestructiveSourceIdentityV1Schema
>;

export const ExternalSessionDestructiveProcessIdentityV1Schema = z.object({
  machineId: z.string().trim().min(1).max(2_000),
  pid: z.number().int().positive(),
  startedAtMs: z.number().int().nonnegative(),
}).strict();
export type ExternalSessionDestructiveProcessIdentityV1 = z.infer<
  typeof ExternalSessionDestructiveProcessIdentityV1Schema
>;

export const ExternalSessionDestructiveQuiescenceEvidenceV1Schema = z.object({
  kind: z.enum([
    'happier_managed_process_state',
    'agent_native_process_state',
    'operating_system_process_state',
  ]),
  processState: ExternalSessionDestructiveQuiescenceStatusV1Schema,
  observedAtMs: z.number().int().nonnegative(),
  sourceIdentity: ExternalSessionDestructiveSourceIdentityV1Schema,
  processIdentity: ExternalSessionDestructiveProcessIdentityV1Schema,
}).strict();
export type ExternalSessionDestructiveQuiescenceEvidenceV1 = z.infer<
  typeof ExternalSessionDestructiveQuiescenceEvidenceV1Schema
>;

function hasSameDestructiveSourceIdentity(
  left: ExternalSessionDestructiveSourceIdentityV1,
  right: ExternalSessionDestructiveSourceIdentityV1,
): boolean {
  return left.machineId === right.machineId
    && left.linkedSessionId === right.linkedSessionId
    && left.remoteSessionId === right.remoteSessionId
    && left.linkGeneration === right.linkGeneration
    && left.sourceKey === right.sourceKey
    && left.qualifiedIdentity.agent.pluginId === right.qualifiedIdentity.agent.pluginId
    && left.qualifiedIdentity.agent.localId === right.qualifiedIdentity.agent.localId
    && left.qualifiedIdentity.source.kind === right.qualifiedIdentity.source.kind
    && left.qualifiedIdentity.source.contractVersion === right.qualifiedIdentity.source.contractVersion;
}

function hasSameDestructiveProcessIdentity(
  left: ExternalSessionDestructiveProcessIdentityV1,
  right: ExternalSessionDestructiveProcessIdentityV1,
): boolean {
  return left.machineId === right.machineId
    && left.pid === right.pid
    && left.startedAtMs === right.startedAtMs;
}

export const ExternalSessionDestructiveQuiescenceResultV1Schema = z.object({
  status: ExternalSessionDestructiveQuiescenceStatusV1Schema,
  sourceIdentity: ExternalSessionDestructiveSourceIdentityV1Schema,
  processIdentity: ExternalSessionDestructiveProcessIdentityV1Schema,
  evidence: ExternalSessionDestructiveQuiescenceEvidenceV1Schema,
}).strict().superRefine((result, context) => {
  if (result.sourceIdentity.machineId !== result.processIdentity.machineId) {
    context.addIssue({
      code: 'custom',
      path: ['processIdentity', 'machineId'],
      message: 'Destructive quiescence source and process identities must name the same machine.',
    });
  }
  if (result.status !== result.evidence.processState) {
    context.addIssue({
      code: 'custom',
      path: ['evidence', 'processState'],
      message: 'Destructive quiescence status must match its process evidence.',
    });
  }
  if (!hasSameDestructiveSourceIdentity(result.sourceIdentity, result.evidence.sourceIdentity)) {
    context.addIssue({
      code: 'custom',
      path: ['evidence', 'sourceIdentity'],
      message: 'Destructive quiescence evidence must match the exact source identity.',
    });
  }
  if (!hasSameDestructiveProcessIdentity(result.processIdentity, result.evidence.processIdentity)) {
    context.addIssue({
      code: 'custom',
      path: ['evidence', 'processIdentity'],
      message: 'Destructive quiescence evidence must match the exact process identity.',
    });
  }
});
export type ExternalSessionDestructiveQuiescenceResultV1 = z.infer<
  typeof ExternalSessionDestructiveQuiescenceResultV1Schema
>;

export function doesExternalSessionDestructiveQuiescencePermitAdmissionV1(
  result: ExternalSessionDestructiveQuiescenceResultV1,
): boolean {
  return result.status === 'verified_stopped';
}

const ExternalSessionTakeoverExistingErrorCodeV1Schema = z.enum([
  'machine_offline',
  'session_not_found',
  'invalid_external_source',
  'takeover_not_available',
  'force_stop_required',
  'transcript_import_failed',
  'spawn_failed',
  'capability_unsupported',
  'upgrade_required',
]);

export const ExternalSessionTakeoverSafetyErrorCodeV1Schema = z.enum([
  'external_process_active',
  'external_process_unknown',
  'external_writer_conflict',
]);
export type ExternalSessionTakeoverSafetyErrorCodeV1 = z.infer<
  typeof ExternalSessionTakeoverSafetyErrorCodeV1Schema
>;

export const ExternalSessionTakeoverErrorCodeV1Schema = z.union([
  ExternalSessionTakeoverExistingErrorCodeV1Schema,
  ExternalSessionTakeoverSafetyErrorCodeV1Schema,
]);
export type ExternalSessionTakeoverErrorCodeV1 = z.infer<typeof ExternalSessionTakeoverErrorCodeV1Schema>;

export const ExternalSessionTakeoverFailureDetailsV1Schema = z.object({
  machineId: z.string().trim().min(1).max(2_000),
  observedAtMs: z.number().int().nonnegative(),
  evidenceKind: ExternalSessionDestructiveQuiescenceEvidenceV1Schema.shape.kind,
  process: ExternalSessionDestructiveProcessIdentityV1Schema.optional(),
  sourceKind: z.string().trim().min(1).max(256).optional(),
}).strict().superRefine((details, context) => {
  if (details.process && details.process.machineId !== details.machineId) {
    context.addIssue({
      code: 'custom',
      path: ['process', 'machineId'],
      message: 'Portable takeover process details must match the reported machine.',
    });
  }
});
export type ExternalSessionTakeoverFailureDetailsV1 = z.infer<
  typeof ExternalSessionTakeoverFailureDetailsV1Schema
>;

export const ExternalSessionTakeoverResultV1Schema = z.union([
  z.object({
    ok: z.literal(true),
    sessionId: asProtocolZod(SessionIdSchema),
    targetRuntimeMode: HappierManagedSessionRuntimeModeV1Schema,
    storageMode: ExternalSessionTakeoverStorageModeV1Schema,
    converted: z.boolean(),
  }).passthrough(),
  z.object({
    ok: z.literal(false),
    errorCode: ExternalSessionTakeoverSafetyErrorCodeV1Schema,
    error: z.string().trim().min(1).max(2_000),
    gracefulStopAvailable: z.boolean(),
    details: ExternalSessionTakeoverFailureDetailsV1Schema,
  }).strict(),
  z.object({
    ok: z.literal(false),
    errorCode: ExternalSessionTakeoverExistingErrorCodeV1Schema,
    error: z.string().trim().min(1).max(2_000),
    trustedPid: z.number().int().positive().optional(),
  }).passthrough(),
]);
export type ExternalSessionTakeoverResultV1 = z.infer<typeof ExternalSessionTakeoverResultV1Schema>;
