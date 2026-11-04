import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { BrowserActiveTargetV1Schema } from '../events/activeTarget.js';
import { SecretFillScopeV1Schema } from '../../computer/v1.js';
import {
  BrowserDialogInputEventV1Schema,
  BrowserDownloadInputEventV1Schema,
  BrowserFileChooserInputEventV1Schema,
  BrowserUploadFileV1Schema,
} from '../input/v1.js';

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

const IdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(256)));
const NonNegativeIntSchema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));
export const BROWSER_AUTOMATION_MAX_ACTION_TIMEOUT_MS = 60_000;
const PositiveTimeoutMsSchema = lazyZodSchema(() => z.number().check(z.int(), z.positive(), z.maximum(BROWSER_AUTOMATION_MAX_ACTION_TIMEOUT_MS)));

/** Exact observed browser field; never the generic automation payload/value bag. */
export const BrowserAutomationSecretFillRequestV1Schema = lazyZodSchema(() => z.extend(SecretFillScopeV1Schema, {
  browserSessionId: IdSchema,
  viewId: IdSchema,
  tabId: IdSchema,
  frameId: IdSchema,
  documentId: IdSchema,
  navigationGeneration: NonNegativeIntSchema,
  origin: z.string().check(z.url(), z.refine(value => {
    try {
      const url = new URL(value);
      return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
    } catch { return false; }
  }, { message: 'Credential entry requires an exact HTTP origin' })),
  field: z.strictObject({ fieldId: IdSchema, focusId: IdSchema, locator: IdSchema }),
  submit: z.optional(z.strictObject({ controlId: IdSchema, locator: IdSchema, label: IdSchema, consequence: IdSchema })),
}));
export type BrowserAutomationSecretFillRequestV1 = z.infer<typeof BrowserAutomationSecretFillRequestV1Schema>;

export const BrowserAutomationReadOnlyActionKindV1Schema = lazyZodSchema(() => z.enum([
  'getStatus',
  'snapshot',
  'semanticSnapshot',
  'queryElements',
  'getDiagnosticsSummary',
  'getActionTimeline',
  'waitFor',
  'clipboardRead',
  'download',
  'getInteractionState',
]));
export type BrowserAutomationReadOnlyActionKindV1 = z.infer<
  typeof BrowserAutomationReadOnlyActionKindV1Schema
>;

export const BrowserAutomationMutatingActionKindV1Schema = lazyZodSchema(() => z.enum([
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
  'upload',
  'clipboardWrite',
  'clipboardCut',
  'answerDialog',
  'drag',
  'evaluate',
  'startElementPicker',
  'cancelElementPicker',
]));
export type BrowserAutomationMutatingActionKindV1 = z.infer<
  typeof BrowserAutomationMutatingActionKindV1Schema
>;

export const BrowserAutomationActionKindV1Schema = lazyZodSchema(() => z.enum([
  ...BrowserAutomationReadOnlyActionKindV1Schema.options,
  ...BrowserAutomationMutatingActionKindV1Schema.options,
]));
export type BrowserAutomationActionKindV1 = z.infer<typeof BrowserAutomationActionKindV1Schema>;

export const BrowserAutomationAdapterCapabilityKindV1Schema = lazyZodSchema(() => z.enum([
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
  'upload',
  'drag',
  'waitFor',
  'evaluate',
  'elementPicker',
  'screenshotReference',
  'recording',
  'trustedInput',
  'crossOriginFrameAccess',
]));
export type BrowserAutomationAdapterCapabilityKindV1 = z.infer<
  typeof BrowserAutomationAdapterCapabilityKindV1Schema
>;

const MUTATING_ACTIONS = new Set<string>(BrowserAutomationMutatingActionKindV1Schema.options);

export function isBrowserAutomationMutatingActionKind(
  actionKind: BrowserAutomationActionKindV1,
): actionKind is BrowserAutomationMutatingActionKindV1 {
  return MUTATING_ACTIONS.has(actionKind);
}

const TimelineDetailsSchema = lazyZodSchema(() => z
  .record(z.string(), z.unknown()).check(z.superRefine((details, context) => rejectUnsafeBrowserEgressKeys(details, context, {
    message: 'Browser automation timeline data must not contain inline screenshots, diagnostics bundles, bodies, payloads, cookies, tokens, or storage values.',
  }))));

export const BrowserAutomationRequesterKindV1Schema = lazyZodSchema(() => z.enum(['user', 'agent', 'plugin', 'system']));
export type BrowserAutomationRequesterKindV1 = z.infer<typeof BrowserAutomationRequesterKindV1Schema>;

