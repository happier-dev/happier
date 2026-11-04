import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

import { SessionImageMediaReferenceV1Schema } from '../sessions/media/imageReferenceV1.js';
import { BrowserActiveTargetV1Schema } from '../browser/events/activeTarget.js';
import { COMPUTER_CUA_DRIVER_INSTALLABLE_KEY } from '../installables/definitions/computerCuaDriver.js';
import { COMPUTER_AGENT_DESKTOP_INSTALLABLE_KEY } from '../installables/definitions/computerAgentDesktop.js';
import { MachineLiveStreamKeyModifierV1Schema } from '../machines/peer/mediation/stream/inputModifiersV1.js';

const IdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
const PositiveSafeIntSchema = lazyZodSchema(() => z.number().check(z.int(), z.positive()));
const CoordinateSchema = lazyZodSchema(() => z.number());
const DimensionSchema = lazyZodSchema(() => z.number().check(z.positive()));
/** Selection lifetime owner; Machine-person identity comes from authenticated host context. */
export type ComputerSourceIdentityV1 = Readonly<{ kind: 'session'; sessionId: string }>
  | Readonly<{ kind: 'machine-person'; personId: string }>;

export function computerSourceIdentityKeyV1(source: ComputerSourceIdentityV1): string {
  return JSON.stringify([source.kind, source.kind === 'session' ? source.sessionId : source.personId]);
}

export const ComputerProviderIdV1Schema = lazyZodSchema(() => z.enum(['cua', 'agent-desktop']));
export type ComputerProviderIdV1 = z.infer<typeof ComputerProviderIdV1Schema>;
export const COMPUTER_PROVIDER_INSTALLABLE_KEYS = Object.freeze({
  cua: COMPUTER_CUA_DRIVER_INSTALLABLE_KEY,
  'agent-desktop': COMPUTER_AGENT_DESKTOP_INSTALLABLE_KEY,
} satisfies Record<ComputerProviderIdV1, string>);
export const ComputerUseSettingsV1Schema = lazyZodSchema(() => z.strictObject({
  enabledProviders: z.array(ComputerProviderIdV1Schema).check(z.minLength(1)),
  defaultProvider: ComputerProviderIdV1Schema,
}).check(z.refine(value => value.enabledProviders.includes(value.defaultProvider), {
  message: 'The default computer-use provider must be enabled',
})));
export type ComputerUseSettingsV1 = Readonly<{
  enabledProviders: readonly ComputerProviderIdV1[];
  defaultProvider: ComputerProviderIdV1;
}>;
export const ComputerUseByMachineIdV1Schema = lazyZodSchema(() => z.record(IdSchema, ComputerUseSettingsV1Schema));
export const DEFAULT_COMPUTER_USE_SETTINGS_V1: Readonly<ComputerUseSettingsV1> = Object.freeze({
  enabledProviders: Object.freeze(['cua'] as const), defaultProvider: 'cua',
});
/** Machine preferences are Account-owned; installability is decided by the installable owner. */
export function readComputerUseSettingsForMachine(
  settings: Readonly<{ computerUseByMachineId: Readonly<Record<string, ComputerUseSettingsV1>> }>, machineId: string,
): Readonly<ComputerUseSettingsV1> {
  return Object.hasOwn(settings.computerUseByMachineId, machineId)
    ? settings.computerUseByMachineId[machineId] ?? DEFAULT_COMPUTER_USE_SETTINGS_V1 : DEFAULT_COMPUTER_USE_SETTINGS_V1;
}
export const ComputerAccessV1Schema = lazyZodSchema(() => z.enum(['see', 'use']));
export type ComputerAccessV1 = z.infer<typeof ComputerAccessV1Schema>;
/** Omitted selection access requests use; a human picker's initial choice is separate. */
export function resolveComputerAccess(access: ComputerAccessV1 | null | undefined): ComputerAccessV1 {
  return access ?? 'use';
}
const TargetLabelSchema = BrowserActiveTargetV1Schema.shape.label;

