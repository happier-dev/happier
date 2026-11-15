import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { PluginContributionLocalIdSchema } from '../../plugins/contributionIdentity.js';
import {
  getMachineMetadataFieldV1, mutateMachineMetadataFieldV1, readMachineMetadataFieldV1,
  type MachineMetadataFieldPortV1,
} from '../machineMetadataFieldV1.js';
import type { ManagedMachineEnrollmentIdentityV1 } from '../managed/enrollmentIdentityV1.js';
import { MachineIsolationV1Schema } from '../metadataUpdate.js';

/**
 * The nine built-in Machine roles. Machine core (identity, credentials,
 * registration, Home carrier, policy, update, plugin summary, control socket)
 * is always on and is not a role.
 */
export const CORE_MACHINE_ROLE_IDS_V1 = [
  'sessions', 'broker', 'intake', 'deployments', 'workspaces', 'relay', 'memory', 'voice', 'devices',
] as const;
export type CoreMachineRoleIdV1 = typeof CORE_MACHINE_ROLE_IDS_V1[number];
export const CoreMachineRoleIdV1Schema = lazyZodSchema(() => z.enum(CORE_MACHINE_ROLE_IDS_V1));

/** The one typed refusal a Machine returns for work owned by an inactive role. */
export const MACHINE_ROLE_INACTIVE_ERROR_CODE = 'machine_role_inactive' as const;

/** A core id, or a plugin role qualified as `<pluginId>/<localId>`. */
export const MachineRoleIdV1Schema = lazyZodSchema(() => z.string().check(z.maxLength(256), z.regex(/^[a-z0-9][a-z0-9.-]*(?:\/[a-z0-9]+(?:[-/][a-z0-9]+)*)?$/u)));

/**
 * One declaration shape for core roles and the plugin manifest family
 * `machineRoles`. A plugin entry with `partOf` adds its listed services to that
 * core role instead of creating a new toggle.
 */
export const MachineRoleDeclarationV1Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: z.string().check(z.minLength(1)),
  description: z.string().check(z.minLength(1)),
  requires: z.optional(z.array(MachineRoleIdV1Schema)),
  partOf: z.optional(CoreMachineRoleIdV1Schema),
  backgroundServices: z.optional(z.array(asProtocolZod(PluginContributionLocalIdSchema))),
  defaultActive: z.optional(z.boolean()),
}));
export type MachineRoleDeclarationV1 = z.infer<typeof MachineRoleDeclarationV1Schema>;

export const CORE_MACHINE_ROLE_DECLARATIONS_V1: readonly (MachineRoleDeclarationV1 & { id: CoreMachineRoleIdV1 })[] = [
  { id: 'sessions', title: 'Sessions', description: 'Starts, resumes and hosts Sessions, workflows and delegated runs.' },
  { id: 'broker', title: 'Credential broker', description: 'Serves connected provider accounts and the provider gateway to other Machines.' },
  { id: 'intake', title: 'Work intake', description: 'Runs channel adapters, webhooks and automation triggers that start work on a chosen Machine.' },
  { id: 'deployments', title: 'Deployments', description: 'Runs deployments, local services and backups.' },
  { id: 'workspaces', title: 'Workspaces', description: 'Syncs workspaces and runs project jobs.' },
  { id: 'relay', title: 'Relay', description: 'Relays peer connections, service exports and SSH tunnels.' },
  { id: 'memory', title: 'Memory', description: 'Indexes Sessions for memory search.' },
  { id: 'voice', title: 'Voice', description: 'Runs local voice models.' },
  { id: 'devices', title: 'Local tools', description: 'Browser, computer use, simulators, live streams and process tools.' },
];

/** Resolver input: one entry per role id (core or qualified plugin id). */
export type MachineRoleCatalogEntryV1 = Readonly<{
  id: string;
  requires?: readonly string[];
  partOf?: CoreMachineRoleIdV1;
  defaultActive?: boolean;
}>;
export const CORE_MACHINE_ROLE_CATALOG_V1: readonly MachineRoleCatalogEntryV1[] = CORE_MACHINE_ROLE_IDS_V1.map(id => ({ id, defaultActive: true }));