/** Action payloads cannot grant human input authority; only the host context can. */
export function resolveBrowserAutomationActionRequester(
  requestedBy: BrowserAutomationRequesterKindV1,
  authority: unknown,
): 'user' | 'agent' | null {
  if (authority === 'present_user') return 'user';
  return requestedBy === 'user' ? null : 'agent';
}

export const BrowserAutomationRequesterRefV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.string().check(z.trim(), z.minLength(1), z.maxLength(64)),
    id: IdSchema,
  }));
export type BrowserAutomationRequesterRefV1 = z.infer<typeof BrowserAutomationRequesterRefV1Schema>;

export const BrowserAutomationControllerKindV1Schema = lazyZodSchema(() => z.enum(['none', 'human', 'agent', 'system']));
export type BrowserAutomationControllerKindV1 = z.infer<typeof BrowserAutomationControllerKindV1Schema>;

export const BrowserAutomationJavaScriptDialogKindV1Schema = lazyZodSchema(() => z.enum(['alert', 'confirm', 'prompt']));
export type BrowserAutomationJavaScriptDialogKindV1 = z.infer<
  typeof BrowserAutomationJavaScriptDialogKindV1Schema
>;

/** One exact page question answered within the containing approved Action; otherwise dismiss. */
export const BrowserAutomationJavaScriptDialogResponseV1Schema = lazyZodSchema(() => z.strictObject({
  kind: BrowserAutomationJavaScriptDialogKindV1Schema,
  message: z.string(),
  accept: z.boolean(),
  promptText: z.optional(z.string()),
}).check(z.refine(response => response.promptText === undefined || response.kind === 'prompt' && response.accept,
  { message: 'Prompt text is only valid when accepting a prompt' })));
export type BrowserAutomationJavaScriptDialogResponseV1 = z.infer<typeof BrowserAutomationJavaScriptDialogResponseV1Schema>;

// These new payloads share the human-input operands; legacy automation payloads keep their
// established shapes. Executable operands remain closed at the request admission boundary.
const interactionPayloadSchemas: Readonly<Partial<Record<BrowserAutomationActionKindV1, z.ZodMiniType>>> = {
  clipboardRead: z.strictObject({}),
  clipboardCut: z.strictObject({}),
  clipboardWrite: z.strictObject({ text: z.string() }),
  answerDialog: z.omit(BrowserDialogInputEventV1Schema, { kind: true, target: true, sequence: true }),
  download: z.omit(BrowserDownloadInputEventV1Schema, { kind: true, target: true, sequence: true }),
  getInteractionState: z.strictObject({}),
};
const chooserUploadPayloadSchema = z.omit(BrowserFileChooserInputEventV1Schema, {
  kind: true, target: true, sequence: true,
});

export function browserAutomationInteractionPayloadSchema(actionKind: BrowserAutomationActionKindV1, payload: Readonly<Record<string, unknown>>) {
  return actionKind === 'upload' && 'chooserId' in payload ? chooserUploadPayloadSchema : interactionPayloadSchemas[actionKind];
}

export const BrowserAutomationActionRequestV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    automationRequestId: IdSchema,
    browserSessionId: IdSchema,
    viewId: IdSchema,
    navigationGeneration: NonNegativeIntSchema,
    requestedBy: BrowserAutomationRequesterKindV1Schema,
    requesterRef: BrowserAutomationRequesterRefV1Schema,
    actionKind: BrowserAutomationActionKindV1Schema,
    payload: z._default(z.optional(z.record(z.string(), z.unknown())), {}),
    dialogResponse: z.optional(BrowserAutomationJavaScriptDialogResponseV1Schema),
    timeoutMs: PositiveTimeoutMsSchema,
  }).check(z.superRefine((request, context) => {
    const payloadSchema = browserAutomationInteractionPayloadSchema(request.actionKind, request.payload);
    if (payloadSchema) {
      const parsed = payloadSchema.safeParse(request.payload);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          context.addIssue({ code: 'custom', path: ['payload', ...issue.path], message: issue.message });
        }
      }
    }
    if (request.dialogResponse && !isBrowserAutomationMutatingActionKind(request.actionKind)) {
      context.addIssue({ code: 'custom', path: ['dialogResponse'], message: 'Dialog responses require a mutating Browser Action' });
    }
    if (request.actionKind !== 'evaluate') return;

    const payload = request.payload;
    const evalRequest = payload.diagnosticsEvalRequest;
    const parsedEvalRequest = BrowserDiagnosticsEvalRequestV1Schema.safeParse(evalRequest);
    if (!parsedEvalRequest.success) {
      context.addIssue({
        code: "custom",
        path: ['payload', 'diagnosticsEvalRequest'],
        message: 'Browser automation eval actions must carry a BRW-10 diagnostics eval request.',
      });
      return;
    }
    if (parsedEvalRequest.data.viewId !== request.viewId) {
      context.addIssue({
        code: "custom",
        path: ['payload', 'diagnosticsEvalRequest', 'viewId'],
        message: 'Diagnostics eval request viewId must match the automation request viewId.',
      });
    }
    if (parsedEvalRequest.data.navigationGeneration !== request.navigationGeneration) {
      context.addIssue({
        code: "custom",
        path: ['payload', 'diagnosticsEvalRequest', 'navigationGeneration'],
        message: 'Diagnostics eval request navigationGeneration must match the automation request generation.',
      });
    }
  })));