/** Placement is a Machine Action fact; target identity does not confer Session authority. */
export const ComputerTargetV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('window'), displayId: IdSchema, pid: PositiveSafeIntSchema, windowId: z.union([PositiveSafeIntSchema, IdSchema]) }),
  z.strictObject({ kind: z.literal('display'), displayId: IdSchema }),
]));
export type ComputerTargetV1 = z.infer<typeof ComputerTargetV1Schema>;

/** Exact native target identity shared by capture ownership and picker selection. */
export function computerTargetKeyV1(target: ComputerTargetV1): string {
  return JSON.stringify([target.displayId, target.kind, ...(target.kind === 'window' ? [target.pid, target.windowId] : [])]);
}

export const ComputerCaptureGeometryV1Schema = lazyZodSchema(() => z.strictObject({
  captureWidth: PositiveSafeIntSchema,
  captureHeight: PositiveSafeIntSchema,
  nativeWidth: PositiveSafeIntSchema,
  nativeHeight: PositiveSafeIntSchema,
  originX: CoordinateSchema,
  originY: CoordinateSchema,
  scaleX: DimensionSchema,
  scaleY: DimensionSchema,
  crop: z.strictObject({ x: CoordinateSchema, y: CoordinateSchema, width: DimensionSchema, height: DimensionSchema }),
}));
export type ComputerCaptureGeometryV1 = z.infer<typeof ComputerCaptureGeometryV1Schema>;

export const ComputerInputOperationV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('move'), x: CoordinateSchema, y: CoordinateSchema }),
  z.strictObject({ kind: z.literal('click'), x: CoordinateSchema, y: CoordinateSchema, button: z.optional(z.enum(['left', 'right', 'middle'])),
    clickCount: z.optional(z.literal(2)), modifiers: z.optional(z.array(MachineLiveStreamKeyModifierV1Schema)) }),
  z.strictObject({ kind: z.literal('press'), key: IdSchema, modifiers: z.optional(z.array(MachineLiveStreamKeyModifierV1Schema)) }),
  z.strictObject({ kind: z.literal('type'), text: z.string() }),
  z.strictObject({ kind: z.literal('drag'), fromX: CoordinateSchema, fromY: CoordinateSchema, toX: CoordinateSchema, toY: CoordinateSchema }),
  z.strictObject({ kind: z.literal('wheel'), x: CoordinateSchema, y: CoordinateSchema, deltaX: CoordinateSchema, deltaY: CoordinateSchema }),
  z.discriminatedUnion('action', [
    z.strictObject({ kind: z.literal('element'), elementId: IdSchema, action: z.literal('click') }),
    z.strictObject({ kind: z.literal('element'), elementId: IdSchema, action: z.literal('set_value'), value: z.string() }),
  ]),
]));
export type ComputerInputOperationV1 = z.infer<typeof ComputerInputOperationV1Schema>;

export const ComputerMachineRequestV1Schema = lazyZodSchema(() => z.strictObject({ machineId: IdSchema, provider: z.optional(ComputerProviderIdV1Schema) }));
export const ComputerTargetRequestV1Schema = lazyZodSchema(() => z.extend(ComputerMachineRequestV1Schema, { target: z.optional(ComputerTargetV1Schema), sourceId: z.optional(IdSchema) }));
export type ComputerTargetRequestV1 = z.infer<typeof ComputerTargetRequestV1Schema>;
export const ComputerTargetSelectRequestV1Schema = lazyZodSchema(() => z.extend(ComputerMachineRequestV1Schema, {
  target: z.optional(ComputerTargetV1Schema),
  access: z.optional(ComputerAccessV1Schema),
  /** A proposed window title or app hint, not host-resolved display metadata. */
  requestedTarget: z.optional(IdSchema),
}).check(z.refine(request => request.target !== undefined || request.requestedTarget !== undefined, {
  message: 'A native target or target suggestion is required',
})));
export type ComputerTargetSelectRequestV1 = z.infer<typeof ComputerTargetSelectRequestV1Schema>;
/** Without a display the machine lists its own (the daemon's desktop display); none means no screen to share. */
export const ComputerTargetsListRequestV1Schema = lazyZodSchema(() => z.extend(ComputerMachineRequestV1Schema, { displayId: z.optional(IdSchema) }));
export type ComputerTargetsListRequestV1 = z.infer<typeof ComputerTargetsListRequestV1Schema>;
export const ComputerInputRequestV1Schema = lazyZodSchema(() => z.extend(ComputerTargetRequestV1Schema, {
  captureId: IdSchema,
  operation: ComputerInputOperationV1Schema,
}));
export type ComputerInputRequestV1 = z.infer<typeof ComputerInputRequestV1Schema>;

