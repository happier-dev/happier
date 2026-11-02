import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import {
  BrowserRenderEngineKindV1Schema,
  BrowserSemanticAdapterKindV1Schema,
} from '../adapters/kinds.js';
import { BrowserDiagnosticFidelityV1Schema } from '../diagnostics/v1.js';
import { BrowserViewTargetKindV1Schema } from '../target/v1.js';

const IdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(256)));
const NonNegativeIntSchema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));
const PositiveIntSchema = lazyZodSchema(() => z.number().check(z.int(), z.positive()));

export const BrowserRecordingCaptureKindV1Schema = lazyZodSchema(() => z.enum([
  'cdpScreencast',
  'webContentsCapture',
  'nativeViewCapture',
  'streamFrameCapture',
  'mediaRecorder',
  'unavailable',
]));
export type BrowserRecordingCaptureKindV1 = z.infer<typeof BrowserRecordingCaptureKindV1Schema>;

export const BrowserRecordingRetentionClassV1Schema = lazyZodSchema(() => z.enum([
  'preSend',
  'attached',
  'clearOnClose',
  'clearOnSend',
  'diagnosticsOnly',
]));
export type BrowserRecordingRetentionClassV1 = z.infer<typeof BrowserRecordingRetentionClassV1Schema>;

export const BrowserRecordingRedactionLevelV1Schema = lazyZodSchema(() => z.enum([
  'none',
  'metadataOnly',
  'redacted',
  'blocked',
]));
export type BrowserRecordingRedactionLevelV1 = z.infer<typeof BrowserRecordingRedactionLevelV1Schema>;

export const BrowserRecordingPolicyStateV1Schema = lazyZodSchema(() => z.enum([
  'allowed',
  'permissionDenied',
  'policyDenied',
  'sensitiveOrigin',
  'sensitiveFieldsPresent',
  'ephemeralOnly',
  'captureUnavailable',
  'retentionLimited',
]));
export type BrowserRecordingPolicyStateV1 = z.infer<typeof BrowserRecordingPolicyStateV1Schema>;

export const BrowserRecordingStatusV1Schema = lazyZodSchema(() => z.enum([
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
]));
export type BrowserRecordingStatusV1 = z.infer<typeof BrowserRecordingStatusV1Schema>;

export const BrowserRecordingOutcomeReasonV1Schema = lazyZodSchema(() => z.enum([
  'user_stopped',
  'user_canceled',
  'user_discarded',
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
]));
export type BrowserRecordingOutcomeReasonV1 = z.infer<typeof BrowserRecordingOutcomeReasonV1Schema>;

export const BrowserEvidenceSessionMediaReferenceV1Schema = lazyZodSchema(() => z.strictObject({
    refKind: z.literal('sessionMedia'),
    mediaId: IdSchema,
    mediaKind: z.enum(['image', 'video']),
    mimeType: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
    sizeBytes: PositiveIntSchema,
  }));
export type BrowserEvidenceSessionMediaReferenceV1 = z.infer<
  typeof BrowserEvidenceSessionMediaReferenceV1Schema
>;

export const BrowserRecordingSessionMediaTargetV1Schema = lazyZodSchema(() => z.strictObject({
    sessionId: IdSchema,
    messageLocalId: IdSchema,
  }));
export type BrowserRecordingSessionMediaTargetV1 = z.infer<
  typeof BrowserRecordingSessionMediaTargetV1Schema
>;

export const BrowserRecordingMachineLiveStreamCaptureSourceV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('machineLiveStream'),
    streamFamily: IdSchema,
    sourceId: z.optional(IdSchema),
    sourceMachineId: z.optional(IdSchema),
    targetMachineId: z.optional(IdSchema),
  }));
export type BrowserRecordingMachineLiveStreamCaptureSourceV1 = z.infer<
  typeof BrowserRecordingMachineLiveStreamCaptureSourceV1Schema
>;

export const BrowserRecordingCaptureSourceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  BrowserRecordingMachineLiveStreamCaptureSourceV1Schema,
]));
export type BrowserRecordingCaptureSourceV1 = z.infer<typeof BrowserRecordingCaptureSourceV1Schema>;

