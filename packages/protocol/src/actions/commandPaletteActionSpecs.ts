import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import type { PreNormalizedActionSpec } from './actionSpecs.js';

export const CommandPaletteListInputSchema = lazyZodSchema(() => z.object({}).strict());
export const CommandPaletteInvokeInputSchema = lazyZodSchema(() => z.object({ commandId: z.string().trim().min(1) }).strict());
export const CommandPaletteListOutputSchema = lazyZodSchema(() => z.object({
  commands: z.array(z.object({
    id: z.string().min(1),
    title: z.string(),
    subtitle: z.string().optional(),
    category: z.string().optional(),
  }).strict()),
}).strict());
export const CommandPaletteInvokeOutputSchema = lazyZodSchema(() => z.object({ invoked: z.literal(true) }).strict());

const surfaces = { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false } as const;

/** The mounted palette remains the only command catalog and dispatch owner. */
export const COMMAND_PALETTE_ACTION_SPECS = [
  {
    id: 'ui.command_palette.list', title: 'List command palette entries',
    description: 'List the current client’s available commands. Requires a mounted app shell.',
    safety: 'safe', sideEffectClass: 'read', executionPlacement: 'client',
    placements: [], surfaces,
    bindings: { voiceClientToolName: 'listCommandPalette', mcpToolName: 'ui_command_palette_list' },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: CommandPaletteListInputSchema, outputSchema: CommandPaletteListOutputSchema,
    inputHints: { fields: [] },
    examples: { voice: { argsExample: '{}' } },
    cli: { commands: [{ path: ['ui', 'command-palette', 'list'], visibility: 'canonical' }] },
  },
  {
    id: 'ui.command_palette.invoke', title: 'Invoke a command palette entry',
    description: 'Invoke an available command by its catalog id on the current client. Commands keep their existing navigation and Action policy.',
    safety: 'safe', sideEffectClass: 'external', executionPlacement: 'client',
    placements: [], surfaces,
    bindings: { voiceClientToolName: 'invokeCommandPalette', mcpToolName: 'ui_command_palette_invoke' },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputHints: { fields: [{ path: 'commandId', title: 'Command id', widget: 'text', required: true }] },
    inputSchema: CommandPaletteInvokeInputSchema, outputSchema: CommandPaletteInvokeOutputSchema,
    examples: { voice: { argsExample: '{"commandId":"session.pending.next"}' } },
    cli: { commands: [{ path: ['ui', 'command-palette', 'invoke'], visibility: 'canonical', positionals: ['commandId'] }] },
  },
] as const satisfies readonly PreNormalizedActionSpec[];
