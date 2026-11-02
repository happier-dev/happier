import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';
import { actionInputServerId } from './specs/definition.js';
import { SessionOpenDestinationSchema } from './sessionOpenDestination.js';
import { PaneTabAddressSchema, WorkspaceOwnedTabAddressSchema } from './workspaceActionFamily.js';

const id = z.string().check(z.trim(), z.minLength(1));
const scope = { accountId: id, serverId: id };

/** Closed device-local presentation addresses; pane identity stays opaque to Actions. */
export const DesktopWindowTargetSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session'), ...scope, sessionId: id, destination: z.optional(SessionOpenDestinationSchema) }),
  z.extend(z.partial(WorkspaceOwnedTabAddressSchema, { layoutId: true }), { destination: z.optional(SessionOpenDestinationSchema) }),
  z.strictObject({ kind: z.literal('destination'), ...scope, layoutId: z.optional(id), href: id }),
  z.extend(PaneTabAddressSchema, { resourceId: z.optional(id) }),
]));
export const DesktopWindowsOpenInputSchema = lazyZodSchema(() => z.strictObject({
  target: DesktopWindowTargetSchema,
  windowId: z.optional(id),
}));
export const DesktopWindowsOpenResultSchema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.enum(['opened', 'focused']), windowId: id,
    rect: z.optional(z.strictObject({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })),
  }),
  z.strictObject({ status: z.literal('cancelled') }),
]));
export type DesktopWindowTarget = z.infer<typeof DesktopWindowTargetSchema>;
export type DesktopWindowsOpenInput = z.infer<typeof DesktopWindowsOpenInputSchema>;
export type DesktopWindowsOpenResult = z.infer<typeof DesktopWindowsOpenResultSchema>;

export const DESKTOP_WINDOWS_ACTION_SPECS = [{
  id: 'desktop.windows.open', approval: { result: 'optional' },
  title: 'Open in a desktop window',
  description: 'Move a qualified workspace or pane tab, or open a destination in the answering desktop. Reuses an existing target window; an optional window id retargets it.',
  safety: 'safe', sideEffectClass: 'external', requiredAuthority: 'account_automation', executionPlacement: 'client',
  invocationServerIdForInput: actionInputServerId(DesktopWindowsOpenInputSchema, (input) => input.target.serverId),
  placements: [], bindings: { mcpToolName: 'desktop_windows_open', voiceClientToolName: 'openDesktopWindow' },
  surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
  cli: { acceptsServerId: true, commands: [{ path: ['desktop', 'windows', 'open'], visibility: 'canonical' }] },
  toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
  inputSchema: DesktopWindowsOpenInputSchema, outputSchema: DesktopWindowsOpenResultSchema,
  inputHints: { fields: [
    { path: 'target', title: 'Qualified destination', widget: 'json', required: true },
    { path: 'windowId', title: 'Existing window', widget: 'text' },
  ] },
}] as const satisfies readonly PreNormalizedActionSpec[];
