import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

import type { CapabilitiesDetectRequest } from './index.js';
import type { PluginProjectionV2 } from '../daemon/contributionRegistryProjection.js';
import { AcpBackendDefinitionV1Schema, AcpBackendLaunchV1Schema, type AcpBackendDefinitionV1 } from '../acp/catalog/settingsV1.js';
import type { AcpCatalogSnapshotV1 } from '../acp/catalog/catalogRowsV1.js';
import { AcpPlatformFitV1Schema } from '../acp/catalog/registry/acpPlatformFitV1.js';
import { isNewerVersion } from '../updates/versionComparison.js';
import { buildConfiguredAcpAgentSelectionV1, CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '../agents/executionTargetV1.js';
import { agentRoutingIdAddressesContributionIdentityV1 } from '../plugins/contributionIdentity.js';

/** Caller-owned executable facts only. Inventory never carries environment or secret material. */
export const MachineAcpInventoryDefinitionSchema = lazyZodSchema(() => z.strictObject({
  definitionId: AcpBackendDefinitionV1Schema.shape.id,
  title: z.string().check(z.minLength(1)),
  launch: AcpBackendLaunchV1Schema.check(z.refine(launch => !('envByPlatform' in launch))),
}));
export type MachineAcpInventoryDefinition = z.output<typeof MachineAcpInventoryDefinitionSchema>;
export const MachineAcpInventoryRequestSchema = lazyZodSchema(() => z.strictObject({
  definitions: z.array(MachineAcpInventoryDefinitionSchema).check(z.refine(definitions => new Set(definitions.map(definition => definition.definitionId)).size === definitions.length)),
  // The canonical capability service forwards its refresh metadata in params.
  bypassCache: z.optional(z.boolean()),
}));
const DefinitionCatalogUnavailableSchema = lazyZodSchema(() => z.strictObject({ status: z.literal('unavailable'), reason: z.string().check(z.minLength(1)) }));
type DefinitionInventoryInput = Readonly<{
  definitions?: readonly MachineAcpInventoryDefinition[];
  definitionCatalog?: z.output<typeof DefinitionCatalogUnavailableSchema>;
}>;

export function buildMachineAgentInventoryKey(target: Readonly<{ agentId: string; definitionId?: string }>): string {
  if (target.definitionId === undefined) return target.agentId;
  const agentId = agentRoutingIdAddressesContributionIdentityV1(target.agentId, CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1)
    ? buildConfiguredAcpAgentSelectionV1(target.definitionId).agentId : target.agentId;
  return JSON.stringify([agentId, target.definitionId]);
}

export function projectAcpCatalogForMachineInventory(catalog: AcpCatalogSnapshotV1 | undefined,
  retainedDefinitions: readonly AcpBackendDefinitionV1[] = [],
): DefinitionInventoryInput {
  const observed = catalog?.status === 'ready' || catalog?.status === 'partial' ? catalog.record.definitions : retainedDefinitions;
  const definitions = observed.map(definition => {
    const launch = definition.launch.kind === 'archive'
      ? (({ envByPlatform: _environment, ...facts }) => facts)(definition.launch) : definition.launch;
    return MachineAcpInventoryDefinitionSchema.parse({ definitionId: definition.id, title: definition.title, launch });
  });
  return { definitions, ...(catalog?.status === 'ready' ? {} : { definitionCatalog: { status: 'unavailable' as const,
    reason: catalog?.status === 'partial' || catalog?.status === 'unavailable' ? catalog.reason : 'catalog-not-ready' } }) };
}

const MachineAgentFactsSchema = lazyZodSchema(() => z.object({
  installed: z.boolean(),
  managed: z.optional(z.boolean()),
  fit: z.optional(AcpPlatformFitV1Schema),
  version: z.nullable(z.string()),
  latestVersion: z.nullable(z.string()),
  update: z.strictObject({ supported: z.boolean(), command: z.nullable(z.string()) }),
  signIn: z.strictObject({
    status: z.enum(['signedIn', 'signedOut', 'unknown']),
    /** Omission uses native login support; an explicit requirement takes precedence. */
    required: z.optional(z.boolean()),
    accountLabel: z.optional(z.string()),
    loginSupport: z.enum(['login_terminal', 'status_only', 'manual_only', 'unsupported']),
  }),
  platform: z.discriminatedUnion('supported', [
    z.strictObject({ supported: z.literal(true) }),
    z.strictObject({ supported: z.literal(false), reason: z.enum(['os', 'arch']) }),
  ]),
  install: z.strictObject({
    available: z.boolean(),
    mode: z.enum(['managed', 'vendor_recipe', 'manual', 'none']),
    sizeBytes: z.nullable(z.number().check(z.nonnegative())),
    guideUrl: z.nullable(z.string()),
  }),
  dependencies: z.array(z.strictObject({
    key: z.string().check(z.minLength(1)), installed: z.boolean(), version: z.nullable(z.string()),
  })),
}));

/** Daemon facts, before connected-account or presentation-state composition. */
export const MachineAgentInventoryItemSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(MachineAgentFactsSchema, {
  agentId: z.string().check(z.minLength(1)), definitionId: z.optional(AcpBackendDefinitionV1Schema.shape.id), title: z.string().check(z.minLength(1)),
})));
export type MachineAgentInventoryItem = z.output<typeof MachineAgentInventoryItemSchema>;