export type BrowserAutomationActionRequestV1 = z.infer<typeof BrowserAutomationActionRequestV1Schema>;

export const BrowserAutomationActionStatusV1Schema = lazyZodSchema(() => z.enum([
  'succeeded',
  'failed',
  'interrupted',
  'canceled',
  'timed_out',
  'stale',
  'policy_denied',
  'unsupported',
]));
export type BrowserAutomationActionStatusV1 = z.infer<typeof BrowserAutomationActionStatusV1Schema>;

/**
 * Managed Chromium dismisses page dialogs by default. An approved Action may answer one matching
 * kind/message via dialogResponse. Observations are untrusted page content and pass through the
 * existing result/timeline redactor; prompt defaults and submitted answers are never reported.
 * Responses share the containing Action's deadline; no pending-dialog registry is needed.
 */
const ObservedJavaScriptDialogKindSchema = lazyZodSchema(() => z.enum([
  ...BrowserAutomationJavaScriptDialogKindV1Schema.options, 'beforeunload', 'unknown',
]));

export const BrowserAutomationJavaScriptDialogSummaryV1Schema = lazyZodSchema(() => z.strictObject({
    count: z.number().check(z.int(), z.positive()),
    kinds: z.array(ObservedJavaScriptDialogKindSchema).check(z.minLength(1), z.maxLength(ObservedJavaScriptDialogKindSchema.options.length)),
    handling: z.enum(['dismissed', 'accepted', 'mixed']),
    dialogs: z.optional(z.array(z.strictObject({
      kind: ObservedJavaScriptDialogKindSchema,
      message: z.string(),
      handling: z.enum(['dismissed', 'accepted']),
    }))),
  }));
export type BrowserAutomationJavaScriptDialogSummaryV1 = z.infer<
  typeof BrowserAutomationJavaScriptDialogSummaryV1Schema
>;

/** Explicitly approved content reads; never copied into timeline/diagnostic summaries. */
export const BrowserInteractionResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('clipboard'), text: z.string() }),
  z.strictObject({
    kind: z.literal('download'),
    downloadId: BrowserDownloadInputEventV1Schema.shape.downloadId,
    name: z.string(),
    offset: BrowserDownloadInputEventV1Schema.shape.offset,
    dataBase64: BrowserUploadFileV1Schema.shape.dataBase64,
    eof: z.boolean(),
  }),
]));
export type BrowserInteractionResultV1 = z.infer<typeof BrowserInteractionResultV1Schema>;

export const BrowserAutomationActionResultV1Schema = lazyZodSchema(() => z.strictObject({
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
    errorCode: z.optional(BrowserAutomationErrorCodeV1Schema),
    diagnostics: z._default(z.optional(TimelineDetailsSchema), {}),
    resultSummary: z._default(z.optional(TimelineDetailsSchema), {}),
    interactionResult: z.optional(BrowserInteractionResultV1Schema),
  }));
export type BrowserAutomationActionResultV1 = z.infer<typeof BrowserAutomationActionResultV1Schema>;

/** An issued effect lost its acknowledgement; engine result metadata is not known. */
export const BrowserAutomationInterruptedResultV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  status: z.literal('interrupted'),
  completion: z.literal('unknown'),
  automationRequestId: z.optional(IdSchema),
}));

/**
 * Canceling is a command over the active automation set, not a result for one
 * request. Caller provenance remains host-stamped at the action admission
 * boundary, so this contract carries only the target browser view.
 */
export const BrowserAutomationCancelActiveInputV1Schema = lazyZodSchema(() => z.strictObject({
  browserSessionId: IdSchema,
  viewId: IdSchema,
}));
export type BrowserAutomationCancelActiveInputV1 = z.infer<
  typeof BrowserAutomationCancelActiveInputV1Schema
>;

export const BrowserAutomationCancelActiveResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('outcome', [
  z.strictObject({
    v: z.literal(1),
    outcome: z.literal('canceled'),
    canceledCount: z.number().check(z.int(), z.positive()),
    // Cancel acknowledgement reports drain certainty, never rollback of dispatched effects.
    completion: z._default(z.enum(['stopped', 'uncertain']), 'uncertain'),
  }),
  z.strictObject({
    v: z.literal(1),
    outcome: z.literal('no_active'),
    canceledCount: z.literal(0),
  }),
  z.strictObject({
    v: z.literal(1),
    outcome: z.literal('owner_mismatch'),
    canceledCount: z.literal(0),
  }),
]));
export type BrowserAutomationCancelActiveResultV1 = z.infer<
  typeof BrowserAutomationCancelActiveResultV1Schema
>;

export const BrowserAutomationTimelineEntryV1Schema = lazyZodSchema(() => z.strictObject({
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
    startedAtMs: z.optional(NonNegativeIntSchema),
    finishedAtMs: z.optional(NonNegativeIntSchema),
    durationMs: z.optional(NonNegativeIntSchema),
    navigationGenerationBefore: NonNegativeIntSchema,
    navigationGenerationAfter: NonNegativeIntSchema,
    controlEpochBefore: NonNegativeIntSchema,
    controlEpochAfter: NonNegativeIntSchema,
    targetSummary: z._default(z.optional(TimelineDetailsSchema), {}),
    resultSummary: z._default(z.optional(TimelineDetailsSchema), {}),
    reasonCode: z.optional(BrowserAutomationErrorCodeV1Schema),
  }));
export type BrowserAutomationTimelineEntryV1 = z.infer<typeof BrowserAutomationTimelineEntryV1Schema>;

export const BrowserAutomationTimelineV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    browserSessionId: IdSchema,
    viewId: IdSchema,
    maxEntries: z._default(z.optional(z.number().check(z.int(), z.positive(), z.maximum(500))), 500),
    entries: z.array(BrowserAutomationTimelineEntryV1Schema).check(z.maxLength(500)),
  }).check(z.superRefine((timeline, context) => {
    if (timeline.entries.length > timeline.maxEntries) {
      context.addIssue({
        code: "custom",
        path: ['entries'],
        message: 'Browser automation timelines must not exceed maxEntries.',
      });
    }
  })));
export type BrowserAutomationTimelineV1 = z.infer<typeof BrowserAutomationTimelineV1Schema>;

/**
 * Who currently drives a browser view, and the epoch that a human takeover bumps.
 *
 * `activeAutomationRequestId` is the single-flight fact: at most one mutating automation action
 * runs per view, and its presence is what `controller: 'agent'` means. There is deliberately no
 * lease here — an action lease existed until 2026-08-23 with no minting path, which made every
 * mutating verb undispatchable. Concurrency is single-flight, consent is the action-approval
 * danger floor, and human takeover is the human-input cancel path.
 */
export const BrowserAutomationControllerStateV1Schema = lazyZodSchema(() => z.strictObject({
    browserSessionId: IdSchema,
    viewId: IdSchema,
    controller: BrowserAutomationControllerKindV1Schema,
    controlEpoch: NonNegativeIntSchema,
    activeAutomationRequestId: z.optional(IdSchema),
    activeActionKind: z.optional(BrowserAutomationActionKindV1Schema),
    activeTarget: z.optional(BrowserActiveTargetV1Schema),
    interruptionSettling: z.optional(z.boolean()),
    uncertain: z.optional(z.boolean()),
    /** Advisory privacy projection; only the source/input owner can release its observation hold. */
    confidentialityHeld: z.optional(z.boolean()),
  }));
export type BrowserAutomationControllerStateV1 = z.infer<typeof BrowserAutomationControllerStateV1Schema>;

export const BrowserAutomationActionCapabilityV1Schema = lazyZodSchema(() => z.strictObject({
    available: z._default(z.optional(z.boolean()), false),
    fidelity: z._default(z.optional(BrowserAutomationFidelityV1Schema), 'unavailable'),
    trustedInput: z._default(z.optional(z.boolean()), false),
    disabledReasons: z._default(z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))), []),
  }));
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
  upload: UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY,
  drag: UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY,
  waitFor: UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY,
  evaluate: UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY,
  elementPicker: UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY,
  screenshotReference: UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY,
  recording: UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY,
  trustedInput: UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY,
  crossOriginFrameAccess: UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY,
} satisfies Record<BrowserAutomationAdapterCapabilityKindV1, BrowserAutomationActionCapabilityV1>;

