import { z } from 'zod';

import { BrowserSemanticAdapterKindV1Schema } from '../adapters/kinds.js';
import { BrowserDiagnosticsEvalRequestV1Schema } from '../diagnostics/v1.js';
import { BrowserAutomationErrorCodeV1Schema } from './errors.js';
import { BrowserAutomationFidelityV1Schema } from './fidelity.js';
import { rejectUnsafeBrowserEgressKeys } from '../diagnostics/egress/keyRejection.js';
import {
  redactBrowserAutomationActionResultDetails,
  redactBrowserAutomationTimelineDetails,
} from './redaction.js';

export {
  BrowserAutomationErrorCodeV1Schema,
  type BrowserAutomationErrorCodeV1,
} from './errors.js';
export {
  BrowserAutomationFidelityV1Schema,
  type BrowserAutomationFidelityV1,
} from './fidelity.js';
export {
  redactBrowserAutomationActionResultDetails,
  redactBrowserAutomationTimelineDetails,
} from './redaction.js';

const IdSchema = z.string().trim().min(1).max(256);
const NonNegativeIntSchema = z.number().int().nonnegative();
const PositiveTimeoutMsSchema = z.number().int().positive().max(60_000);

export const BrowserAutomationReadOnlyActionKindV1Schema = z.enum([
  'getStatus',
  'snapshot',
  'semanticSnapshot',
  'queryElements',
  'getDiagnosticsSummary',
  'getActionTimeline',
  'waitFor',
]);
export type BrowserAutomationReadOnlyActionKindV1 = z.infer<
  typeof BrowserAutomationReadOnlyActionKindV1Schema
>;

export const BrowserAutomationMutatingActionKindV1Schema = z.enum([
  'navigate',
  'reload',
  'goBack',
  'goForward',
  'click',
  'tap',
  'type',
  'press',
  'scroll',
  'hover',
  'focus',
  'select',
  'setValue',
  'evaluate',
  'startElementPicker',
  'cancelElementPicker',
]);
export type BrowserAutomationMutatingActionKindV1 = z.infer<
  typeof BrowserAutomationMutatingActionKindV1Schema
>;

export const BrowserAutomationActionKindV1Schema = z.enum([
  ...BrowserAutomationReadOnlyActionKindV1Schema.options,
  ...BrowserAutomationMutatingActionKindV1Schema.options,
]);
export type BrowserAutomationActionKindV1 = z.infer<typeof BrowserAutomationActionKindV1Schema>;

export const BrowserAutomationAdapterCapabilityKindV1Schema = z.enum([
  'snapshot',
  'semanticSnapshot',
  'locatorQuery',
  'navigate',
  'click',
  'tap',
  'type',
  'press',
  'scroll',
  'hover',
  'waitFor',
  'evaluate',
  'elementPicker',
  'screenshotReference',
  'recording',
  'trustedInput',
  'crossOriginFrameAccess',
]);
export type BrowserAutomationAdapterCapabilityKindV1 = z.infer<
  typeof BrowserAutomationAdapterCapabilityKindV1Schema
>;

const MUTATING_ACTIONS = new Set<string>(BrowserAutomationMutatingActionKindV1Schema.options);

export function isBrowserAutomationMutatingActionKind(
  actionKind: BrowserAutomationActionKindV1,
): actionKind is BrowserAutomationMutatingActionKindV1 {
  return MUTATING_ACTIONS.has(actionKind);
}

const TimelineDetailsSchema = z
  .record(z.string(), z.unknown())
  .superRefine((details, context) => rejectUnsafeBrowserEgressKeys(details, context, {
    message: 'Browser automation timeline data must not contain inline screenshots, diagnostics bundles, bodies, payloads, cookies, tokens, or storage values.',
  }));

export const BrowserAutomationRequesterKindV1Schema = z.enum(['user', 'agent', 'plugin', 'system']);
export type BrowserAutomationRequesterKindV1 = z.infer<typeof BrowserAutomationRequesterKindV1Schema>;

export const BrowserAutomationRequesterRefV1Schema = z
  .object({
    kind: z.string().trim().min(1).max(64),
    id: IdSchema,
  })
  .strict();
export type BrowserAutomationRequesterRefV1 = z.infer<typeof BrowserAutomationRequesterRefV1Schema>;

export const BrowserAutomationControllerKindV1Schema = z.enum(['none', 'human', 'agent', 'system']);
export type BrowserAutomationControllerKindV1 = z.infer<typeof BrowserAutomationControllerKindV1Schema>;

