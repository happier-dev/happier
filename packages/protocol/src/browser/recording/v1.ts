import { z } from 'zod';

import {
  BrowserRenderEngineKindV1Schema,
  BrowserSemanticAdapterKindV1Schema,
} from '../adapters/kinds.js';
import { BrowserDiagnosticFidelityV1Schema } from '../diagnostics/v1.js';
import { BrowserViewTargetKindV1Schema } from '../target/v1.js';

const IdSchema = z.string().trim().min(1).max(256);
const NonNegativeIntSchema = z.number().int().nonnegative();
const PositiveIntSchema = z.number().int().positive();

export const BrowserRecordingCaptureKindV1Schema = z.enum([
  'cdpScreencast',
  'webContentsCapture',
  'nativeViewCapture',
  'streamFrameCapture',
  'mediaRecorder',
  'unavailable',
]);
export type BrowserRecordingCaptureKindV1 = z.infer<typeof BrowserRecordingCaptureKindV1Schema>;

export const BrowserRecordingRetentionClassV1Schema = z.enum([
  'preSend',
  'attached',
  'clearOnClose',
  'clearOnSend',
  'diagnosticsOnly',
]);
export type BrowserRecordingRetentionClassV1 = z.infer<typeof BrowserRecordingRetentionClassV1Schema>;

export const BrowserRecordingRedactionLevelV1Schema = z.enum([
  'none',
  'metadataOnly',
  'redacted',
  'blocked',
]);
export type BrowserRecordingRedactionLevelV1 = z.infer<typeof BrowserRecordingRedactionLevelV1Schema>;

export const BrowserRecordingPolicyStateV1Schema = z.enum([
  'allowed',
  'permissionDenied',
  'policyDenied',
  'sensitiveOrigin',
  'sensitiveFieldsPresent',
  'ephemeralOnly',
  'captureUnavailable',
  'retentionLimited',
]);
export type BrowserRecordingPolicyStateV1 = z.infer<typeof BrowserRecordingPolicyStateV1Schema>;

export const BrowserRecordingStatusV1Schema = z.enum([
  'starting',
  'recording',
  'paused',
  'stopping',
  'completed',
  'finalized',
  'failed',
  'canceled',
  'discarded',
  'expired',
]);
export type BrowserRecordingStatusV1 = z.infer<typeof BrowserRecordingStatusV1Schema>;

export const BrowserRecordingOutcomeReasonV1Schema = z.enum([
  'user_stopped',
  'user_canceled',
  'user_discarded',
  'duration_cap',
  'size_cap',
  'view_hidden',
  'view_parked',
  'view_suspended',
  'host_lost',
  'view_closed',
  'policy_revoked',
  'permission_denied',
  'adapter_lost',
  'session_closed',
  'logout',
  'capture_failed',
  'capture_unavailable',
  'unsupported',
  'retention_limit',
  'expired',
]);
export type BrowserRecordingOutcomeReasonV1 = z.infer<typeof BrowserRecordingOutcomeReasonV1Schema>;

export const BrowserEvidenceSessionMediaReferenceV1Schema = z
  .object({
    refKind: z.literal('sessionMedia'),
    mediaId: IdSchema,
    mediaKind: z.enum(['image', 'video']),
    mimeType: z.string().trim().min(1).max(128),
    sizeBytes: PositiveIntSchema,
  })
  .strict();
export type BrowserEvidenceSessionMediaReferenceV1 = z.infer<
  typeof BrowserEvidenceSessionMediaReferenceV1Schema
>;

export const BrowserRecordingSessionMediaTargetV1Schema = z
  .object({
    sessionId: IdSchema,
    messageLocalId: IdSchema,
  })
  .strict();
export type BrowserRecordingSessionMediaTargetV1 = z.infer<
  typeof BrowserRecordingSessionMediaTargetV1Schema
>;

export const BrowserRecordingMachineLiveStreamCaptureSourceV1Schema = z
  .object({
    kind: z.literal('machineLiveStream'),
    streamFamily: IdSchema,
    sourceId: IdSchema.optional(),
    sourceMachineId: IdSchema.optional(),
    targetMachineId: IdSchema.optional(),
  })
  .strict();
export type BrowserRecordingMachineLiveStreamCaptureSourceV1 = z.infer<
  typeof BrowserRecordingMachineLiveStreamCaptureSourceV1Schema
>;