export const BrowserEvidenceStructuredReferenceV1Schema = lazyZodSchema(() => z.discriminatedUnion('refKind', [
  z.strictObject({
      refKind: z.literal('browserContextScreenshot'),
      contextId: IdSchema,
      mediaId: z.optional(IdSchema),
    }),
  z.strictObject({
      refKind: z.literal('browserDiagnosticsBundle'),
      diagnosticsBundleId: IdSchema,
    }),
  z.strictObject({
      refKind: z.literal('browserActionTimeline'),
      timelineId: IdSchema,
      actionIds: z._default(z.optional(z.array(IdSchema)), []),
    }),
]));
export type BrowserEvidenceStructuredReferenceV1 = z.infer<
  typeof BrowserEvidenceStructuredReferenceV1Schema
>;

export const BrowserEvidenceReferenceV1Schema = lazyZodSchema(() => z.discriminatedUnion('refKind', [
  BrowserEvidenceSessionMediaReferenceV1Schema,
  ...BrowserEvidenceStructuredReferenceV1Schema._zod.def.options,
]));
export type BrowserEvidenceReferenceV1 = z.infer<typeof BrowserEvidenceReferenceV1Schema>;

export const BrowserRecordingActionChapterV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    chapterId: IdSchema,
    actionId: z.optional(IdSchema),
    startOffsetMs: NonNegativeIntSchema,
    endOffsetMs: NonNegativeIntSchema,
    actionKind: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'interrupted', 'canceled']),
    requesterClass: z.enum(['human', 'agent', 'system']),
    targetSummary: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
    reason: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    diagnosticsRefs: z._default(z.optional(z.array(IdSchema)), []),
  }).check(z.superRefine((chapter, context) => {
    if (chapter.endOffsetMs < chapter.startOffsetMs) {
      context.addIssue({
        code: "custom",
        path: ['endOffsetMs'],
        message: 'Browser recording action chapter endOffsetMs must not be before startOffsetMs.',
      });
    }
  })));
export type BrowserRecordingActionChapterV1 = z.infer<typeof BrowserRecordingActionChapterV1Schema>;

export const BrowserRecordingSessionV1Schema = lazyZodSchema(() => z.strictObject({
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
    stoppedAtMs: z.optional(NonNegativeIntSchema),
    status: BrowserRecordingStatusV1Schema,
    outcomeReason: z.optional(BrowserRecordingOutcomeReasonV1Schema),
    navigationGenerationStart: NonNegativeIntSchema,
    navigationGenerationEnd: z.optional(NonNegativeIntSchema),
    durationMs: NonNegativeIntSchema,
    byteSize: NonNegativeIntSchema,
    frameCount: NonNegativeIntSchema,
    fps: z.number().check(z.nonnegative()),
    mimeType: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
    retentionClass: BrowserRecordingRetentionClassV1Schema,
    redactionLevel: BrowserRecordingRedactionLevelV1Schema,
    policyState: BrowserRecordingPolicyStateV1Schema,
    expiresAtMs: z.optional(NonNegativeIntSchema),
    mediaRef: z.optional(BrowserEvidenceSessionMediaReferenceV1Schema),
    actionChapters: z._default(z.optional(z.array(BrowserRecordingActionChapterV1Schema)), []),
    relatedReferences: z._default(z.optional(z.array(BrowserEvidenceReferenceV1Schema)), []),
  }).check(z.superRefine((session, context) => {
    if (session.stoppedAtMs != null && session.stoppedAtMs < session.startedAtMs) {
      context.addIssue({
        code: "custom",
        path: ['stoppedAtMs'],
        message: 'Browser recording stoppedAtMs must not be before startedAtMs.',
      });
    }
    if (
      session.navigationGenerationEnd != null
      && session.navigationGenerationEnd < session.navigationGenerationStart
    ) {
      context.addIssue({
        code: "custom",
        path: ['navigationGenerationEnd'],
        message: 'Browser recording navigationGenerationEnd must not be before navigationGenerationStart.',
      });
    }
    if (
      ['paused', 'completed', 'finalized', 'failed', 'canceled', 'discarded', 'expired'].includes(session.status)
      && !session.outcomeReason
    ) {
      context.addIssue({
        code: "custom",
        path: ['outcomeReason'],
        message: 'Browser recording non-active lifecycle states require an explicit outcome reason.',
      });
    }
    if ((session.status === 'completed' || session.status === 'finalized') && !session.mediaRef) {
      context.addIssue({
        code: "custom",
        path: ['mediaRef'],
        message: 'Completed browser recordings must reference stored media metadata.',
      });
    }
    if ((session.status === 'discarded' || session.status === 'expired') && session.mediaRef) {
      context.addIssue({
        code: "custom",
        path: ['mediaRef'],
        message: 'Discarded or expired browser recordings must not retain media references.',
      });
    }
  })));