export const BrowserAutomationActionRequestV1Schema = z
  .object({
    v: z.literal(1),
    automationRequestId: IdSchema,
    browserSessionId: IdSchema,
    viewId: IdSchema,
    navigationGeneration: NonNegativeIntSchema,
    requestedBy: BrowserAutomationRequesterKindV1Schema,
    requesterRef: BrowserAutomationRequesterRefV1Schema,
    actionKind: BrowserAutomationActionKindV1Schema,
    payload: z.record(z.string(), z.unknown()).optional().default({}),
    timeoutMs: PositiveTimeoutMsSchema,
    expectedControlEpoch: NonNegativeIntSchema.optional(),
    leaseId: IdSchema.optional(),
    idempotencyKey: IdSchema.optional(),
    expectedSyntheticInputWindowMs: z.number().int().nonnegative().max(5_000).optional().default(0),
  })
  .strict()
  .superRefine((request, context) => {
    if (isBrowserAutomationMutatingActionKind(request.actionKind) && !request.leaseId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['leaseId'],
        message: 'Mutating browser automation actions require an active action lease.',
      });
    }
    if (request.actionKind !== 'evaluate') return;

    const payload = request.payload;
    const evalRequest = payload.diagnosticsEvalRequest;
    const parsedEvalRequest = BrowserDiagnosticsEvalRequestV1Schema.safeParse(evalRequest);
    if (!parsedEvalRequest.success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payload', 'diagnosticsEvalRequest'],
        message: 'Browser automation eval actions must carry a BRW-10 diagnostics eval request.',
      });
      return;
    }
    if (parsedEvalRequest.data.viewId !== request.viewId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payload', 'diagnosticsEvalRequest', 'viewId'],
        message: 'Diagnostics eval request viewId must match the automation request viewId.',
      });
    }
    if (parsedEvalRequest.data.navigationGeneration !== request.navigationGeneration) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payload', 'diagnosticsEvalRequest', 'navigationGeneration'],
        message: 'Diagnostics eval request navigationGeneration must match the automation request generation.',
      });
    }
  });
export type BrowserAutomationActionRequestV1 = z.infer<typeof BrowserAutomationActionRequestV1Schema>;

export const BrowserAutomationActionStatusV1Schema = z.enum([
  'succeeded',
  'failed',
  'interrupted',
  'canceled',
  'timed_out',
  'stale',
  'policy_denied',
  'unsupported',
]);
export type BrowserAutomationActionStatusV1 = z.infer<typeof BrowserAutomationActionStatusV1Schema>;

export const BrowserAutomationActionResultV1Schema = z
  .object({
    v: z.literal(1),
    automationRequestId: IdSchema,
    status: BrowserAutomationActionStatusV1Schema,
    durationMs: NonNegativeIntSchema,
    adapterKind: BrowserSemanticAdapterKindV1Schema,
    fidelity: BrowserAutomationFidelityV1Schema,
    trustedInput: z.boolean(),
    navigationGenerationBefore: NonNegativeIntSchema,
    navigationGenerationAfter: NonNegativeIntSchema,
    controlEpochBefore: NonNegativeIntSchema,
    controlEpochAfter: NonNegativeIntSchema,
    errorCode: BrowserAutomationErrorCodeV1Schema.optional(),
    diagnostics: TimelineDetailsSchema.optional().default({}),
    resultSummary: TimelineDetailsSchema.optional().default({}),
  })
  .strict();
export type BrowserAutomationActionResultV1 = z.infer<typeof BrowserAutomationActionResultV1Schema>;

/**
 * Canceling is a command over the active automation set, not a result for one
 * request. Caller provenance remains host-stamped at the action admission
 * boundary, so this contract carries only the target browser view.
 */
export const BrowserAutomationCancelActiveInputV1Schema = z.object({
  browserSessionId: IdSchema,
  viewId: IdSchema,
}).strict();
export type BrowserAutomationCancelActiveInputV1 = z.infer<
  typeof BrowserAutomationCancelActiveInputV1Schema
>;

export const BrowserAutomationCancelActiveResultV1Schema = z.discriminatedUnion('outcome', [
  z.object({
    v: z.literal(1),
    outcome: z.literal('canceled'),
    canceledCount: z.number().int().positive(),
  }).strict(),
  z.object({
    v: z.literal(1),
    outcome: z.literal('no_active'),
    canceledCount: z.literal(0),
  }).strict(),
  z.object({
    v: z.literal(1),
    outcome: z.literal('owner_mismatch'),
    canceledCount: z.literal(0),
  }).strict(),
]);
export type BrowserAutomationCancelActiveResultV1 = z.infer<
  typeof BrowserAutomationCancelActiveResultV1Schema