export const MachineRolesPolicyV1Schema = lazyZodSchema(() => z.strictObject({
  active: z.array(MachineRoleIdV1Schema).check(z.refine(ids => new Set(ids).size === ids.length, 'Role ids must be unique.')),
}));
export type MachineRolesPolicyV1 = z.infer<typeof MachineRolesPolicyV1Schema>;
export const MachineRolesPolicyV1StoredSchema = createStoredReadSchema(MachineRolesPolicyV1Schema);

export const MachineRolesMutationV1Schema = lazyZodSchema(() => z.strictObject({
  expectedPolicy: MachineRolesPolicyV1Schema,
  expectedMetadataVersion: z.number().check(z.int(), z.nonnegative()),
  policy: MachineRolesPolicyV1Schema,
  /** Creation enrollment seeds this once in the same metadata CAS as default roles. */
  isolation: z.optional(MachineIsolationV1Schema),
}));
export type MachineRolesMutationV1 = z.infer<typeof MachineRolesMutationV1Schema>;

export const MachineRolesGetResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('ready'), policy: MachineRolesPolicyV1Schema,
    source: z.enum(['default', 'stored']), metadataVersion: z.number().check(z.int(), z.nonnegative()) }),
  z.strictObject({ status: z.enum(['locked', 'invalid', 'unavailable']) }),
]));
export type MachineRolesGetResultV1 = z.infer<typeof MachineRolesGetResultV1Schema>;

export const MachineRolesMutationResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.enum(['applied', 'satisfied', 'unchanged', 'conflict']),
    policy: MachineRolesPolicyV1Schema, metadataVersion: z.number().check(z.int(), z.nonnegative()) }),
  z.strictObject({ status: z.enum(['outcomeUnknown', 'cancelled', 'locked', 'invalid', 'unavailable']) }),
]));
export type MachineRolesMutationResultV1 = z.infer<typeof MachineRolesMutationResultV1Schema>;

const sameRoleSet = (left: MachineRolesPolicyV1, right: MachineRolesPolicyV1) =>
  left.active.length === right.active.length && left.active.every(id => right.active.includes(id));

export const machineRolesMetadataFieldV1 = {
  field: 'rolesV1', storedSchema: MachineRolesPolicyV1StoredSchema,
  // Missing = every core role = today's behaviour; 0.2 and older 0.3 Machines need no write.
  defaultValue: (): MachineRolesPolicyV1 => ({ active: [...CORE_MACHINE_ROLE_IDS_V1] }),
  equal: sameRoleSet,
};

export function readMachineRolesV1(openedMetadata: unknown) {
  return readMachineMetadataFieldV1(openedMetadata, machineRolesMetadataFieldV1);
}
export async function getMachineRolesV1(port: MachineMetadataFieldPortV1): Promise<MachineRolesGetResultV1> {
  return getMachineMetadataFieldV1(port, machineRolesMetadataFieldV1);
}
/** Field CAS: unrelated metadata edits rebase; a concurrent role change is a conflict. */
export async function mutateMachineRolesV1(input: unknown, port: MachineMetadataFieldPortV1,
  options?: Readonly<{ signal?: AbortSignal }>): Promise<MachineRolesMutationResultV1> {
  const parsed = MachineRolesMutationV1Schema.safeParse(input);
  if (!parsed.success) return { status: 'invalid' };
  return mutateMachineMetadataFieldV1({ ...parsed.data, comparison: 'field' }, port, machineRolesMetadataFieldV1,
    { ...options, ...(parsed.data.isolation ? { seed: { field: 'isolationV1', value: parsed.data.isolation } } : {}) });
}

/**
 * The single decision for "which roles are active on this Machine": the
 * daemon's registration owner, placement owners and the UI all call this.
 * Unreadable metadata resolves like a missing field (today's behaviour); the
 * receiving daemon still refuses work for a role it does not run.
 */