export type BrowserRecordingSessionV1 = z.infer<typeof BrowserRecordingSessionV1Schema>;

export const BrowserEvidenceArtifactKindV1Schema = lazyZodSchema(() => z.enum([
  'recording',
  'screenshot',
  'actionTimeline',
  'diagnosticsBundle',
]));
export type BrowserEvidenceArtifactKindV1 = z.infer<typeof BrowserEvidenceArtifactKindV1Schema>;

export const BrowserEvidenceArtifactV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    artifactId: IdSchema,
    artifactKind: BrowserEvidenceArtifactKindV1Schema,
    sourceViewId: IdSchema,
    sourceBrowserSessionId: IdSchema,
    sourceNavigationGenerationRange: z.strictObject({
        start: NonNegativeIntSchema,
        end: z.optional(NonNegativeIntSchema),
      }),
    capturedAtMs: NonNegativeIntSchema,
    fidelity: BrowserDiagnosticFidelityV1Schema,
    redactionLevel: BrowserRecordingRedactionLevelV1Schema,
    retentionClass: BrowserRecordingRetentionClassV1Schema,
    expiresAtMs: z.optional(NonNegativeIntSchema),
    attachedToSessionId: z.optional(IdSchema),
    attachedToTurnId: z.optional(IdSchema),
    mediaRef: z.optional(BrowserEvidenceSessionMediaReferenceV1Schema),
    structuredRef: z.optional(BrowserEvidenceStructuredReferenceV1Schema),
    relatedReferences: z._default(z.optional(z.array(BrowserEvidenceReferenceV1Schema)), []),
  }).check(z.superRefine((artifact, context) => {
    if (
      artifact.sourceNavigationGenerationRange.end != null
      && artifact.sourceNavigationGenerationRange.end < artifact.sourceNavigationGenerationRange.start
    ) {
      context.addIssue({
        code: "custom",
        path: ['sourceNavigationGenerationRange', 'end'],
        message: 'Evidence navigation range end must not be before start.',
      });
    }
    if ((artifact.artifactKind === 'recording' || artifact.artifactKind === 'screenshot') && !artifact.mediaRef) {
      context.addIssue({
        code: "custom",
        path: ['mediaRef'],
        message: 'Media-backed evidence artifacts require a media reference.',
      });
    }
    if (
      (artifact.artifactKind === 'actionTimeline' || artifact.artifactKind === 'diagnosticsBundle')
      && !artifact.structuredRef
    ) {
      context.addIssue({
        code: "custom",
        path: ['structuredRef'],
        message: 'Structured evidence artifacts require a structured reference.',
      });
    }
  })));
export type BrowserEvidenceArtifactV1 = z.infer<typeof BrowserEvidenceArtifactV1Schema>;

export const DaemonBrowserRecordingUnavailableReasonV1Schema = lazyZodSchema(() => z.strictObject({
    code: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
    message: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
  }));
export type DaemonBrowserRecordingUnavailableReasonV1 = z.infer<
  typeof DaemonBrowserRecordingUnavailableReasonV1Schema
>;

export const DaemonBrowserRecordingStartInputV1Schema = lazyZodSchema(() => z.strictObject({
    browserSessionId: IdSchema,
    viewId: IdSchema,
    profileId: IdSchema,
    targetKind: BrowserViewTargetKindV1Schema,
    adapterKind: BrowserSemanticAdapterKindV1Schema,
    renderEngineKind: BrowserRenderEngineKindV1Schema,
    captureKind: BrowserRecordingCaptureKindV1Schema,
    fidelity: BrowserDiagnosticFidelityV1Schema,
    navigationGeneration: NonNegativeIntSchema,
    mimeType: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
    retentionClass: BrowserRecordingRetentionClassV1Schema,
    policyState: z.optional(BrowserRecordingPolicyStateV1Schema),
    mediaTarget: z.optional(BrowserRecordingSessionMediaTargetV1Schema),
    captureSource: z.optional(BrowserRecordingCaptureSourceV1Schema),
    startedAtMs: z.optional(NonNegativeIntSchema),
    recordingId: z.optional(IdSchema),
  }));
export type DaemonBrowserRecordingStartInputV1 = z.infer<
  typeof DaemonBrowserRecordingStartInputV1Schema
>;

export const DaemonBrowserRecordingStartResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({
      status: z.literal('started'),
      recording: BrowserRecordingSessionV1Schema,
    }),
  z.strictObject({
      status: z.literal('unavailable'),
      reason: DaemonBrowserRecordingUnavailableReasonV1Schema,
    }),
]));
export type DaemonBrowserRecordingStartResultV1 = z.infer<
  typeof DaemonBrowserRecordingStartResultV1Schema
>;

export const DaemonBrowserRecordingStopInputV1Schema = lazyZodSchema(() => z.strictObject({
    recordingId: IdSchema,
    stoppedAtMs: z.optional(NonNegativeIntSchema),
    navigationGenerationEnd: NonNegativeIntSchema,
    expiresAtMs: z.optional(NonNegativeIntSchema),
  }));
export type DaemonBrowserRecordingStopInputV1 = z.infer<
  typeof DaemonBrowserRecordingStopInputV1Schema
>;

export const DaemonBrowserRecordingStopResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({
      status: z.literal('finalized'),
      recording: BrowserRecordingSessionV1Schema,
    }),
  z.strictObject({
      status: z.literal('failed'),
      recording: BrowserRecordingSessionV1Schema,
      reason: BrowserRecordingOutcomeReasonV1Schema,
    }),
  z.strictObject({
      status: z.literal('unavailable'),
      reason: DaemonBrowserRecordingUnavailableReasonV1Schema,
    }),
]));
export type DaemonBrowserRecordingStopResultV1 = z.infer<
  typeof DaemonBrowserRecordingStopResultV1Schema
>;

export const DaemonBrowserRecordingCancelInputV1Schema = lazyZodSchema(() => z.strictObject({
    recordingId: IdSchema,
    atMs: z.optional(NonNegativeIntSchema),
    reason: z.enum(['user_canceled', 'user_discarded', 'session_closed', 'logout']),
  }));
export type DaemonBrowserRecordingCancelInputV1 = z.infer<
  typeof DaemonBrowserRecordingCancelInputV1Schema
>;

export const DaemonBrowserRecordingTerminalResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({
      status: z.enum(['paused', 'failed', 'canceled', 'discarded']),
      recording: BrowserRecordingSessionV1Schema,
    }),
  z.strictObject({
      status: z.literal('unavailable'),
      reason: DaemonBrowserRecordingUnavailableReasonV1Schema,
    }),
]));
export type DaemonBrowserRecordingTerminalResultV1 = z.infer<
  typeof DaemonBrowserRecordingTerminalResultV1Schema
>;

export const DaemonBrowserRecordingStatusInputV1Schema = lazyZodSchema(() => z.strictObject({
    recordingId: IdSchema,
  }));
export type DaemonBrowserRecordingStatusInputV1 = z.infer<
  typeof DaemonBrowserRecordingStatusInputV1Schema
>;

export const DaemonBrowserRecordingListInputV1Schema = lazyZodSchema(() => z.strictObject({
    browserSessionId: IdSchema,
    viewId: IdSchema,
  }));
export type DaemonBrowserRecordingListInputV1 = z.infer<
  typeof DaemonBrowserRecordingListInputV1Schema
>;

export const DaemonBrowserRecordingCleanupInputV1Schema = lazyZodSchema(() => z.strictObject({
    nowMs: z.optional(NonNegativeIntSchema),
  }));
export type DaemonBrowserRecordingCleanupInputV1 = z.infer<
  typeof DaemonBrowserRecordingCleanupInputV1Schema
>;

export const DaemonBrowserRecordingCleanupResultV1Schema = lazyZodSchema(() => z.strictObject({
    discardedRecordingIds: z.array(IdSchema),
    failedRecordingIds: z.array(IdSchema),
  }));
export type DaemonBrowserRecordingCleanupResultV1 = z.infer<
  typeof DaemonBrowserRecordingCleanupResultV1Schema
>;

export const DaemonBrowserRecordingStartRequestV1Schema = lazyZodSchema(() => z.strictObject({
    protocolVersion: z.literal(1),
    machineId: IdSchema,
    input: DaemonBrowserRecordingStartInputV1Schema,
  }));
export type DaemonBrowserRecordingStartRequestV1 = z.infer<
  typeof DaemonBrowserRecordingStartRequestV1Schema
>;

export const DaemonBrowserRecordingStartResponseV1Schema = lazyZodSchema(() => z.strictObject({
    protocolVersion: z.literal(1),
    result: DaemonBrowserRecordingStartResultV1Schema,
  }));