export const BrowserAutomationActionCapabilityMapV1Schema = lazyZodSchema(() => z.strictObject({
    snapshot: z._default(z.optional(BrowserAutomationActionCapabilityV1Schema), UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY),
    semanticSnapshot: z._default(z.optional(BrowserAutomationActionCapabilityV1Schema), UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY),
    locatorQuery: z._default(z.optional(BrowserAutomationActionCapabilityV1Schema), UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY),
    navigate: z._default(z.optional(BrowserAutomationActionCapabilityV1Schema), UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY),
    click: z._default(z.optional(BrowserAutomationActionCapabilityV1Schema), UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY),
    tap: z._default(z.optional(BrowserAutomationActionCapabilityV1Schema), UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY),
    type: z._default(z.optional(BrowserAutomationActionCapabilityV1Schema), UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY),
    press: z._default(z.optional(BrowserAutomationActionCapabilityV1Schema), UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY),
    scroll: z._default(z.optional(BrowserAutomationActionCapabilityV1Schema), UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY),
    hover: z._default(z.optional(BrowserAutomationActionCapabilityV1Schema), UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY),
    upload: z._default(z.optional(BrowserAutomationActionCapabilityV1Schema), UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY),
    drag: z._default(z.optional(BrowserAutomationActionCapabilityV1Schema), UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY),
    waitFor: z._default(z.optional(BrowserAutomationActionCapabilityV1Schema), UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY),
    evaluate: z._default(z.optional(BrowserAutomationActionCapabilityV1Schema), UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY),
    elementPicker: z._default(z.optional(BrowserAutomationActionCapabilityV1Schema), UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY),
    screenshotReference: z._default(z.optional(BrowserAutomationActionCapabilityV1Schema), UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY),
    recording: z._default(z.optional(BrowserAutomationActionCapabilityV1Schema), UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY),
    trustedInput: z._default(z.optional(BrowserAutomationActionCapabilityV1Schema), UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY),
    crossOriginFrameAccess: z._default(z.optional(BrowserAutomationActionCapabilityV1Schema), UNAVAILABLE_AUTOMATION_ACTION_CAPABILITY),
  }));
export type BrowserAutomationActionCapabilityMapV1 = z.infer<
  typeof BrowserAutomationActionCapabilityMapV1Schema
>;

export const BrowserInjectedRuntimeModuleV1Schema = lazyZodSchema(() => z.enum([
  'diagnostics',
  'automation',
  'picker',
  'annotations',
]));
export type BrowserInjectedRuntimeModuleV1 = z.infer<typeof BrowserInjectedRuntimeModuleV1Schema>;

export const BrowserInjectedRuntimeCommandMessageV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    kind: z.literal('browser.injectedRuntime.command'),
    runtimeId: IdSchema,
    collectorId: IdSchema,
    nonce: IdSchema,
    browserSessionId: IdSchema,
    viewId: IdSchema,
    navigationGeneration: NonNegativeIntSchema,
    frameId: z.optional(IdSchema),
    commandId: IdSchema,
    capabilityVersion: z.string().check(z.trim(), z.minLength(1), z.maxLength(64)),
    module: BrowserInjectedRuntimeModuleV1Schema,
    commandName: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
    payload: z._default(z.optional(z.record(z.string(), z.unknown())), {}),
  }));
export type BrowserInjectedRuntimeCommandMessageV1 = z.infer<
  typeof BrowserInjectedRuntimeCommandMessageV1Schema
>;

export const BrowserInjectedRuntimeResultMessageV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    kind: z.literal('browser.injectedRuntime.result'),
    phase: z.optional(z.enum(['target', 'complete'])),
    activeTarget: z.optional(BrowserActiveTargetV1Schema),
    runtimeId: IdSchema,
    collectorId: IdSchema,
    nonce: IdSchema,
    browserSessionId: IdSchema,
    viewId: IdSchema,
    navigationGeneration: NonNegativeIntSchema,
    frameId: z.optional(IdSchema),
    commandId: IdSchema,
    capabilityVersion: z.string().check(z.trim(), z.minLength(1), z.maxLength(64)),
    module: BrowserInjectedRuntimeModuleV1Schema,
    ok: z.boolean(),
    fidelity: z.literal('injectedPage'),
    trusted: z.literal(false),
    stale: z._default(z.optional(z.boolean()), false),
    durationMs: NonNegativeIntSchema,
    errorCode: z.optional(BrowserAutomationErrorCodeV1Schema),
    data: z._default(z.optional(TimelineDetailsSchema), {}),
  }));
export type BrowserInjectedRuntimeResultMessageV1 = z.infer<
  typeof BrowserInjectedRuntimeResultMessageV1Schema
>;