>;

export const BrowserAutomationTimelineEntryV1Schema = z
  .object({
    v: z.literal(1),
    timelineEntryId: IdSchema,
    automationRequestId: IdSchema,
    browserSessionId: IdSchema,
    viewId: IdSchema,
    actionKind: BrowserAutomationActionKindV1Schema,
    requesterKind: BrowserAutomationRequesterKindV1Schema,
    status: BrowserAutomationActionStatusV1Schema,
    adapterKind: BrowserSemanticAdapterKindV1Schema,
    fidelity: BrowserAutomationFidelityV1Schema,
    trustedInput: z.boolean(),
    queuedAtMs: NonNegativeIntSchema,
    startedAtMs: NonNegativeIntSchema.optional(),
    finishedAtMs: NonNegativeIntSchema.optional(),
    durationMs: NonNegativeIntSchema.optional(),
    navigationGenerationBefore: NonNegativeIntSchema,
    navigationGenerationAfter: NonNegativeIntSchema,
    controlEpochBefore: NonNegativeIntSchema,
    controlEpochAfter: NonNegativeIntSchema,
    targetSummary: TimelineDetailsSchema.optional().default({}),
    resultSummary: TimelineDetailsSchema.optional().default({}),
    reasonCode: BrowserAutomationErrorCodeV1Schema.optional(),
  })
  .strict();
export type BrowserAutomationTimelineEntryV1 = z.infer<typeof BrowserAutomationTimelineEntryV1Schema>;

export const BrowserAutomationTimelineV1Schema = z
  .object({
    v: z.literal(1),
    browserSessionId: IdSchema,
    viewId: IdSchema,
    maxEntries: z.number().int().positive().max(500).optional().default(500),
    entries: z.array(BrowserAutomationTimelineEntryV1Schema).max(500),
  })
  .strict()
  .superRefine((timeline, context) => {
    if (timeline.entries.length > timeline.maxEntries) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['entries'],
        message: 'Browser automation timelines must not exceed maxEntries.',
      });
    }
  });
export type BrowserAutomationTimelineV1 = z.infer<typeof BrowserAutomationTimelineV1Schema>;

export const BrowserAutomationActionLeaseV1Schema = z
  .object({
    leaseId: IdSchema,
    browserSessionId: IdSchema,
    viewId: IdSchema,
    holder: BrowserAutomationRequesterKindV1Schema,
    requesterRef: BrowserAutomationRequesterRefV1Schema,
    acquiredAtMs: NonNegativeIntSchema,
    expiresAtMs: NonNegativeIntSchema,
    controlEpoch: NonNegativeIntSchema,
  })
  .strict();
export type BrowserAutomationActionLeaseV1 = z.infer<typeof BrowserAutomationActionLeaseV1Schema>;

export const BrowserAutomationControllerStateV1Schema = z
  .object({
    browserSessionId: IdSchema,
    viewId: IdSchema,
    controller: BrowserAutomationControllerKindV1Schema,
    controlEpoch: NonNegativeIntSchema,
    activeLease: BrowserAutomationActionLeaseV1Schema.optional(),
    activeAutomationRequestId: IdSchema.optional(),
  })
  .strict();
export type BrowserAutomationControllerStateV1 = z.infer<typeof BrowserAutomationControllerStateV1Schema>;

export const BrowserAutomationActionCapabilityV1Schema = z
  .object({
    available: z.boolean().optional().default(false),
    fidelity: BrowserAutomationFidelityV1Schema.optional().default('unavailable'),
    trustedInput: z.boolean().optional().default(false),
    disabledReasons: z.array(z.string().trim().min(1)).optional().default([]),
  })
  .strict();
export type BrowserAutomationActionCapabilityV1 = z.infer<typeof BrowserAutomationActionCapabilityV1Schema>;

const UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY: BrowserAutomationActionCapabilityV1 = {
  available: false,
  fidelity: 'unavailable',
  trustedInput: false,
  disabledReasons: [],
};

export const DEFAULT_BROWSER_AUTOMATION_ACTION_CAPABILITIES = {
  snapshot: UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY,
  semanticSnapshot: UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY,
  locatorQuery: UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY,
  navigate: UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY,
  click: UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY,
  tap: UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY,
  type: UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY,
  press: UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY,
  scroll: UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY,
  hover: UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY,
  waitFor: UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY,
  evaluate: UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY,
  elementPicker: UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY,
  screenshotReference: UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY,
  recording: UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY,
  trustedInput: UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY,
  crossOriginFrameAccess: UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY,
} satisfies Record<BrowserAutomationAdapterCapabilityKindV1, BrowserAutomationActionCapabilityV1>;

