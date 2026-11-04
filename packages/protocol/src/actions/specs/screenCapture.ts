import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { z } from 'zod/mini';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import { actionInputServerId } from './definition.js';
import { SessionImageMediaReferenceV1Schema } from '../../sessions/media/imageReferenceV1.js';

const identifier = z.string().check(z.trim(), z.minLength(1));
const capture = { captureRef: identifier };
export const ScreenCaptureSessionTargetSchema = z.strictObject({
  serverId: identifier, accountId: identifier, sessionId: identifier,
});
export const ScreenCaptureOpenInputSchema = z.strictObject({
  ...capture, targetSession: z.optional(ScreenCaptureSessionTargetSchema),
});
export const ScreenCaptureOpenResultSchema = z.strictObject({
  ...capture, status: z.literal('opened'),
  targetSession: z.optional(ScreenCaptureSessionTargetSchema),
  defaultReason: z.optional(z.enum(['lastCapturePick', 'focusedSession', 'lastUsed'])),
});
export const ScreenCaptureDeliveryInputSchema = z.strictObject({
  ...capture, session: ScreenCaptureSessionTargetSchema, note: z.optional(z.string()),
});
export const ScreenCaptureDiscardInputSchema = z.strictObject(capture);

const rect = z.strictObject({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
const nativeId = z.number().check(z.int(), z.minimum(0));
export const ScreenCaptureTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('window'), windowId: nativeId }),
  z.strictObject({ kind: z.literal('display'), displayId: nativeId }),
  z.strictObject({ kind: z.literal('rect'), displayId: nativeId, rect }),
  z.strictObject({ kind: z.literal('frontmost') }),
]);
export const ScreenCaptureStartInputSchema = z.strictObject({
  mode: z.enum(['screenshot', 'recording']), target: z.optional(ScreenCaptureTargetSchema),
  targetSession: z.optional(ScreenCaptureSessionTargetSchema),
});
export const ScreenCapturePermissionRequestInputSchema = z.strictObject({ subject: z.enum(['screen', 'window_text']) });
export const ScreenCaptureWindowTextInputSchema = z.strictObject(capture);
export const ScreenCaptureRecordingInputSchema = z.strictObject({ operationRef: nativeId });
const sourceTime = z.number().check(z.int(), z.minimum(0));
export const ScreenCaptureCopyInputSchema = z.union([
  z.strictObject({ ...capture, content: z.optional(z.literal('image')), frameAtMs: z.optional(sourceTime) }),
  z.strictObject({ ...capture, content: z.literal('windowText') }),
]);
export const ScreenCaptureRecordingEditInputSchema = z.strictObject({
  ...capture, operations: z.array(z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('trim.set'), startMs: sourceTime, endMs: sourceTime }),
    z.strictObject({ kind: z.literal('trim.reset') }),
    z.strictObject({ kind: z.literal('defaultPin.move'), sourceTimeMs: sourceTime }),
    z.strictObject({ kind: z.literal('pin.add'), sourceTimeMs: sourceTime }),
    z.strictObject({ kind: z.literal('pin.remove'), sourceTimeMs: sourceTime }),
    z.strictObject({ kind: z.literal('note.set'), id: identifier, sourceTimeMs: sourceTime, text: z.string() }),
    z.strictObject({ kind: z.literal('note.remove'), id: identifier }),
    z.strictObject({ kind: z.literal('includeVideo.set'), mode: z.enum(['auto', 'on', 'off']) }),
    z.strictObject({ kind: z.literal('windowText.set'), included: z.boolean() }),
    z.strictObject({ kind: z.literal('disclosure.warning'), include: z.boolean() }),
    z.strictObject({ kind: z.literal('disclosure.input') }),
    z.strictObject({ kind: z.literal('windowText.warning'), include: z.boolean() }),
    z.strictObject({ kind: z.literal('windowText.input') }),
  ])),
});
export const ScreenCaptureRecordingReadInputSchema = z.strictObject({ ...capture, frameAtMs: z.optional(sourceTime) });
const recordingMetadata = {
  ...capture, durationMs: sourceTime,
  trim: z.strictObject({ startMs: sourceTime, endMs: sourceTime }),
  pins: z.array(sourceTime),
  notes: z.array(z.strictObject({ id: identifier, sourceTimeMs: sourceTime, text: z.string() })),
  includeVideo: z.enum(['auto', 'on', 'off']), videoIncluded: z.boolean(), windowTextIncluded: z.boolean(),
  frames: z.array(z.strictObject({ sourceTimeMs: sourceTime, timeMs: sourceTime, hasMarks: z.boolean(), hasBlur: z.boolean() })),
};
const recordingMetadataSchema = z.strictObject(recordingMetadata);
const recordingReadSchema = z.strictObject({ ...recordingMetadata, frame: z.optional(z.strictObject({
  ...capture, sourceTimeMs: sourceTime, timeMs: z.number().check(z.int()), mimeType: z.literal('image/png'),
  width: z.number(), height: z.number(), byteSize: sourceTime, dataBase64: z.string(),
})) });
const source = z.nullable(z.strictObject({ appName: z.nullable(z.string()), windowTitle: z.nullable(z.string()), windowId: z.nullable(nativeId) }));
const pixelSize = z.strictObject({ width: z.number(), height: z.number() });
const result = z.strictObject({ ...capture, kind: z.enum(['still', 'video']), path: identifier,
  mimeType: identifier, byteSize: z.number(), pixelSize, scale: z.nullable(z.number()),
  origin: z.nullable(z.strictObject({ displayId: nativeId, rect })), source, windowTextRef: z.nullable(identifier),
});
const inventory = z.strictObject({
  displays: z.array(z.strictObject({ displayId: nativeId, frame: rect, scale: z.number(), desktopScale: z.number(),
    storageKey: z.nullable(z.string()), localizedName: z.nullable(z.string()), safeAreaTop: z.number(),
    physicalNotchSize: z.nullable(pixelSize) })),
  windows: z.array(z.strictObject({ windowId: nativeId, processId: nativeId, frame: rect,
    appName: z.nullable(z.string()), title: z.nullable(z.string()), zOrder: z.number() })),
});
const recording = z.strictObject({
  phase: z.enum(['preparing', 'recording', 'paused', 'finalizing', 'ready', 'failed']),
  timing: z.strictObject({ durationMs: z.number(), activeSinceMs: z.nullable(z.number()) }),
  sourceRef: z.nullable(identifier),
  result: z.nullable(result), error: z.nullable(identifier),
});
const snapshot = z.union([
  z.strictObject({ status: z.enum(['idle', 'cancelled']) }),
  z.strictObject({ status: z.literal('selecting'), operationRef: nativeId, mode: z.enum(['still', 'recording']), inventory }),
  z.strictObject({ status: z.literal('system_selection'), operationRef: nativeId, mode: z.enum(['still', 'recording']) }),
  z.strictObject({ status: z.literal('acquiring'), operationRef: nativeId }),
  z.strictObject({ status: z.literal('selected'), operationRef: nativeId, target: ScreenCaptureTargetSchema, inventory }),
  z.strictObject({ status: z.literal('recording'), operationRef: nativeId, recording }),
  z.strictObject({ status: z.literal('completed'), operationRef: nativeId, result, targetSession: z.optional(ScreenCaptureSessionTargetSchema) }),
  z.strictObject({ status: z.enum(['unavailable', 'failed']), reason: identifier }),
]);
const permissionState = z.enum(['granted', 'request_required', 'denied', 'restart_required', 'unknown', 'not_required', 'per_request', 'unavailable']);
const permissionRecoveryAction = z.enum(['reopen', 'open_settings']);
const permissions = z.strictObject({ screen: permissionState, windowText: permissionState,
  recoveryActions: z.strictObject({ screen: z.array(permissionRecoveryAction), windowText: z.array(permissionRecoveryAction) }),
});
const windowTextContext = { source, scope: z.optional(z.literal('whole_frontmost_window')) };