export const ComputerClipboardOperationV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('read') }),
  z.strictObject({ kind: z.literal('write'), text: z.string() }),
]));
export type ComputerClipboardOperationV1 = z.infer<typeof ComputerClipboardOperationV1Schema>;
export const ComputerClipboardWriteRequestV1Schema = lazyZodSchema(() => z.extend(ComputerTargetRequestV1Schema, { text: z.string() }));
export const ComputerClipboardResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), text: z.optional(z.string()) }),
  z.strictObject({ ok: z.literal(false), code: IdSchema }),
]));
export type ComputerClipboardResultV1 = z.infer<typeof ComputerClipboardResultV1Schema>;

/** Public credential requests bind an observed field; values exist only in the private human continuation. */
export const SecretFillScopeV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: IdSchema,
  sessionId: IdSchema,
  machineId: IdSchema,
  purpose: IdSchema,
}));

export const ComputerSecretFillRequestV1Schema = lazyZodSchema(() => z.extend(SecretFillScopeV1Schema, {
  provider: z.optional(ComputerProviderIdV1Schema),
  sourceId: IdSchema,
  target: ComputerTargetV1Schema,
  captureId: IdSchema,
  geometry: ComputerCaptureGeometryV1Schema,
  field: z.strictObject({ fieldId: IdSchema, focusId: IdSchema }),
  submit: z.optional(z.strictObject({ controlId: IdSchema, label: IdSchema, consequence: IdSchema })),
}));
export type ComputerSecretFillRequestV1 = z.infer<typeof ComputerSecretFillRequestV1Schema>;

export const SecretFillRefusalCodeV1Schema = lazyZodSchema(() => z.enum([
  'saved_secret_missing', 'saved_secret_unavailable', 'saved_secret_forbidden',
  'saved_secret_repair_required', 'saved_secret_deleted', 'saved_secret_mode_incompatible',
  'saved_secret_corrupt', 'saved_secret_changed', 'target_changed', 'field_verification_unsupported',
  'observation_unavailable', 'approval_required', 'approval_changed', 'target_unavailable',
]));
export const SecretFillSettlementV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('filled'), code: z.literal('filled'),
    submit: z.optional(z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('submitted'), code: z.literal('submitted') }),
      z.strictObject({ status: z.literal('refused'), code: z.literal('submit_refused') }),
      z.strictObject({ status: z.literal('unknown'), code: z.literal('submit_unknown') }),
    ])),
  }),
  z.strictObject({ status: z.literal('refused'), code: SecretFillRefusalCodeV1Schema }),
  z.strictObject({ status: z.literal('canceled'), code: z.literal('canceled') }),
  z.strictObject({ status: z.literal('unknown'), code: z.literal('delivery_unknown') }),
]));
export type SecretFillSettlementV1 = z.infer<typeof SecretFillSettlementV1Schema>;

/** Computer-owner presentation facts; native target identities never belong in this shape. */
export const ComputerApprovalDisplayV1Schema = lazyZodSchema(() => z.strictObject({
  machineDisplayName: IdSchema,
  requiresTargetSelection: z.boolean(),
  appName: z.optional(IdSchema),
  access: z.optional(ComputerAccessV1Schema),
  target: z.optional(z.strictObject({ kind: z.enum(['window', 'display']), title: z.string() })),
  captureMedia: z.optional(z.required(SessionImageMediaReferenceV1Schema, { file: true })),
}));
export type ComputerApprovalDisplayV1 = z.infer<typeof ComputerApprovalDisplayV1Schema>;