export const BrowserAutomationActionCapabilityMapV1Schema = z
  .object({
    snapshot: BrowserAutomationActionCapabilityV1Schema.optional().default(UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY),
    semanticSnapshot: BrowserAutomationActionCapabilityV1Schema.optional().default(
      UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY,
    ),
    locatorQuery: BrowserAutomationActionCapabilityV1Schema.optional().default(
      UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY,
    ),
    navigate: BrowserAutomationActionCapabilityV1Schema.optional().default(UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY),
    click: BrowserAutomationActionCapabilityV1Schema.optional().default(UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY),
    tap: BrowserAutomationActionCapabilityV1Schema.optional().default(UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY),
    type: BrowserAutomationActionCapabilityV1Schema.optional().default(UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY),
    press: BrowserAutomationActionCapabilityV1Schema.optional().default(UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY),
    scroll: BrowserAutomationActionCapabilityV1Schema.optional().default(UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY),
    hover: BrowserAutomationActionCapabilityV1Schema.optional().default(UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY),
    waitFor: BrowserAutomationActionCapabilityV1Schema.optional().default(UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY),
    evaluate: BrowserAutomationActionCapabilityV1Schema.optional().default(UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY),
    elementPicker: BrowserAutomationActionCapabilityV1Schema.optional().default(
      UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY,
    ),
    screenshotReference: BrowserAutomationActionCapabilityV1Schema.optional().default(
      UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY,
    ),
    recording: BrowserAutomationActionCapabilityV1Schema.optional().default(UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY),
    trustedInput: BrowserAutomationActionCapabilityV1Schema.optional().default(
      UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY,
    ),
    crossOriginFrameAccess: BrowserAutomationActionCapabilityV1Schema.optional().default(
      UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY,
    ),
  })
  .strict();
export type BrowserAutomationActionCapabilityMapV1 = z.infer<
  typeof BrowserAutomationActionCapabilityMapV1Schema
>;

export const BrowserInjectedRuntimeModuleV1Schema = z.enum([
  'diagnostics',
  'automation',
  'picker',
  'annotations',
]);
export type BrowserInjectedRuntimeModuleV1 = z.infer<typeof BrowserInjectedRuntimeModuleV1Schema>;

export const BrowserInjectedRuntimeCommandMessageV1Schema = z
  .object({
    v: z.literal(1),
    kind: z.literal('browser.injectedRuntime.command'),
    runtimeId: IdSchema,
    collectorId: IdSchema,
    nonce: IdSchema,
    browserSessionId: IdSchema,
    viewId: IdSchema,
    navigationGeneration: NonNegativeIntSchema,
    frameId: IdSchema.optional(),
    commandId: IdSchema,
    capabilityVersion: z.string().trim().min(1).max(64),
    module: BrowserInjectedRuntimeModuleV1Schema,
    commandName: z.string().trim().min(1).max(128),
    payload: z.record(z.string(), z.unknown()).optional().default({}),
  })
  .strict();
export type BrowserInjectedRuntimeCommandMessageV1 = z.infer<
  typeof BrowserInjectedRuntimeCommandMessageV1Schema
>;

export const BrowserInjectedRuntimeResultMessageV1Schema = z
  .object({
    v: z.literal(1),
    kind: z.literal('browser.injectedRuntime.result'),
    runtimeId: IdSchema,
    collectorId: IdSchema,
    nonce: IdSchema,
    browserSessionId: IdSchema,
    viewId: IdSchema,
    navigationGeneration: NonNegativeIntSchema,
    frameId: IdSchema.optional(),
    commandId: IdSchema,
    capabilityVersion: z.string().trim().min(1).max(64),
    module: BrowserInjectedRuntimeModuleV1Schema,
    ok: z.boolean(),
    fidelity: z.literal('injectedPage'),
    trusted: z.literal(false),
    stale: z.boolean().optional().default(false),
    durationMs: NonNegativeIntSchema,
    errorCode: BrowserAutomationErrorCodeV1Schema.optional(),
    data: TimelineDetailsSchema.optional().default({}),
  })
  .strict();
export type BrowserInjectedRuntimeResultMessageV1 = z.infer<
  typeof BrowserInjectedRuntimeResultMessageV1Schema
>;