export const BrowserRecordingCaptureSourceV1Schema = z.discriminatedUnion('kind', [
  BrowserRecordingMachineLiveStreamCaptureSourceV1Schema,
]);
export type BrowserRecordingCaptureSourceV1 = z.infer<typeof BrowserRecordingCaptureSourceV1Schema>;

export const BrowserEvidenceStructuredReferenceV1Schema = z.discriminatedUnion('refKind', [
  z
    .object({
      refKind: z.literal('browserContextScreenshot'),
      contextId: IdSchema,
      mediaId: IdSchema.optional(),
    })
    .strict(),
  z
    .object({
      refKind: z.literal('browserDiagnosticsBundle'),
      diagnosticsBundleId: IdSchema,
    })
    .strict(),
  z
    .object({
      refKind: z.literal('browserActionTimeline'),
      timelineId: IdSchema,
      actionIds: z.array(IdSchema).optional().default([]),
    })
    .strict(),
]);
export type BrowserEvidenceStructuredReferenceV1 = z.infer<
  typeof BrowserEvidenceStructuredReferenceV1Schema
>;

export const BrowserEvidenceReferenceV1Schema = z.discriminatedUnion('refKind', [
  BrowserEvidenceSessionMediaReferenceV1Schema,
  ...BrowserEvidenceStructuredReferenceV1Schema.options,
]);
export type BrowserEvidenceReferenceV1 = z.infer<typeof BrowserEvidenceReferenceV1Schema>;

export const BrowserRecordingActionChapterV1Schema = z
  .object({
    v: z.literal(1),
    chapterId: IdSchema,
    actionId: IdSchema.optional(),
    startOffsetMs: NonNegativeIntSchema,
    endOffsetMs: NonNegativeIntSchema,
    actionKind: z.string().trim().min(1).max(128),
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'interrupted', 'canceled']),
    requesterClass: z.enum(['human', 'agent', 'system']),
    targetSummary: z.string().trim().min(1).max(512).optional(),
    reason: z.string().trim().min(1).max(256).optional(),
    diagnosticsRefs: z.array(IdSchema).optional().default([]),
  })
  .strict()
  .superRefine((chapter, context) => {
    if (chapter.endOffsetMs < chapter.startOffsetMs) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endOffsetMs'],
        message: 'Browser recording action chapter endOffsetMs must not be before startOffsetMs.',
      });
    }
  });
export type BrowserRecordingActionChapterV1 = z.infer<typeof BrowserRecordingActionChapterV1Schema>;

export const BrowserRecordingSessionV1Schema = z
  .object({
    v: z.literal(1),
    recordingId: IdSchema,
    browserSessionId: IdSchema,
    viewId: IdSchema,
    profileId: IdSchema,
    targetKind: BrowserViewTargetKindV1Schema,
    adapterKind: BrowserSemanticAdapterKindV1Schema,
    renderEngineKind: BrowserRenderEngineKindV1Schema,
    captureKind: BrowserRecordingCaptureKindV1Schema,
    fidelity: BrowserDiagnosticFidelityV1Schema,
    startedAtMs: NonNegativeIntSchema,
    stoppedAtMs: NonNegativeIntSchema.optional(),
    status: BrowserRecordingStatusV1Schema,
    outcomeReason: BrowserRecordingOutcomeReasonV1Schema.optional(),
    navigationGenerationStart: NonNegativeIntSchema,
    navigationGenerationEnd: NonNegativeIntSchema.optional(),
    durationMs: NonNegativeIntSchema,
    byteSize: NonNegativeIntSchema,
    frameCount: NonNegativeIntSchema,
    fps: z.number().nonnegative(),
    mimeType: z.string().trim().min(1).max(128),
    retentionClass: BrowserRecordingRetentionClassV1Schema,
    redactionLevel: BrowserRecordingRedactionLevelV1Schema,
    policyState: BrowserRecordingPolicyStateV1Schema,
    maxDurationMs: PositiveIntSchema,
    maxBytes: PositiveIntSchema,
    expiresAtMs: NonNegativeIntSchema.optional(),
    mediaRef: BrowserEvidenceSessionMediaReferenceV1Schema.optional(),
    actionChapters: z.array(BrowserRecordingActionChapterV1Schema).optional().default([]),
    relatedReferences: z.array(BrowserEvidenceReferenceV1Schema).optional().default([]),
  })
  .strict()
  .superRefine((session, context) => {
    if (session.stoppedAtMs != null && session.stoppedAtMs < session.startedAtMs) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stoppedAtMs'],
        message: 'Browser recording stoppedAtMs must not be before startedAtMs.',
      });
    }
    if (
      session.navigationGenerationEnd != null
      && session.navigationGenerationEnd < session.navigationGenerationStart
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['navigationGenerationEnd'],
        message: 'Browser recording navigationGenerationEnd must not be before navigationGenerationStart.',
      });
    }
    if (
      ['paused', 'completed', 'finalized', 'failed', 'canceled', 'discarded', 'expired'].includes(session.status)
      && !session.outcomeReason
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outcomeReason'],
        message: 'Browser recording non-active lifecycle states require an explicit outcome reason.',
      });
    }
    if ((session.status === 'completed' || session.status === 'finalized') && !session.mediaRef) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mediaRef'],
        message: 'Completed browser recordings must reference stored media metadata.',
      });
    }
    if ((session.status === 'discarded' || session.status === 'expired') && session.mediaRef) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mediaRef'],
        message: 'Discarded or expired browser recordings must not retain media references.',
      });
    }
  });