export function resolveActiveMachineRolesV1(openedMetadata: unknown,
  catalog: readonly MachineRoleCatalogEntryV1[] = CORE_MACHINE_ROLE_CATALOG_V1): ReadonlySet<string> {
  const read = readMachineRolesV1(openedMetadata);
  const stored = read.status === 'ready' && read.source === 'stored' ? new Set(read.policy.active) : null;
  const entries = new Map<string, MachineRoleCatalogEntryV1>(CORE_MACHINE_ROLE_CATALOG_V1.map(entry => [entry.id, entry]));
  for (const entry of catalog) entries.set(entry.id, entry);
  const selected = (entry: MachineRoleCatalogEntryV1) => stored ? stored.has(entry.id) : entry.defaultActive === true;
  const active = new Set<string>();
  const visiting = new Set<string>();
  const resolve = (id: string): boolean => {
    if (active.has(id)) return true;
    const entry = entries.get(id);
    if (!entry || visiting.has(id)) return false;
    visiting.add(id);
    const on = (entry.partOf ? resolve(entry.partOf) : selected(entry)) && (entry.requires ?? []).every(resolve);
    visiting.delete(id);
    if (on) active.add(id);
    return on;
  };
  // Unknown stored ids (an uninstalled plugin) stay stored and resolve inactive.
  for (const id of entries.keys()) resolve(id);
  return active;
}

export function isMachineRoleActiveV1(openedMetadata: unknown, roleId: string,
  catalog?: readonly MachineRoleCatalogEntryV1[]): boolean {
  return resolveActiveMachineRolesV1(openedMetadata, catalog).has(roleId);
}

/** Owner-approved creation defaults; personal/adopted installs keep the missing field. */
export function resolveManagedMachineEnrollmentRolesV1(identity: ManagedMachineEnrollmentIdentityV1 | undefined): MachineRolesPolicyV1 | null {
  if (identity?.kind === 'guestProcess') return { active: ['sessions'] };
  if (identity?.kind !== 'dedicatedDaemonUser') return null;
  return identity.role === 'deployTarget'
    ? { active: ['deployments', 'sessions'] }
    : { active: ['sessions', 'broker', 'workspaces', 'relay'] };
}

/** A creation child may only seed its reviewed default over the missing field. */
export function matchesManagedMachineEnrollmentRolesV1(target: Readonly<{
  homeId: string; machineId: string; enrollmentIdentity?: ManagedMachineEnrollmentIdentityV1;
}>, request: MachineRolesMutationV1 & Readonly<{ serverId?: string; machineId: string }>): boolean {
  const policy = resolveManagedMachineEnrollmentRolesV1(target.enrollmentIdentity);
  return policy !== null && request.machineId === target.machineId
    && (request.serverId === undefined || request.serverId === target.homeId)
    && sameRoleSet(request.expectedPolicy, machineRolesMetadataFieldV1.defaultValue())
    && sameRoleSet(request.policy, policy);
}

/** A plugin's admitted `machineRoles` declarations, qualified by plugin id. */
export type PluginMachineRoleDeclarationV1 = Readonly<{ pluginId: string; declaration: MachineRoleDeclarationV1 }>;
export const PluginMachineRoleDeclarationV1Schema = lazyZodSchema(() => z.strictObject({
  pluginId: z.string().check(z.minLength(1), z.maxLength(256)),
  declaration: MachineRoleDeclarationV1Schema,
}));

/**
 * Daemon state `machineRoles`: the plugin role declarations this Machine admitted (from the plugin
 * summary, whether or not the role is on). Account readers list them beside the core roles.
 */
export const MachinePublishedMachineRolesV1Schema = lazyZodSchema(() => z.strictObject({
  plugins: z.array(PluginMachineRoleDeclarationV1Schema),
}));
export type MachinePublishedMachineRolesV1 = z.infer<typeof MachinePublishedMachineRolesV1Schema>;

/** The daemon's publication, ordered so an unchanged catalog publishes identical content. */
export function projectPublishedMachineRolesV1(plugins: readonly PluginMachineRoleDeclarationV1[]): MachinePublishedMachineRolesV1 {
  return { plugins: [...plugins].map(({ pluginId, declaration }) => ({ pluginId, declaration: { ...declaration } }))
    .sort((left, right) => `${left.pluginId}/${left.declaration.id}`.localeCompare(`${right.pluginId}/${right.declaration.id}`)) };
}