/** Unknown or non-comparable versions preserve an already installed executable. */
export function resolveMachineAgentAcquireIntentV1(input: Pick<MachineAgentInventoryItem,
  'installed' | 'version' | 'latestVersion'> & Readonly<{
    update?: Readonly<Pick<MachineAgentInventoryItem['update'], 'supported'>> | null;
  }>): 'install' | 'update' | null {
  if (!input.installed) return 'install';
  return input.update?.supported && isNewerVersion(input.version, input.latestVersion) ? 'update' : null;
}

/** Shared installation/authentication prerequisite, before UI update/job presentation. */
export const MachineAgentExecutionStateV1Schema = lazyZodSchema(() => z.enum([
  'ready', 'needsSignIn', 'notInstalled', 'unsupported', 'checking', 'unknown',
]));
export type MachineAgentExecutionStateV1 = z.infer<typeof MachineAgentExecutionStateV1Schema>;

export function resolveMachineAgentExecutionStateV1(input: Readonly<{
  /** Inventory has already resolved the selected credential; strip only its display lifecycle overlays. */
  inventoryState: MachineAgentExecutionStateV1 | 'updateAvailable' | 'installing' | 'failed';
  known?: boolean;
  checking?: boolean;
}> | Pick<MachineAgentInventoryItem,
  'installed' | 'platform' | 'fit'> & Readonly<{
  dependencies: readonly Pick<MachineAgentInventoryItem['dependencies'][number], 'installed'>[];
  signIn: Readonly<Pick<MachineAgentInventoryItem['signIn'], 'status'>
    & Partial<Pick<MachineAgentInventoryItem['signIn'], 'required' | 'loginSupport'>>
    & { native?: Readonly<Partial<Pick<MachineAgentInventoryItem['signIn'], 'required' | 'loginSupport'>>> }>;
  known?: boolean;
  checking?: boolean;
  credentialRouteReady?: boolean;
  authenticationRequired?: boolean;
}>): MachineAgentExecutionStateV1 {
  if ('inventoryState' in input) {
    const state = input.inventoryState;
    if (input.checking && (state === 'unknown' || state === 'checking')) return 'checking';
    if (input.known === false) return 'unknown';
    if (state === 'updateAvailable') return 'ready';
    if (state === 'installing' || state === 'failed') return 'notInstalled';
    return state;
  }
  if (input.known === false) return input.checking ? 'checking' : 'unknown';
  if (input.fit?.kind === 'unknown') return 'unknown';
  if (input.fit?.kind === 'cant_run' || !input.platform.supported) return 'unsupported';
  if (!input.installed || input.dependencies.some(dependency => !dependency.installed)) return 'notInstalled';
  if (input.credentialRouteReady === false) return 'unknown';
  const nativeSignIn = input.signIn.native ?? input.signIn;
  if (input.authenticationRequired ?? nativeSignIn.required ?? (nativeSignIn.loginSupport !== 'unsupported')) {
    if (input.signIn.status === 'signedOut') return 'needsSignIn';
    if (input.signIn.status !== 'signedIn') return 'unknown';
  }
  return 'ready';
}

/** A failed probe carries no installation or readiness facts. */
export const MachineAgentInventoryUnavailableSchema = lazyZodSchema(() => z.strictObject({
  agentId: z.string().check(z.minLength(1)),
  definitionId: z.optional(AcpBackendDefinitionV1Schema.shape.id),
  reason: z.enum(['missing_result', 'probe_failed', 'invalid_facts']),
  errorCode: z.optional(z.string()),
}));
export type MachineAgentInventoryUnavailable = z.output<typeof MachineAgentInventoryUnavailableSchema>;

