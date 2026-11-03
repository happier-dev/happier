import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { MachineLiveStreamCaptureSourceV1Schema } from '../../machines/peer/mediation/stream/captureV1.js';

import { BrowserSemanticAdapterKindV1Schema } from '../adapters/kinds.js';
import { BrowserEventV1Schema } from '../events/v1.js';
import { BrowserViewTargetV1Schema } from '../target/v1.js';
import { BrowserHttpUrlV1Schema } from '../url.js';
import { BrowserPlatformV1Schema } from '../view/v1.js';
import { BrowserViewportEmulationV1Schema } from '../input/v1.js';
export { BROWSER_VIEWPORT_PRESETS, BrowserViewportEmulationV1Schema, BrowserViewportPresetIdV1Schema } from '../input/v1.js';
export type { BrowserViewportEmulationV1, BrowserViewportPresetIdV1 } from '../input/v1.js';

const BrowserCommandBaseV1Schema = lazyZodSchema(() => z.strictObject({
    commandId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  }));

const BrowserSessionCommandBaseV1Schema = lazyZodSchema(() => z.extend(BrowserCommandBaseV1Schema, {
  browserSessionId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
}));

const BrowserViewCommandBaseV1Schema = lazyZodSchema(() => z.extend(BrowserSessionCommandBaseV1Schema, {
  viewId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
}));

export const BrowserCommandKindV1Schema = lazyZodSchema(() => z.enum([
  'openView',
  'closeView',
  'focusView',
  'navigate',
  'goBack',
  'goForward',
  'reload',
  'stop',
  'setTarget',
  'takeControl',
  'handBack',
  'setViewport',
]));
export type BrowserCommandKindV1 = z.infer<typeof BrowserCommandKindV1Schema>;

export const BrowserOpenViewCommandV1Schema = lazyZodSchema(() => z.extend(BrowserViewCommandBaseV1Schema, {
  kind: z.literal('openView'),
  target: BrowserViewTargetV1Schema,
  platform: BrowserPlatformV1Schema,
  currentUrl: z.optional(BrowserHttpUrlV1Schema),
  currentUrlExpiresAt: z.optional(z.number().check(z.int(), z.nonnegative())),
  focus: z._default(z.optional(z.boolean()), true),
  openerViewId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
}));

export const BrowserCloseViewCommandV1Schema = lazyZodSchema(() => z.extend(BrowserViewCommandBaseV1Schema, {
  kind: z.literal('closeView'),
}));

export const BrowserFocusViewCommandV1Schema = lazyZodSchema(() => z.extend(BrowserViewCommandBaseV1Schema, {
  kind: z.literal('focusView'),
}));

export const BrowserNavigateCommandV1Schema = lazyZodSchema(() => z.extend(BrowserViewCommandBaseV1Schema, {
  kind: z.literal('navigate'),
  url: BrowserHttpUrlV1Schema,
}));

export const BrowserGoBackCommandV1Schema = lazyZodSchema(() => z.extend(BrowserViewCommandBaseV1Schema, {
  kind: z.literal('goBack'),
}));

export const BrowserGoForwardCommandV1Schema = lazyZodSchema(() => z.extend(BrowserViewCommandBaseV1Schema, {
  kind: z.literal('goForward'),
}));

export const BrowserReloadCommandV1Schema = lazyZodSchema(() => z.extend(BrowserViewCommandBaseV1Schema, {
  kind: z.literal('reload'),
}));

export const BrowserStopCommandV1Schema = lazyZodSchema(() => z.extend(BrowserViewCommandBaseV1Schema, {
  kind: z.literal('stop'),
}));

export const BrowserSetTargetCommandV1Schema = lazyZodSchema(() => z.extend(BrowserViewCommandBaseV1Schema, {
  kind: z.literal('setTarget'),
  target: BrowserViewTargetV1Schema,
  currentUrl: z.optional(BrowserHttpUrlV1Schema),
}));

export const BrowserTakeControlCommandV1Schema = lazyZodSchema(() => z.extend(BrowserViewCommandBaseV1Schema, { kind: z.literal('takeControl') }));
export const BrowserHandBackCommandV1Schema = lazyZodSchema(() => z.extend(BrowserViewCommandBaseV1Schema, { kind: z.literal('handBack') }));

export const BrowserSetViewportCommandV1Schema = lazyZodSchema(() => z.extend(BrowserViewCommandBaseV1Schema, {
  kind: z.literal('setViewport'), emulation: BrowserViewportEmulationV1Schema,
}));

export const BrowserCommandV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  BrowserOpenViewCommandV1Schema,
  BrowserCloseViewCommandV1Schema,
  BrowserFocusViewCommandV1Schema,
  BrowserNavigateCommandV1Schema,
  BrowserGoBackCommandV1Schema,
  BrowserGoForwardCommandV1Schema,
  BrowserReloadCommandV1Schema,
  BrowserStopCommandV1Schema,
  BrowserSetTargetCommandV1Schema,
  BrowserTakeControlCommandV1Schema,
  BrowserHandBackCommandV1Schema,
  BrowserSetViewportCommandV1Schema,
]));
export type BrowserCommandV1 = z.infer<typeof BrowserCommandV1Schema>;