export type BrowserRecordingSessionV1 = z.infer<typeof BrowserRecordingSessionV1Schema>;

export const BrowserEvidenceArtifactKindV1Schema = z.enum([
  'recording',
  'screenshot',
  'actionTimeline',
  'diagnosticsBundle',
]);
export type BrowserEvidenceArtifactKindV1 = z.infer<typeof BrowserEvidenceArtifactKindV1Schema>;

export const BrowserEvidenceArtifactV1Schema = z
  .object({
    v: z.literal(1),
    artifactId: IdSchema,
    artifactKind: BrowserEvidenceArtifactKindV1Schema,
    sourceViewId: IdSchema,
    sourceBrowserSessionId: IdSchema,
    sourceNavigationGenerationRange: z
      .object({
        start: NonNegativeIntSchema,
        end: NonNegativeIntSchema.optional(),
      })
      .strict(),
    capturedAtMs: NonNegativeIntSchema,
    fidelity: BrowserDiagnosticFidelityV1Schema,
    redactionLevel: BrowserRecordingRedactionLevelV1Schema,
    retentionClass: BrowserRecordingRetentionClassV1Schema,
    expiresAtMs: NonNegativeIntSchema.optional(),
    attachedToSessionId: IdSchema.optional(),
    attachedToTurnId: IdSchema.optional(),
    mediaRef: BrowserEvidenceSessionMediaReferenceV1Schema.optional(),
    structuredRef: BrowserEvidenceStructuredReferenceV1Schema.optional(),
    relatedReferences: z.array(BrowserEvidenceReferenceV1Schema).optional().default([]),
  })
  .strict()
  .superRefine((artifact, context) => {
    if (
      artifact.sourceNavigationGenerationRange.end != null
      && artifact.sourceNavigationGenerationRange.end < artifact.sourceNavigationGenerationRange.start
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceNavigationGenerationRange', 'end'],
        message: 'Evidence navigation range end must not be before start.',
      });
    }
    if ((artifact.artifactKind === 'recording' || artifact.artifactKind === 'screenshot') && !artifact.mediaRef) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mediaRef'],
        message: 'Media-backed evidence artifacts require a media reference.',
      });
    }
    if (
      (artifact.artifactKind === 'actionTimeline' || artifact.artifactKind === 'diagnosticsBundle')
      && !artifact.structuredRef
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['structuredRef'],
        message: 'Structured evidence artifacts require a structured reference.',
      });
    }
  });
export type BrowserEvidenceArtifactV1 = z.infer<typeof BrowserEvidenceArtifactV1Schema>;

export const DaemonBrowserRecordingUnavailableReasonV1Schema = z
  .object({
    code: z.string().trim().min(1).max(128),
    message: z.string().trim().min(1).max(512),
  })
  .strict();
export type DaemonBrowserRecordingUnavailableReasonV1 = z.infer<
  typeof DaemonBrowserRecordingUnavailableReasonV1Schema
>;