export const ComputerSelectedTargetResponseV1Schema = lazyZodSchema(() => z.strictObject({
  provider: z.optional(ComputerProviderIdV1Schema),
  approvalDisplay: ComputerApprovalDisplayV1Schema,
  consentGranted: z.boolean(),
  access: z.optional(ComputerAccessV1Schema),
  selectedTarget: z.optional(ComputerTargetV1Schema),
  sourceId: z.optional(IdSchema),
}));
export type ComputerSelectedTargetResponseV1 = z.infer<typeof ComputerSelectedTargetResponseV1Schema>;

export const ComputerOpenSettingsRequestV1Schema = lazyZodSchema(() => z.extend(ComputerMachineRequestV1Schema, { permission: z.enum(['capture', 'input']) }));
export const ComputerOpenSettingsResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('dispatched') }),
  z.strictObject({ status: z.literal('failed'), code: IdSchema }),
]));

const IdentityShape = { target: ComputerTargetV1Schema, sourceId: IdSchema, provider: z.optional(ComputerProviderIdV1Schema) };
const InputPresentationShape = { ...IdentityShape, targetLabel: TargetLabelSchema };
const FailedResultSchema = lazyZodSchema(() => z.strictObject({ ...IdentityShape, status: z.literal('failed'), code: IdSchema }));
const TargetSelectionRequiredResultSchema = lazyZodSchema(() => z.strictObject({ status: z.literal('target_selection_required'),
  approvalDisplay: ComputerApprovalDisplayV1Schema }));

export const ComputerActionResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  TargetSelectionRequiredResultSchema,
  z.strictObject({ ...InputPresentationShape, status: z.literal('dispatched') }),
  z.strictObject({ ...InputPresentationShape, status: z.literal('verified'), property: IdSchema }),
  z.extend(FailedResultSchema, { targetLabel: TargetLabelSchema }),
  z.strictObject({ ...InputPresentationShape, status: z.literal('interrupted'), completion: z.enum(['known', 'unknown']) }),
]));
export type ComputerActionResultV1 = z.infer<typeof ComputerActionResultV1Schema>;

export const ComputerCaptureResponseV1Schema = lazyZodSchema(() => z.union([
  TargetSelectionRequiredResultSchema,
  z.strictObject({
    ...IdentityShape, status: z.literal('captured'), captureId: IdSchema,
    geometry: ComputerCaptureGeometryV1Schema,
    media: z.required(SessionImageMediaReferenceV1Schema, { file: true }),
  }),
  z.strictObject({
    ...IdentityShape, status: z.literal('captured'), captureId: IdSchema,
    geometry: ComputerCaptureGeometryV1Schema,
    /** Machine-person previews are ephemeral and never claim Session media custody. */
    frame: z.strictObject({ mimeType: z.literal('image/png'), base64: IdSchema }),
  }),
  FailedResultSchema,
]));
export type ComputerCaptureResponseV1 = z.infer<typeof ComputerCaptureResponseV1Schema>;

export const ComputerAccessibilityNodeV1Schema = lazyZodSchema(() => z.strictObject({
  id: IdSchema,
  role: IdSchema,
  name: z.optional(z.string()),
  value: z.optional(z.string()),
  bounds: z.optional(z.strictObject({ x: CoordinateSchema, y: CoordinateSchema, width: DimensionSchema, height: DimensionSchema })),
}));
export type ComputerAccessibilityNodeV1 = z.infer<typeof ComputerAccessibilityNodeV1Schema>;
export const ComputerQueryResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  TargetSelectionRequiredResultSchema,
  z.strictObject({ ...IdentityShape, status: z.literal('queried'), captureId: z.optional(IdSchema), accessibility: z.strictObject({
    status: z.enum(['complete', 'partial', 'unavailable']),
    reason: z.optional(IdSchema),
    nodes: z.array(ComputerAccessibilityNodeV1Schema),
  }) }),
  FailedResultSchema,
]));
export type ComputerQueryResponseV1 = z.infer<typeof ComputerQueryResponseV1Schema>;