const common = {
  approval: { result: 'required' },
  safety: 'safe', sideEffectClass: 'write', requiredAuthority: 'account_automation',
  executionPlacement: 'client', placements: [],
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: false, rpc: false },
  toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
  // Notes and capture handles are transient device content, not approval observations.
  approvalInputCustody: 'live_only', projectObservationInput: () => ({}),
} as const;

const imageNumber = z.number().check(z.int(), z.minimum(1));
const deliverySummary = z.strictObject({ frameCount: imageNumber, durationMs: sourceTime, byteSize: sourceTime, includeVideo: z.boolean() });
const addedToDraft = z.strictObject({ ...capture, imageNumber, imageNumbers: z.optional(z.array(imageNumber)),
  summary: z.optional(deliverySummary), waiting: z.boolean() });
const sent = z.strictObject({ ...capture, messageRef: identifier, summary: z.optional(deliverySummary) });
const frameDisclosureSafetyForInput = (input: unknown): 'danger' | 'safe' =>
  input !== null && typeof input === 'object' && 'frameAtMs' in input && input.frameAtMs !== undefined ? 'danger' : 'safe';

function createScreenCaptureDeliveryActionSpecs() {
  return [
  {
    ...common, id: 'screenCapture.privacy.set',
    title: 'Hide private Sessions while sharing',
    description: 'Activate or end tag-based visual privacy on this client while sharing a screen. Does not start screen sharing or change another device.',
    surfaces: { ui: true, voice: false, agent: true, mcp: false, cli: false, rpc: false },
    approvalPolicy: { uiConfirmation: 'direct' },
    inputSchema: z.strictObject({ active: z.boolean() }),
    outputSchema: z.strictObject({ active: z.boolean() }),
    inputHints: { fields: [{ path: 'active', title: 'Hide selected Session tags', widget: 'boolean', required: true }] },
  },
  {
    ...common, id: 'screenCapture.open',
    title: 'Open a screen capture', description: 'Open a kept capture in the desktop Capture window.',
    approvalPolicy: { uiConfirmation: 'direct' },
    bindings: { mcpToolName: 'screen_capture_open' },
    inputSchema: ScreenCaptureOpenInputSchema,
    invocationServerIdForInput: actionInputServerId(ScreenCaptureOpenInputSchema, input => input.targetSession?.serverId),
    outputSchema: ScreenCaptureOpenResultSchema,
  },
  {
    ...common, id: 'screenCapture.addToDraft',
    clientPresenter: 'session',
    title: 'Add a screen capture to a draft', description: 'Append the prepared capture and note to the chosen Session’s draft. Uses the capture’s disclosure choices.',
    approvalPolicy: { agentDefault: 'egress', uiConfirmation: 'direct', requiredSurfaces: ['mcp'] },
    bindings: { mcpToolName: 'screen_capture_add_to_draft' },
    inputSchema: ScreenCaptureDeliveryInputSchema,
    invocationServerIdForInput: actionInputServerId(ScreenCaptureDeliveryInputSchema, input => input.session.serverId),
    outputSchema: addedToDraft,
  },
  {
    ...common, id: 'screenCapture.send',
    clientPresenter: 'session',
    title: 'Send a screen capture', description: 'Append the prepared capture and send the chosen Session’s whole draft. A settled failure retains the draft for Retry.',
    approvalPolicy: { agentDefault: 'egress', uiConfirmation: 'direct', requiredSurfaces: ['mcp'] },
    bindings: { mcpToolName: 'screen_capture_send' },
    inputSchema: ScreenCaptureDeliveryInputSchema,
    invocationServerIdForInput: actionInputServerId(ScreenCaptureDeliveryInputSchema, input => input.session.serverId),
    outputSchema: sent,
  },
  {
    ...common, id: 'screenCapture.copy',
    title: 'Copy a screen capture', description: 'Copy the prepared PNG with its current marks burned in, a recording frame at source time, or explicitly requested window text to the system clipboard.',
    approvalPolicy: { agentDefault: 'egress', uiConfirmation: 'direct', requiredSurfaces: ['mcp'] },
    safetyForInput: frameDisclosureSafetyForInput,
    bindings: { mcpToolName: 'screen_capture_copy' }, inputSchema: ScreenCaptureCopyInputSchema,
    outputSchema: z.strictObject({ ...capture, status: z.literal('copied') }),
  },
  {
    ...common, id: 'screenCapture.showInFolder',
    title: 'Show a screen capture in its folder', description: 'Reveal the already-kept capture in the desktop file browser.',
    approvalPolicy: { uiConfirmation: 'direct' },
    bindings: { mcpToolName: 'screen_capture_show_in_folder' }, inputSchema: ScreenCaptureDiscardInputSchema,
    outputSchema: z.strictObject({ ...capture, status: z.literal('revealed') }),
  },
  {
    ...common, id: 'screenCapture.discard',
    title: 'Discard a screen capture', description: 'Hide the Capture window and discard the capture through its reversible discard owner.',
    approvalPolicy: { uiConfirmation: 'direct' },
    bindings: { mcpToolName: 'screen_capture_discard' },
    inputSchema: ScreenCaptureDiscardInputSchema,
    outputSchema: z.strictObject({ ...capture, status: z.literal('discarded') }),
  },
] as const satisfies readonly PreNormalizedActionSpec[];
}

