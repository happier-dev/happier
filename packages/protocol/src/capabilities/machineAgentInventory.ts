import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import type { CapabilitiesDetectRequest } from './index.js';
import type { PluginProjectionV2 } from '../daemon/contributionRegistryProjection.js';

const MachineAgentFactsSchema = lazyZodSchema(() => z.object({
  installed: z.boolean(),
  version: z.string().nullable(),
  latestVersion: z.string().nullable(),
  update: z.object({ supported: z.boolean(), command: z.string().nullable() }).strict(),
  signIn: z.object({
    status: z.enum(['signedIn', 'signedOut', 'unknown']),
    accountLabel: z.string().optional(),
    loginSupport: z.enum(['login_terminal', 'status_only', 'manual_only', 'unsupported']),
  }).strict(),
  platform: z.discriminatedUnion('supported', [
    z.object({ supported: z.literal(true) }).strict(),
    z.object({ supported: z.literal(false), reason: z.enum(['os', 'arch']) }).strict(),
  ]),
  install: z.object({
    available: z.boolean(),
    mode: z.enum(['managed', 'vendor_recipe', 'manual', 'none']),
    sizeBytes: z.number().nonnegative().nullable(),
    guideUrl: z.string().nullable(),
  }).strict(),
  dependencies: z.array(z.object({
    key: z.string().min(1), installed: z.boolean(), version: z.string().nullable(),
  }).strict()),
}));

/** Daemon facts, before connected-account or presentation-state composition. */
export const MachineAgentInventoryItemSchema = lazyZodSchema(() => MachineAgentFactsSchema.extend({
  agentId: z.string().min(1), title: z.string().min(1),
}).strict());
export type MachineAgentInventoryItem = z.output<typeof MachineAgentInventoryItemSchema>;

/** A failed probe carries no installation or readiness facts. */
export const MachineAgentInventoryUnavailableSchema = lazyZodSchema(() => z.object({
  agentId: z.string().min(1),
  reason: z.enum(['missing_result', 'probe_failed', 'invalid_facts']),
  errorCode: z.string().optional(),
}).strict());
export type MachineAgentInventoryUnavailable = z.output<typeof MachineAgentInventoryUnavailableSchema>;

export const MachinesAgentsListInputSchema = lazyZodSchema(() => z.object({
  machineId: z.string().trim().min(1),
  serverId: z.string().trim().min(1).optional(),
  agentId: z.string().trim().min(1).optional(),
  refresh: z.boolean().optional(),
}).strict());
export type MachinesAgentsListInput = z.output<typeof MachinesAgentsListInputSchema>;

export const MachinesAgentsListOutputSchema = lazyZodSchema(() => z.object({
  items: z.array(MachineAgentInventoryItemSchema),
  unavailable: z.array(MachineAgentInventoryUnavailableSchema).optional(),
}).strict());
export type MachinesAgentsListOutput = z.output<typeof MachinesAgentsListOutputSchema>;

export type MachineAgentInventoryDescriptor = Readonly<{ agentId: string; title: string }>;

/** The target machine's projected registry owns the session-capable roster. */
export function buildMachineAgentInventoryDescriptors(
  projection: Pick<PluginProjectionV2, 'agentsById'>,
): readonly MachineAgentInventoryDescriptor[] {
  return Object.entries(projection.agentsById)
    .filter(([, agent]) => Boolean(agent.capabilities?.sessions))
    .map(([agentId, agent]) => ({ agentId, title: agent.title?.trim() || agentId }));
}

/** All inventory readers request the same complete, non-interactive snapshot. */
export function buildMachineAgentsDetectRequest(input: Readonly<{
  agents: readonly MachineAgentInventoryDescriptor[];
  refresh?: boolean;
}>): CapabilitiesDetectRequest {
  return {
    requests: input.agents.map(({ agentId }) => ({
      id: `cli.${agentId}`,
      params: { includeLoginStatus: true, includeLatestVersion: true },
    })),
    ...(input.refresh === true ? { bypassCache: true } : {}),
  };
}

export class MachineAgentInventoryUnavailableError extends Error {
  readonly code = 'machine_agent_inventory_unavailable' as const;
  constructor(readonly agentId: string) {
    super(`Agent inventory is unavailable for ${agentId}`);
    this.name = 'MachineAgentInventoryUnavailableError';
  }
}

/** Strip legacy probe metadata; readiness remains exclusively daemon-owned. */
export function projectMachineAgentsDetectResponse(input: Readonly<{
  agents: readonly MachineAgentInventoryDescriptor[];
  response: unknown;
}>): MachinesAgentsListOutput {
  if (!input.response || typeof input.response !== 'object' || Array.isArray(input.response)
    || Reflect.get(input.response, 'protocolVersion') !== 1) {
    throw new MachineAgentInventoryUnavailableError(input.agents[0]?.agentId ?? 'unknown');
  }
  const results: unknown = Reflect.get(input.response, 'results');
  if (!results || typeof results !== 'object' || Array.isArray(results)) {
    throw new MachineAgentInventoryUnavailableError(input.agents[0]?.agentId ?? 'unknown');
  }
  const items: MachineAgentInventoryItem[] = [];
  const unavailable: MachineAgentInventoryUnavailable[] = [];
  for (const { agentId, title } of input.agents) {
    const result: unknown = Reflect.get(results, `cli.${agentId}`);
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      unavailable.push({ agentId, reason: 'missing_result' });
      continue;
    }
    if (Reflect.get(result, 'ok') !== true) {
      const error: unknown = Reflect.get(result, 'error');
      const errorCode: unknown = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
      unavailable.push({ agentId, reason: 'probe_failed', ...(typeof errorCode === 'string' ? { errorCode } : {}) });
      continue;
    }
    const data: unknown = Reflect.get(result, 'data');
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      unavailable.push({ agentId, reason: 'invalid_facts' });
      continue;
    }
    const parsed = MachineAgentFactsSchema.safeParse({
      ...data, version: Reflect.get(data, 'version') ?? null, latestVersion: Reflect.get(data, 'latestVersion') ?? null,
    });
    if (!parsed.success) {
      unavailable.push({ agentId, reason: 'invalid_facts' });
      continue;
    }
    items.push({ agentId, title, ...parsed.data });
  }
  return { items, ...(unavailable.length > 0 ? { unavailable } : {}) };
}