export const MachinesAgentsListInputSchema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.trim(), z.minLength(1)),
  serverId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  agentId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  definitionId: z.optional(AcpBackendDefinitionV1Schema.shape.id),
  refresh: z.optional(z.boolean()),
}));
export type MachinesAgentsListInput = z.output<typeof MachinesAgentsListInputSchema>;

export const MachinesAgentsListOutputSchema = lazyZodSchema(() => z.strictObject({
  items: z.array(MachineAgentInventoryItemSchema),
  unavailable: z.optional(z.array(MachineAgentInventoryUnavailableSchema)),
  definitionCatalog: z.optional(DefinitionCatalogUnavailableSchema),
}));
export type MachinesAgentsListOutput = z.output<typeof MachinesAgentsListOutputSchema>;

export type MachineAgentInventoryDescriptor = Readonly<{ agentId: string; definitionId?: string; title: string }>;

/** The target machine's projected registry owns the session-capable roster. */
export function buildMachineAgentInventoryDescriptors(
  projection: Pick<PluginProjectionV2, 'agentsById'>,
  definitions: readonly Pick<MachineAcpInventoryDefinition, 'definitionId' | 'title'>[] = [],
): readonly MachineAgentInventoryDescriptor[] {
  return [...Object.entries(projection.agentsById)
    .filter(([, agent]) => Boolean(agent.capabilities?.sessions))
    .map(([agentId, agent]) => ({ agentId, title: agent.title?.trim() || agentId })),
    ...definitions.map(definition => ({ agentId: buildConfiguredAcpAgentSelectionV1(definition.definitionId).agentId,
      definitionId: definition.definitionId, title: definition.title }))];
}

/** Inventory readers share non-interactive facts; launch admission needs no vendor update lookup. */
export function buildMachineAgentsDetectRequest(input: Readonly<{
  agents: readonly MachineAgentInventoryDescriptor[];
  refresh?: boolean;
  includeLatestVersion?: boolean;
  /** Launch consumes executable facts; login and version metadata stay optional. */
  readinessOnly?: boolean;
}> & DefinitionInventoryInput): Pick<CapabilitiesDetectRequest, 'requests' | 'bypassCache'> {
  return {
    requests: [...input.agents.filter(agent => agent.definitionId === undefined).map(({ agentId }) => ({
      id: `cli.${agentId}`,
      params: input.readinessOnly ? { includeVersion: false }
        : { includeLoginStatus: true, ...(input.includeLatestVersion === false ? {} : { includeLatestVersion: true }) },
    }) as const), ...(input.definitions && !input.definitionCatalog
      ? [{ id: 'tool.acpAgentInventory' as const, params: MachineAcpInventoryRequestSchema.parse({ definitions: input.definitions }) }] : [])],
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
}> & DefinitionInventoryInput): MachinesAgentsListOutput {
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
  for (const { agentId, title } of input.agents.filter(agent => agent.definitionId === undefined)) {
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
  if (input.definitions) {
    const result: unknown = Reflect.get(results, 'tool.acpAgentInventory');
    const response = result && typeof result === 'object' && Reflect.get(result, 'ok') === true
      ? MachinesAgentsListOutputSchema.safeParse(Reflect.get(result, 'data')) : null;
    const expected = new Map(input.definitions.map(definition => [definition.definitionId, definition]));
    const valid = response?.success && !response.data.unavailable && !response.data.definitionCatalog
      && response.data.items.length === expected.size
      && new Set(response.data.items.map(item => item.definitionId)).size === expected.size
      && response.data.items.every(item => item.definitionId !== undefined
        && item.agentId === buildConfiguredAcpAgentSelectionV1(item.definitionId).agentId
        && item.title === expected.get(item.definitionId)?.title && item.managed !== undefined && item.fit !== undefined);
    if (!input.definitionCatalog && valid && response.success) items.push(...response.data.items);
    else for (const definition of input.definitions) {
      const error = result && typeof result === 'object' ? Reflect.get(result, 'error') : undefined;
      const errorCode = input.definitionCatalog?.reason
        ?? (error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined);
      unavailable.push({ agentId: buildConfiguredAcpAgentSelectionV1(definition.definitionId).agentId, definitionId: definition.definitionId,
        reason: input.definitionCatalog || result && typeof result === 'object' && Reflect.get(result, 'ok') === false
          ? 'probe_failed' : result === undefined ? 'missing_result' : 'invalid_facts',
        ...(typeof errorCode === 'string' ? { errorCode } : {}) });
    }
  }
  return { items, ...(unavailable.length > 0 ? { unavailable } : {}), ...(input.definitionCatalog ? { definitionCatalog: input.definitionCatalog } : {}) };
}