export const SCREEN_CAPTURE_DELIVERY_ACTION_SPECS: ReturnType<typeof createScreenCaptureDeliveryActionSpecs> = lazyActionSpecArray(createScreenCaptureDeliveryActionSpecs);

function createScreenCaptureNativeActionSpecs() {
  return [
  { ...common, id: 'screenCapture.start', title: 'Start a screen capture',
    description: 'Capture a screenshot or start recording on this desktop. An interactive agent request settles when the person Sends, Adds to draft or discards. A frontmost screenshot returns uploaded image media and any window text allowed by the capture’s disclosure record in the same admission.',
    approvalPolicy: { agentDefault: 'egress', uiConfirmation: 'direct', requiredSurfaces: ['mcp'] },
    bindings: { mcpToolName: 'screen_capture_start' }, inputSchema: ScreenCaptureStartInputSchema,
    invocationServerIdForInput: actionInputServerId(ScreenCaptureStartInputSchema, input => input.targetSession?.serverId),
    outputSchema: z.union([snapshot, addedToDraft, sent,
      z.strictObject({ ...capture, media: z.required(SessionImageMediaReferenceV1Schema, { file: true }),
        windowText: z.optional(z.strictObject({ text: z.string(), name: z.string() })) })]) },
  { ...common, id: 'screenCapture.recording.status', title: 'Read recording status',
    description: 'Read lifecycle, timing and completion facts for an admitted recording on this desktop.',
    sideEffectClass: 'read', approvalPolicy: { uiConfirmation: 'direct' },
    bindings: { mcpToolName: 'screen_capture_recording_status' }, inputSchema: ScreenCaptureRecordingInputSchema, outputSchema: recording },
  { ...common, id: 'screenCapture.recording.pause', title: 'Pause a recording',
    description: 'Pause the admitted recording without ending it.',
    approvalPolicy: { uiConfirmation: 'direct' },
    bindings: { mcpToolName: 'screen_capture_recording_pause' }, inputSchema: ScreenCaptureRecordingInputSchema, outputSchema: recording },
  { ...common, id: 'screenCapture.recording.resume', title: 'Resume a recording',
    description: 'Continue the same admitted recording after a pause.',
    approvalPolicy: { uiConfirmation: 'direct' },
    bindings: { mcpToolName: 'screen_capture_recording_resume' }, inputSchema: ScreenCaptureRecordingInputSchema, outputSchema: recording },
  { ...common, id: 'screenCapture.recording.stop', title: 'Stop a recording',
    description: 'Finalize the admitted recording and return its kept library result.',
    approvalPolicy: { uiConfirmation: 'direct' },
    bindings: { mcpToolName: 'screen_capture_recording_stop' }, inputSchema: ScreenCaptureRecordingInputSchema, outputSchema: recording },
  { ...common, id: 'screenCapture.recording.edit', title: 'Edit a recording',
    description: 'Commit source-time trim, pins, notes and inclusion choices. Frame marks use media.annotation; restoring disclosure after blur requires the person’s warning decision.',
    approvalPolicy: { uiConfirmation: 'direct' },
    bindings: { mcpToolName: 'screen_capture_recording_edit' }, inputSchema: ScreenCaptureRecordingEditInputSchema,
    outputSchema: recordingMetadataSchema },
  { ...common, id: 'screenCapture.recording.read', title: 'Read a recording',
    description: 'Read source-time edits and selected-moment metadata. An optional requested frame uses the current marks flattened into PNG and asks before returning its pixels to an agent.',
    sideEffectClass: 'read', approvalPolicy: { uiConfirmation: 'direct' },
    safetyForInput: frameDisclosureSafetyForInput,
    bindings: { mcpToolName: 'screen_capture_recording_read' }, inputSchema: ScreenCaptureRecordingReadInputSchema,
    outputSchema: recordingReadSchema },
  { ...common, id: 'screenCapture.targets.list', title: 'List screen capture targets',
    description: 'Read this desktop’s display and window descriptors, including private window titles, without pixels.',
    sideEffectClass: 'read', approvalPolicy: { agentDefault: 'egress', uiConfirmation: 'direct', requiredSurfaces: ['mcp'] },
    bindings: { mcpToolName: 'screen_capture_targets_list' }, inputSchema: z.strictObject({}), outputSchema: inventory },
  { ...common, id: 'screenCapture.permissions.read', title: 'Read screen capture permissions',
    description: 'Read the executing desktop app’s screen and window-text grant states.',
    sideEffectClass: 'read', approvalPolicy: { uiConfirmation: 'direct' },
    bindings: { mcpToolName: 'screen_capture_permissions_read' }, inputSchema: z.strictObject({}), outputSchema: permissions },
  { ...common, id: 'screenCapture.permissions.request', title: 'Request screen capture permission',
    description: 'Request the desktop app’s screen or window-text grant, opening its OS settings recovery when needed.',
    approvalPolicy: { agentDefault: 'authority', uiConfirmation: 'direct', requiredSurfaces: ['mcp'] },
    bindings: { mcpToolName: 'screen_capture_permissions_request' }, inputSchema: ScreenCapturePermissionRequestInputSchema,
    outputSchema: z.strictObject({ snapshot: permissions, recovery: z.enum(['none', 'open_settings', 'reopen']) }) },
  { ...common, id: 'screenCapture.windowText.read', title: 'Read capture window text',
    description: 'Read the active capture’s bound whole-window text outcome. Unavailable providers return an explicit reason.',
    sideEffectClass: 'read', approvalPolicy: { agentDefault: 'egress', uiConfirmation: 'direct', requiredSurfaces: ['mcp'] },
    bindings: { mcpToolName: 'screen_capture_window_text_read' }, inputSchema: ScreenCaptureWindowTextInputSchema,
    outputSchema: z.discriminatedUnion('status', [
      z.strictObject({ ...capture, status: z.literal('ready'), text: z.string(), ...windowTextContext }),
      z.strictObject({ ...capture, status: z.literal('empty'), ...windowTextContext }),
      z.strictObject({ ...capture, status: z.literal('partial'), text: z.string(),
        reason: z.enum(['permission_required', 'provider_unavailable', 'cancelled']), ...windowTextContext }),
      z.strictObject({ ...capture, status: z.literal('unavailable'),
        reason: z.enum(['no_window_context', 'permission_required', 'target_unavailable', 'ambiguous_target', 'provider_unavailable', 'cancelled']), ...windowTextContext }),
    ]) },
  { ...common, id: 'screenCapture.recent.list', title: 'List recent screen captures',
    description: 'Read local capture file metadata without reading image or video bodies or retaining a watcher.',
    sideEffectClass: 'read', approvalPolicy: { agentDefault: 'egress', uiConfirmation: 'direct', requiredSurfaces: ['mcp'] },
    bindings: { mcpToolName: 'screen_capture_recent_list' }, inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({ entries: z.array(z.strictObject({ path: identifier, name: z.string(), kind: z.enum(['still', 'video']),
      byteSize: z.number(), modifiedAt: z.nullable(z.number()), modifiedAtNanos: z.nullable(z.string()) })),
      folders: z.array(z.strictObject({ path: identifier, issue: z.nullable(z.enum(['missing', 'denied', 'read_failed', 'watch_unavailable'])) })) }) },
] as const satisfies readonly PreNormalizedActionSpec[];
}

export const SCREEN_CAPTURE_NATIVE_ACTION_SPECS: ReturnType<typeof createScreenCaptureNativeActionSpecs> = lazyActionSpecArray(createScreenCaptureNativeActionSpecs);