export const DaemonBrowserRecordingStartInputV1Schema = z
  .object({
    browserSessionId: IdSchema,
    viewId: IdSchema,
    profileId: IdSchema,
    targetKind: BrowserViewTargetKindV1Schema,
    adapterKind: BrowserSemanticAdapterKindV1Schema,
    renderEngineKind: BrowserRenderEngineKindV1Schema,
    captureKind: BrowserRecordingCaptureKindV1Schema,
    fidelity: BrowserDiagnosticFidelityV1Schema,
    navigationGeneration: NonNegativeIntSchema,
    mimeType: z.string().trim().min(1).max(128),
    retentionClass: BrowserRecordingRetentionClassV1Schema,
    policyState: BrowserRecordingPolicyStateV1Schema.optional(),
    mediaTarget: BrowserRecordingSessionMediaTargetV1Schema.optional(),
    captureSource: BrowserRecordingCaptureSourceV1Schema.optional(),
    startedAtMs: NonNegativeIntSchema.optional(),
    recordingId: IdSchema.optional(),
  })
  .strict();
export type DaemonBrowserRecordingStartInputV1 = z.infer<
  typeof DaemonBrowserRecordingStartInputV1Schema
>;

export const DaemonBrowserRecordingStartResultV1Schema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('started'),
      recording: BrowserRecordingSessionV1Schema,
    })
    .strict(),
  z
    .object({
      status: z.literal('unavailable'),
      reason: DaemonBrowserRecordingUnavailableReasonV1Schema,
    })
    .strict(),
]);
export type DaemonBrowserRecordingStartResultV1 = z.infer<
  typeof DaemonBrowserRecordingStartResultV1Schema
>;

export const DaemonBrowserRecordingStopInputV1Schema = z
  .object({
    recordingId: IdSchema,
    stoppedAtMs: NonNegativeIntSchema.optional(),
    navigationGenerationEnd: NonNegativeIntSchema,
    expiresAtMs: NonNegativeIntSchema.optional(),
  })
  .strict();
export type DaemonBrowserRecordingStopInputV1 = z.infer<
  typeof DaemonBrowserRecordingStopInputV1Schema
>;

export const DaemonBrowserRecordingStopResultV1Schema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('finalized'),
      recording: BrowserRecordingSessionV1Schema,
    })
    .strict(),
  z
    .object({
      status: z.literal('failed'),
      recording: BrowserRecordingSessionV1Schema,
      reason: BrowserRecordingOutcomeReasonV1Schema,
    })
    .strict(),
  z
    .object({
      status: z.literal('unavailable'),
      reason: DaemonBrowserRecordingUnavailableReasonV1Schema,
    })
    .strict(),
]);
export type DaemonBrowserRecordingStopResultV1 = z.infer<
  typeof DaemonBrowserRecordingStopResultV1Schema
>;

export const DaemonBrowserRecordingCancelInputV1Schema = z
  .object({
    recordingId: IdSchema,
    atMs: NonNegativeIntSchema.optional(),
    reason: z.enum(['user_canceled', 'user_discarded', 'session_closed', 'logout']),
  })
  .strict();
export type DaemonBrowserRecordingCancelInputV1 = z.infer<
  typeof DaemonBrowserRecordingCancelInputV1Schema
>;

export const DaemonBrowserRecordingTerminalResultV1Schema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.enum(['paused', 'failed', 'canceled', 'discarded']),
      recording: BrowserRecordingSessionV1Schema,
    })
    .strict(),
  z
    .object({
      status: z.literal('unavailable'),
      reason: DaemonBrowserRecordingUnavailableReasonV1Schema,
    })
    .strict(),
]);
export type DaemonBrowserRecordingTerminalResultV1 = z.infer<
  typeof DaemonBrowserRecordingTerminalResultV1Schema
>;

export const DaemonBrowserRecordingStatusInputV1Schema = z
  .object({
    recordingId: IdSchema,
  })
  .strict();
export type DaemonBrowserRecordingStatusInputV1 = z.infer<
  typeof DaemonBrowserRecordingStatusInputV1Schema
>;

export const DaemonBrowserRecordingListInputV1Schema = z
  .object({
    viewId: IdSchema,
  })
  .strict();
export type DaemonBrowserRecordingListInputV1 = z.infer<
  typeof DaemonBrowserRecordingListInputV1Schema
>;

export const DaemonBrowserRecordingCleanupInputV1Schema = z
  .object({
    nowMs: NonNegativeIntSchema.optional(),
  })
  .strict();
export type DaemonBrowserRecordingCleanupInputV1 = z.infer<
  typeof DaemonBrowserRecordingCleanupInputV1Schema