export const BrowserCommandErrorCodeV1Schema = lazyZodSchema(() => z.enum([
  'adapter_unavailable',
  'sandbox_unavailable',
  'command_malformed',
  'feature_disabled',
  'permission_denied',
  'policy_unavailable',
  'waiting_for_memory',
  'session_not_found',
  'unsupported_command',
  'view_not_found',
]));
export type BrowserCommandErrorCodeV1 = z.infer<typeof BrowserCommandErrorCodeV1Schema>;

export const BrowserCommandDispatchErrorV1Schema = lazyZodSchema(() => z.strictObject({
    code: BrowserCommandErrorCodeV1Schema,
    message: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
    retryable: z.optional(z.boolean()),
  }));
export type BrowserCommandDispatchErrorV1 = z.infer<typeof BrowserCommandDispatchErrorV1Schema>;

export const BrowserCommandDispatchResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({
      v: z.literal(1),
      commandId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
      status: z.literal('dispatched'),
      adapterKind: BrowserSemanticAdapterKindV1Schema,
      events: z._default(z.array(BrowserEventV1Schema), []),
    }),
  z.strictObject({
      v: z.literal(1),
      commandId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
      status: z.literal('failed'),
      adapterKind: z.optional(BrowserSemanticAdapterKindV1Schema),
      /** Physical-effect settlement supplied by the executing adapter, not caller authority. */
      completion: z.optional(z.enum(['known', 'unknown'])),
      error: BrowserCommandDispatchErrorV1Schema,
    }),
]));
export type BrowserCommandDispatchResultV1 = z.infer<typeof BrowserCommandDispatchResultV1Schema>;

/** Acceptance is observed through the existing Machine Action operation owner. */
export const BrowserOpenViewInProgressV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  status: z.literal('in_progress'),
  phase: z.literal('browser_runtime_provisioning'),
  commandId: BrowserOpenViewCommandV1Schema.shape.commandId,
  browserSessionId: BrowserOpenViewCommandV1Schema.shape.browserSessionId,
  viewId: BrowserOpenViewCommandV1Schema.shape.viewId,
  operationId: z.string().check(z.trim(), z.minLength(1)),
}));

/** Workspace opening reports the selected presentation effect, not page-load completion. */
export const BrowserWorkspaceOpenResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BrowserCommandDispatchResultV1Schema._zod.def.options[0], {
    outcome: z.enum(['workspaceTab', 'externalTab']),
  })),
  BrowserCommandDispatchResultV1Schema._zod.def.options[1],
]));
export type BrowserWorkspaceOpenResultV1 = z.infer<typeof BrowserWorkspaceOpenResultV1Schema>;

const IdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(256)));

/**
 * Daemon machine-RPC envelope (W2-A-1): the single canonical UI→daemon transport for a
 * `BrowserCommandV1` against a daemon-authoritative view (`chromiumSidecar`/`streamedBrowserSurface`).
 *
 * The human-owner control surface (streamed/sidecar view reload/stop/navigate) routes through this
 * machine-scoped RPC to the SAME `createBrowserDaemonControlRoutes` broker that the agent
 * execution-run dispatch uses (MC-6 — one daemon control owner, no parallel path). The agent path
 * stays approval-floored at the action surface; this owner-scoped (account+machine) direct route is
 * the user-initiated `ui` path, which never prompts.
 */
export const DaemonBrowserControlDispatchRequestV1Schema = lazyZodSchema(() => z.strictObject({
    machineId: IdSchema,
    command: BrowserCommandV1Schema,
  }));
export type DaemonBrowserControlDispatchRequestV1 = z.infer<
  typeof DaemonBrowserControlDispatchRequestV1Schema
>;

export const DaemonBrowserControlDispatchResponseV1Schema = lazyZodSchema(() => z.strictObject({
    protocolVersion: z.literal(1),
    result: BrowserCommandDispatchResultV1Schema,
  }));
export type DaemonBrowserControlDispatchResponseV1 = z.infer<
  typeof DaemonBrowserControlDispatchResponseV1Schema
>;

/** Read-only projection of an owned view, never a CDP handle or a second view registry. */
export const BrowserDaemonViewV1Schema = lazyZodSchema(() => z.strictObject({
  browserSessionId: IdSchema,
  viewId: IdSchema,
  sourceId: z.string().check(z.minLength(1)),
  target: BrowserViewTargetV1Schema,
  platform: BrowserPlatformV1Schema,
  adapterKind: z.enum((['chromiumSidecar', 'streamedBrowserSurface'] as const).map((value) => { if (!BrowserSemanticAdapterKindV1Schema.options.includes(value)) throw new Error(`Key ${value} not found in enum`); return value; })),
  events: z.array(BrowserEventV1Schema),
  captureSource: z.optional(MachineLiveStreamCaptureSourceV1Schema),
}));
export type BrowserDaemonViewV1 = z.infer<typeof BrowserDaemonViewV1Schema>;

export const DaemonBrowserViewListRequestV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: IdSchema,
  browserSessionId: IdSchema,
}));
export const DaemonBrowserViewListResponseV1Schema = lazyZodSchema(() => z.strictObject({
  protocolVersion: z.literal(1),
  views: z.array(BrowserDaemonViewV1Schema),
}));
export type DaemonBrowserViewListResponseV1 = z.infer<typeof DaemonBrowserViewListResponseV1Schema>;
