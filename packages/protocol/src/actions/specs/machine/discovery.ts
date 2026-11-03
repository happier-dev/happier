import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { StrictJsonValueSchema } from '../../../json/strictJsonValue.js';
import type { PreNormalizedActionSpec } from '../definition.js';
import { MachinePresenceReadInputV1Schema, MachinePresenceReadResultV1Schema } from '../../../machines/machineAccessV1.js';


export const MachinesListInputSchema = lazyZodSchema(() => z.strictObject({
  serverId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(200))),
  refresh: z.optional(z.boolean()),
}));

/**
 * The friendly `happier machines list` bound has always been the whole page. It
 * is a caller default, not an Action default: another surface may page.
 */
export const MACHINES_LIST_CLI_DEFAULT_LIMIT = 200;
export const MachinesListCliInputSchema = lazyZodSchema(() => z.strictObject({
  serverId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(MACHINES_LIST_CLI_DEFAULT_LIMIT))),
  refresh: z.optional(z.boolean()),
}));

export const MACHINE_DISCOVERY_ACTION_SPECS = Object.freeze([
  {
    id: 'machines.presence.read', executionPlacement: 'account', approval: { result: 'required' },
    title: 'Read Machine presence transitions', description: 'Read the latest committed offline and online occurrences through current Machine access.',
    safety: 'safe', sideEffectClass: 'read', placements: [],
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: true, rpc: false },
    bindings: { mcpToolName: 'machines_presence_read' },
    serverTransport: { method: 'GET', path: '/v1/machines/:machineId/presence' },
    inputSchema: MachinePresenceReadInputV1Schema, outputSchema: MachinePresenceReadResultV1Schema,
    inputHints: { fields: [{ path: 'serverId', title: 'Home ID', widget: 'text', required: true },
      { path: 'machineId', title: 'Machine ID', widget: 'text', required: true }] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'machines.list', executionPlacement: 'account', approval: {result: 'required'},
    title: 'List machines',
    sideEffectClass: 'read',
    description: 'List accessible machines on the qualified Home, including shared role, resource mode and current readiness. Offline and pending machines remain visible.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'listMachines', mcpToolName: 'machines_list' },
    examples: {
      voice: { argsExample: '{"limit":50}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'List machines',
      fields: [{ path: 'serverId', title: 'Home ID', widget: 'text' }, { path: 'limit', title: 'Limit', widget: 'text' },
        { path: 'refresh', title: 'Refresh machine inventory', widget: 'boolean' }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: MachinesListInputSchema,
    cli: {
      commands: [{ path: ['machines', 'list'], visibility: 'canonical' }],
      inputSchema: MachinesListCliInputSchema,
      bindInput: (value) => ({
        ...((value as Readonly<{ serverId?: string }>).serverId ? { serverId: (value as Readonly<{ serverId: string }>).serverId } : {}),
        limit: (value as Readonly<{ limit?: number }>).limit ?? MACHINES_LIST_CLI_DEFAULT_LIMIT,
        ...(typeof (value as Readonly<{ refresh?: boolean }>).refresh === 'boolean' ? { refresh: (value as Readonly<{ refresh: boolean }>).refresh } : {}),
      }),
    },
  } satisfies PreNormalizedActionSpec,
] as const);