>;

export const DaemonBrowserRecordingCleanupResultV1Schema = z
  .object({
    discardedRecordingIds: z.array(IdSchema),
    failedRecordingIds: z.array(IdSchema),
  })
  .strict();
export type DaemonBrowserRecordingCleanupResultV1 = z.infer<
  typeof DaemonBrowserRecordingCleanupResultV1Schema
>;

export const DaemonBrowserRecordingStartRequestV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    machineId: IdSchema,
    input: DaemonBrowserRecordingStartInputV1Schema,
  })
  .strict();
export type DaemonBrowserRecordingStartRequestV1 = z.infer<
  typeof DaemonBrowserRecordingStartRequestV1Schema
>;

export const DaemonBrowserRecordingStartResponseV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    result: DaemonBrowserRecordingStartResultV1Schema,
  })
  .strict();
export type DaemonBrowserRecordingStartResponseV1 = z.infer<
  typeof DaemonBrowserRecordingStartResponseV1Schema
>;

export const DaemonBrowserRecordingStopRequestV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    machineId: IdSchema,
    recordingId: IdSchema,
    stoppedAtMs: NonNegativeIntSchema.optional(),
    navigationGenerationEnd: NonNegativeIntSchema,
    expiresAtMs: NonNegativeIntSchema.optional(),
  })
  .strict();
export type DaemonBrowserRecordingStopRequestV1 = z.infer<
  typeof DaemonBrowserRecordingStopRequestV1Schema
>;

export const DaemonBrowserRecordingStopResponseV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    result: DaemonBrowserRecordingStopResultV1Schema,
  })
  .strict();
export type DaemonBrowserRecordingStopResponseV1 = z.infer<
  typeof DaemonBrowserRecordingStopResponseV1Schema
>;

export const DaemonBrowserRecordingCancelRequestV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    machineId: IdSchema,
    recordingId: IdSchema,
    atMs: NonNegativeIntSchema.optional(),
    reason: z.enum(['user_canceled', 'user_discarded', 'session_closed', 'logout']),
  })
  .strict();
export type DaemonBrowserRecordingCancelRequestV1 = z.infer<
  typeof DaemonBrowserRecordingCancelRequestV1Schema
>;

export const DaemonBrowserRecordingCancelResponseV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    result: DaemonBrowserRecordingTerminalResultV1Schema,
  })
  .strict();
export type DaemonBrowserRecordingCancelResponseV1 = z.infer<
  typeof DaemonBrowserRecordingCancelResponseV1Schema
>;

export const DaemonBrowserRecordingStatusRequestV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    machineId: IdSchema,
    recordingId: IdSchema,
  })
  .strict();
export type DaemonBrowserRecordingStatusRequestV1 = z.infer<
  typeof DaemonBrowserRecordingStatusRequestV1Schema
>;

export const DaemonBrowserRecordingStatusResponseV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    recording: BrowserRecordingSessionV1Schema.nullable(),
  })
  .strict();
export type DaemonBrowserRecordingStatusResponseV1 = z.infer<
  typeof DaemonBrowserRecordingStatusResponseV1Schema
>;

export const DaemonBrowserRecordingListRequestV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    machineId: IdSchema,
    viewId: IdSchema,
  })
  .strict();
export type DaemonBrowserRecordingListRequestV1 = z.infer<
  typeof DaemonBrowserRecordingListRequestV1Schema
>;

export const DaemonBrowserRecordingListResponseV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    recordings: z.array(BrowserRecordingSessionV1Schema),
  })
  .strict();
export type DaemonBrowserRecordingListResponseV1 = z.infer<
  typeof DaemonBrowserRecordingListResponseV1Schema
>;

export const DaemonBrowserRecordingCleanupRequestV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    machineId: IdSchema,
    nowMs: NonNegativeIntSchema.optional(),
  })
  .strict();
export type DaemonBrowserRecordingCleanupRequestV1 = z.infer<
  typeof DaemonBrowserRecordingCleanupRequestV1Schema
>;

export const DaemonBrowserRecordingCleanupResponseV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    result: DaemonBrowserRecordingCleanupResultV1Schema,
  })
  .strict();
export type DaemonBrowserRecordingCleanupResponseV1 = z.infer<
  typeof DaemonBrowserRecordingCleanupResponseV1Schema
>;