export const ComputerGrantStatusV1Schema = lazyZodSchema(() => z.strictObject({
  capture: z.enum(['granted', 'denied', 'unknown']),
  input: z.enum(['granted', 'denied', 'unknown']),
}));
export type ComputerGrantStatusV1 = z.infer<typeof ComputerGrantStatusV1Schema>;

export const ComputerTargetsListResponseV1Schema = lazyZodSchema(() => z.strictObject({
  provider: z.optional(ComputerProviderIdV1Schema),
  targets: z.array(z.strictObject({ target: ComputerTargetV1Schema, title: z.optional(z.string()), appName: z.optional(IdSchema),
    label: z.optional(IdSchema), width: z.optional(PositiveSafeIntSchema), height: z.optional(PositiveSafeIntSchema),
    thumbnail: z.optional(z.strictObject({ mimeType: z.literal('image/png'), base64: IdSchema,
      width: PositiveSafeIntSchema, height: PositiveSafeIntSchema })),
  })),
  displays: z.optional(z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('available') }),
    z.strictObject({ status: z.literal('unavailable'), code: IdSchema }),
  ])),
  grants: ComputerGrantStatusV1Schema,
  settingsDeepLink: z.optional(z.string().check(z.url())),
}));
export type ComputerTargetsListResponseV1 = z.infer<typeof ComputerTargetsListResponseV1Schema>;

export const ComputerControlStatusResponseV1Schema = lazyZodSchema(() => z.strictObject({
  ...IdentityShape,
  controller: z.enum(['agent', 'human', 'idle']),
  controlEpoch: z.number().check(z.int(), z.nonnegative()),
  stopping: z.boolean(),
  uncertain: z.boolean(),
  /** A current native read, omitted by stream metadata and quarantined sources. */
  grants: z.optional(ComputerGrantStatusV1Schema),
  activity: z.optional(z.strictObject({ kind: z.enum(['capture', 'move', 'click', 'type', 'press', 'drag', 'wheel', 'element']), targetLabel: TargetLabelSchema })),
  activeTarget: z.optional(BrowserActiveTargetV1Schema),
}));
export type ComputerControlStatusResponseV1 = z.infer<typeof ComputerControlStatusResponseV1Schema>;

/**
 * The computer Actions a person performs from Happier (choose, look, stop, hand back, permission pane),
 * over the owner-scoped machine RPC. Agent input never takes this route: the person's own clicks and keys
 * travel as live-stream sideband controls, and agent Actions run through their Session's dispatch.
 */
export const COMPUTER_PRESENT_USER_ACTION_IDS = [
  'computer.targets.list',
  'computer.target.get',
  'computer.target.select',
  'computer.permissions.openSettings',
  'computer.capture',
  'computer.clipboard.read',
  'computer.clipboard.write',
  'computer.control.status',
  'computer.control.interrupt',
  'computer.control.handBack',
  'computer.target.close',
] as const;
export type ComputerPresentUserActionId = (typeof COMPUTER_PRESENT_USER_ACTION_IDS)[number];

export const DaemonComputerActionExecuteRequestV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: z.optional(IdSchema),
  actionId: z.enum(COMPUTER_PRESENT_USER_ACTION_IDS),
  /** Validated by the Action's own input schema at the daemon's computer owner. */
  input: z.unknown(),
}));
export type DaemonComputerActionExecuteRequestV1 = z.infer<typeof DaemonComputerActionExecuteRequestV1Schema>;

export const DaemonComputerActionExecuteResponseV1Schema = lazyZodSchema(() => z.strictObject({
  protocolVersion: z.literal(1),
  /** The Action's declared payload, or the owner's `{ ok: false, errorCode }` refusal envelope. */
  result: z.unknown(),
}));
export type DaemonComputerActionExecuteResponseV1 = z.infer<typeof DaemonComputerActionExecuteResponseV1Schema>;