/** Plugin roles from synced (opened) daemon state; anything unreadable lists core roles only. */
export function readPublishedPluginMachineRolesV1(daemonState: unknown): PluginMachineRoleDeclarationV1[] {
  const value = daemonState && typeof daemonState === 'object' ? (daemonState as { machineRoles?: unknown }).machineRoles : undefined;
  const parsed = MachinePublishedMachineRolesV1Schema.safeParse(value);
  return parsed.success ? parsed.data.plugins : [];
}
export function machineRoleCatalogFromPluginsV1(plugins: readonly PluginMachineRoleDeclarationV1[]): MachineRoleCatalogEntryV1[] {
  return plugins.map(({ pluginId, declaration }) => ({ id: `${pluginId}/${declaration.id}`,
    ...(declaration.requires ? { requires: declaration.requires } : {}),
    ...(declaration.partOf ? { partOf: declaration.partOf } : {}),
    ...(declaration.defaultActive !== undefined ? { defaultActive: declaration.defaultActive } : {}) }));
}

export const MachineRoleListEntryV1Schema = lazyZodSchema(() => z.strictObject({
  id: MachineRoleIdV1Schema,
  title: z.string(),
  description: z.string(),
  origin: z.enum(['core', 'plugin']),
  requires: z.optional(z.array(MachineRoleIdV1Schema)),
  partOf: z.optional(CoreMachineRoleIdV1Schema),
  /** In the stored set (or the default when the field is missing). */
  selected: z.boolean(),
  /** Selected and every requirement active: the daemon runs it. */
  active: z.boolean(),
}));
export type MachineRoleListEntryV1 = z.infer<typeof MachineRoleListEntryV1Schema>;
export const MachineRolesListResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('ready'), roles: z.array(MachineRoleListEntryV1Schema), policy: MachineRolesPolicyV1Schema,
    source: z.enum(['default', 'stored']), metadataVersion: z.number().check(z.int(), z.nonnegative()) }),
  z.strictObject({ status: z.enum(['locked', 'invalid', 'unavailable']) }),
]));
export type MachineRolesListResultV1 = z.infer<typeof MachineRolesListResultV1Schema>;

/** Synced (already opened) metadata to a get result; the Account-side reader for offline Machines. */
export function readMachineRolesSnapshotFromMetadataV1(input: Readonly<{ metadata: unknown; metadataVersion: number }>): MachineRolesGetResultV1 {
  if (!Number.isSafeInteger(input.metadataVersion) || input.metadataVersion < 0) return { status: 'invalid' };
  const result = readMachineRolesV1(input.metadata);
  return result.status === 'ready' ? { ...result, metadataVersion: input.metadataVersion } : result;
}

/** The Roles catalog of one Machine: core roles, then plugin roles, each with its resolved state. */
export function projectMachineRolesListV1(input: Readonly<{ metadata: unknown; metadataVersion: number;
  plugins?: readonly PluginMachineRoleDeclarationV1[] }>): MachineRolesListResultV1 {
  const snapshot = readMachineRolesSnapshotFromMetadataV1(input);
  if (snapshot.status !== 'ready') return snapshot;
  const plugins = input.plugins ?? [];
  const active = resolveActiveMachineRolesV1(input.metadata, machineRoleCatalogFromPluginsV1(plugins));
  const selected = (id: string, defaultActive: boolean) => snapshot.source === 'stored' ? snapshot.policy.active.includes(id) : defaultActive;
  const roles: MachineRoleListEntryV1[] = [
    ...CORE_MACHINE_ROLE_DECLARATIONS_V1.map(role => ({ id: role.id, title: role.title, description: role.description,
      origin: 'core' as const, selected: selected(role.id, true), active: active.has(role.id) })),
    ...plugins.map(({ pluginId, declaration }) => {
      const id = `${pluginId}/${declaration.id}`;
      return { id, title: declaration.title, description: declaration.description, origin: 'plugin' as const,
        ...(declaration.requires ? { requires: [...declaration.requires] } : {}),
        ...(declaration.partOf ? { partOf: declaration.partOf } : {}),
        selected: declaration.partOf ? active.has(declaration.partOf) : selected(id, declaration.defaultActive === true),
        active: active.has(id) };
    }),
  ];
  return { ...snapshot, roles };
}
