import { z } from 'zod';

import { BrowserSemanticAdapterKindV1Schema } from '../adapters/kinds.js';
import { BrowserEventV1Schema } from '../events/v1.js';
import { BrowserViewTargetV1Schema } from '../target/v1.js';
import { BrowserHttpUrlV1Schema } from '../url.js';
import { BrowserPlatformV1Schema } from '../view/v1.js';

const BrowserCommandBaseV1Schema = z
  .object({
    commandId: z.string().trim().min(1).max(256),
  })
  .strict();

const BrowserSessionCommandBaseV1Schema = BrowserCommandBaseV1Schema.extend({
  browserSessionId: z.string().trim().min(1).max(256),
});

const BrowserViewCommandBaseV1Schema = BrowserSessionCommandBaseV1Schema.extend({
  viewId: z.string().trim().min(1).max(256),
});

export const BrowserCommandKindV1Schema = z.enum([
  'openView',
  'closeView',
  'focusView',
  'navigate',
  'goBack',
  'goForward',
  'reload',
  'stop',
  'setTarget',
]);
export type BrowserCommandKindV1 = z.infer<typeof BrowserCommandKindV1Schema>;

export const BrowserOpenViewCommandV1Schema = BrowserViewCommandBaseV1Schema.extend({
  kind: z.literal('openView'),
  target: BrowserViewTargetV1Schema,
  platform: BrowserPlatformV1Schema,
  currentUrl: BrowserHttpUrlV1Schema.optional(),
  currentUrlExpiresAt: z.number().int().nonnegative().optional(),
  focus: z.boolean().optional().default(true),
  openerViewId: z.string().trim().min(1).max(256).optional(),
});

export const BrowserCloseViewCommandV1Schema = BrowserViewCommandBaseV1Schema.extend({
  kind: z.literal('closeView'),
});

export const BrowserFocusViewCommandV1Schema = BrowserViewCommandBaseV1Schema.extend({
  kind: z.literal('focusView'),
});

export const BrowserNavigateCommandV1Schema = BrowserViewCommandBaseV1Schema.extend({
  kind: z.literal('navigate'),
  url: BrowserHttpUrlV1Schema,
});

export const BrowserGoBackCommandV1Schema = BrowserViewCommandBaseV1Schema.extend({
  kind: z.literal('goBack'),
});

export const BrowserGoForwardCommandV1Schema = BrowserViewCommandBaseV1Schema.extend({
  kind: z.literal('goForward'),
});

export const BrowserReloadCommandV1Schema = BrowserViewCommandBaseV1Schema.extend({
  kind: z.literal('reload'),
});

export const BrowserStopCommandV1Schema = BrowserViewCommandBaseV1Schema.extend({
  kind: z.literal('stop'),
});

export const BrowserSetTargetCommandV1Schema = BrowserViewCommandBaseV1Schema.extend({
  kind: z.literal('setTarget'),
  target: BrowserViewTargetV1Schema,
  currentUrl: BrowserHttpUrlV1Schema.optional(),
});

export const BrowserCommandV1Schema = z.discriminatedUnion('kind', [
  BrowserOpenViewCommandV1Schema,
  BrowserCloseViewCommandV1Schema,
  BrowserFocusViewCommandV1Schema,
  BrowserNavigateCommandV1Schema,
  BrowserGoBackCommandV1Schema,
  BrowserGoForwardCommandV1Schema,
  BrowserReloadCommandV1Schema,
  BrowserStopCommandV1Schema,
  BrowserSetTargetCommandV1Schema,
]);
export type BrowserCommandV1 = z.infer<typeof BrowserCommandV1Schema>;

export const BrowserCommandErrorCodeV1Schema = z.enum([
  'adapter_unavailable',
  'command_malformed',
  'feature_disabled',
  'permission_denied',
  'policy_unavailable',
  'session_not_found',
  'unsupported_command',
  'view_not_found',
]);
export type BrowserCommandErrorCodeV1 = z.infer<typeof BrowserCommandErrorCodeV1Schema>;

export const BrowserCommandDispatchErrorV1Schema = z
  .object({
    code: BrowserCommandErrorCodeV1Schema,
    message: z.string().trim().min(1).max(512),
    retryable: z.boolean().optional(),
  })
  .strict();
export type BrowserCommandDispatchErrorV1 = z.infer<typeof BrowserCommandDispatchErrorV1Schema>;

export const BrowserCommandDispatchResultV1Schema = z.discriminatedUnion('status', [
  z
    .object({
      v: z.literal(1),
      commandId: z.string().trim().min(1).max(256),
      status: z.literal('dispatched'),
      adapterKind: BrowserSemanticAdapterKindV1Schema,
      events: z.array(BrowserEventV1Schema).default([]),
    })
    .strict(),
  z
    .object({
      v: z.literal(1),
      commandId: z.string().trim().min(1).max(256),
      status: z.literal('failed'),
      adapterKind: BrowserSemanticAdapterKindV1Schema.optional(),
      error: BrowserCommandDispatchErrorV1Schema,
    })
    .strict(),
]);
export type BrowserCommandDispatchResultV1 = z.infer<typeof BrowserCommandDispatchResultV1Schema>;

const IdSchema = z.string().trim().min(1).max(256);

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
export const DaemonBrowserControlDispatchRequestV1Schema = z
  .object({
    machineId: IdSchema,
    command: BrowserCommandV1Schema,
  })
  .strict();
export type DaemonBrowserControlDispatchRequestV1 = z.infer<
  typeof DaemonBrowserControlDispatchRequestV1Schema
>;

export const DaemonBrowserControlDispatchResponseV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    result: BrowserCommandDispatchResultV1Schema,
  })
  .strict();
export type DaemonBrowserControlDispatchResponseV1 = z.infer<
  typeof DaemonBrowserControlDispatchResponseV1Schema
>;