export type DaemonBrowserRecordingStartResponseV1 = z.infer<
  typeof DaemonBrowserRecordingStartResponseV1Schema
>;

export const DaemonBrowserRecordingStopRequestV1Schema = lazyZodSchema(() => z.strictObject({
    protocolVersion: z.literal(1),
    machineId: IdSchema,
    recordingId: IdSchema,
    stoppedAtMs: z.optional(NonNegativeIntSchema),
    navigationGenerationEnd: NonNegativeIntSchema,
    expiresAtMs: z.optional(NonNegativeIntSchema),
  }));
export type DaemonBrowserRecordingStopRequestV1 = z.infer<
  typeof DaemonBrowserRecordingStopRequestV1Schema
>;

export const DaemonBrowserRecordingStopResponseV1Schema = lazyZodSchema(() => z.strictObject({
    protocolVersion: z.literal(1),
    result: DaemonBrowserRecordingStopResultV1Schema,
  }));
export type DaemonBrowserRecordingStopResponseV1 = z.infer<
  typeof DaemonBrowserRecordingStopResponseV1Schema
>;

export const DaemonBrowserRecordingCancelRequestV1Schema = lazyZodSchema(() => z.strictObject({
    protocolVersion: z.literal(1),
    machineId: IdSchema,
    recordingId: IdSchema,
    atMs: z.optional(NonNegativeIntSchema),
    reason: z.enum(['user_canceled', 'user_discarded', 'session_closed', 'logout']),
  }));
export type DaemonBrowserRecordingCancelRequestV1 = z.infer<
  typeof DaemonBrowserRecordingCancelRequestV1Schema
>;

export const DaemonBrowserRecordingCancelResponseV1Schema = lazyZodSchema(() => z.strictObject({
    protocolVersion: z.literal(1),
    result: DaemonBrowserRecordingTerminalResultV1Schema,
  }));
export type DaemonBrowserRecordingCancelResponseV1 = z.infer<
  typeof DaemonBrowserRecordingCancelResponseV1Schema
>;

export const DaemonBrowserRecordingStatusRequestV1Schema = lazyZodSchema(() => z.strictObject({
    protocolVersion: z.literal(1),
    machineId: IdSchema,
    recordingId: IdSchema,
  }));
export type DaemonBrowserRecordingStatusRequestV1 = z.infer<
  typeof DaemonBrowserRecordingStatusRequestV1Schema
>;

export const DaemonBrowserRecordingStatusResponseV1Schema = lazyZodSchema(() => z.strictObject({
    protocolVersion: z.literal(1),
    recording: z.nullable(BrowserRecordingSessionV1Schema),
  }));
export type DaemonBrowserRecordingStatusResponseV1 = z.infer<
  typeof DaemonBrowserRecordingStatusResponseV1Schema
>;

export const DaemonBrowserRecordingListRequestV1Schema = lazyZodSchema(() => z.strictObject({
    protocolVersion: z.literal(1),
    machineId: IdSchema,
    browserSessionId: IdSchema,
    viewId: IdSchema,
  }));
export type DaemonBrowserRecordingListRequestV1 = z.infer<
  typeof DaemonBrowserRecordingListRequestV1Schema
>;

export const DaemonBrowserRecordingListResponseV1Schema = lazyZodSchema(() => z.strictObject({
    protocolVersion: z.literal(1),
    recordings: z.array(BrowserRecordingSessionV1Schema),
  }));
export type DaemonBrowserRecordingListResponseV1 = z.infer<
  typeof DaemonBrowserRecordingListResponseV1Schema
>;

export const DaemonBrowserRecordingCleanupRequestV1Schema = lazyZodSchema(() => z.strictObject({
    protocolVersion: z.literal(1),
    machineId: IdSchema,
    nowMs: z.optional(NonNegativeIntSchema),
  }));
export type DaemonBrowserRecordingCleanupRequestV1 = z.infer<
  typeof DaemonBrowserRecordingCleanupRequestV1Schema
>;

export const DaemonBrowserRecordingCleanupResponseV1Schema = lazyZodSchema(() => z.strictObject({
    protocolVersion: z.literal(1),
    result: DaemonBrowserRecordingCleanupResultV1Schema,
  }));
export type DaemonBrowserRecordingCleanupResponseV1 = z.infer<
  typeof DaemonBrowserRecordingCleanupResponseV1Schema
>;
