import { z } from 'zod/mini';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';

const identifier = z.string().check(z.trim(), z.minLength(1));
export const DesktopDisplaysListResultSchema = z.strictObject({
  displays: z.array(z.strictObject({
    storageKey: identifier,
    name: z.string(),
    builtIn: z.boolean(),
    primary: z.boolean(),
    connected: z.boolean(),
    inUse: z.boolean(),
  })),
  automaticResolvesTo: z.nullable(identifier),
});
export type DesktopDisplaysList = z.infer<typeof DesktopDisplaysListResultSchema>;

export const DesktopNotchSetInputSchema = z.strictObject({
  state: z.optional(z.enum(['rest', 'open', 'pinned'])),
  position: z.optional(z.union([z.number(), z.strictObject({ x: z.number(), y: z.number() })])),
});
export type DesktopNotchSetInput = z.infer<typeof DesktopNotchSetInputSchema>;

const common = {
  approval: { result: 'optional' },
  safety: 'safe', requiredAuthority: 'account_automation',
  executionPlacement: 'client', placements: [],
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: false, rpc: false },
  toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
} as const;

export const DESKTOP_SHELL_ACTION_SPECS = [{
  ...common,
  id: 'desktop.notch.set',
  placements: ['command_palette'],
  title: 'Set the desktop notch',
  description: 'Open, pin or release the notch, or move it along its edge or within the display. Presentation is local to the answering desktop.',
  sideEffectClass: 'write',
  bindings: { mcpToolName: 'desktop_notch_set' },
  inputSchema: DesktopNotchSetInputSchema,
  outputSchema: z.strictObject({ applied: z.literal(true) }),
}, {
  ...common,
  id: 'desktop.displays.list',
  title: 'List desktop displays',
  description: 'Read connected and remembered displays, the notch display in use, and the display Automatic resolves to on the answering desktop.',
  sideEffectClass: 'read',
  bindings: { mcpToolName: 'desktop_displays_list' },
  inputSchema: z.strictObject({}),
  outputSchema: DesktopDisplaysListResultSchema,
}] as const satisfies readonly PreNormalizedActionSpec[];
