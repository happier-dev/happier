import { MachineDeploymentDomainReferenceV1Schema } from './machineDeploymentDomainReferenceV1.js';
export { MachineDeploymentDomainReferenceV1Schema, type MachineDeploymentDomainReferenceV1 } from './machineDeploymentDomainReferenceV1.js';
import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { readWorkBoardArtifactV1 } from '../boards/workBoardArtifactV1.js';
import { loadAiLaunchProfileArtifacts, readAiLaunchProfileCollection, readAiLaunchProfileRecords } from '../profiles/read.js';
import type { ProfileCatalogSnapshotV1 } from '../profiles/profileCatalogV1.js';
import type { WorkflowDefinitionArtifactOperations } from '../actions/executor/workflowDefinitions.js';
import type { AutomationDefinitionListResponse } from '../automations/automationApiV3.js';
import type { MachinePoolListOutputV1 } from './pools/v1.js';

export const MachineReferenceV1Schema = lazyZodSchema(() => z.readonly(z.strictObject({
deploymentRoles: z.optional(z.readonly(z.array(z.enum(['runtime', 'data', 'retiring', 'detached', 'controller', 'build', 'edge'])))),

  kind: z.enum(['board', 'profile', 'machine_pool', 'workflow_assignment', 'automation_assignment', 'deployment_environment']),
  id: z.string().check(z.trim(), z.minLength(1)), name: z.string(),
  deploymentDomains: z.optional(z.readonly(z.array(MachineDeploymentDomainReferenceV1Schema))),
})));
export const MachineReferenceCensusV1Schema = lazyZodSchema(() => z.readonly(z.strictObject({
  homeId: z.string().check(z.trim(), z.minLength(1)), machineId: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  coverage: z.enum(['complete', 'partial']), references: z.readonly(z.array(MachineReferenceV1Schema)),
  unavailable: z.readonly(z.array(z.enum(['target', 'artifacts', 'profiles', 'pools', 'assignments', 'requester_authority']))),
})));
export type MachineReferenceV1 = z.infer<typeof MachineReferenceV1Schema>;
export type MachineReferenceCensusV1 = z.infer<typeof MachineReferenceCensusV1Schema>;
export type MachineReferenceCensusPortsV1 = Readonly<{
  artifacts: Pick<WorkflowDefinitionArtifactOperations, 'read' | 'list'> & Readonly<{
    readMany(artifactIds: readonly string[], options?: Parameters<WorkflowDefinitionArtifactOperations['read']>[1]):
      Promise<readonly Awaited<ReturnType<WorkflowDefinitionArtifactOperations['read']>>[]>;
  }>;
  readSettings(): Promise<Readonly<Record<string, unknown>>>;
  readProfileCatalog?(settings: Readonly<Record<string, unknown>>): Promise<ProfileCatalogSnapshotV1>;
  readPools(): Promise<MachinePoolListOutputV1>;
  readAssignments(cursor?: string): Promise<AutomationDefinitionListResponse>;
  readDeployments?(input: MachineDeploymentReferencesInputV1): Promise<MachineDeploymentReferencesPageV1>;
}>;

/** The exact deployment-family page reader, shared by census and reboot review. */
export async function readMachineDeploymentReferencesV1(input: Readonly<{
  homeId: string; machineId: string; signal?: AbortSignal;
}>, readPage: NonNullable<MachineReferenceCensusPortsV1['readDeployments']>): Promise<MachineDeploymentReferencesPageV1> {
  const references: MachineReferenceV1[] = [];
  let coverage: MachineDeploymentReferencesPageV1['coverage'] = 'complete';
  try {
    let cursor: string | undefined;
    do {
      input.signal?.throwIfAborted();
      const page = MachineDeploymentReferencesPageV1Schema.parse(await readPage({
        homeId: input.homeId, machineId: input.machineId, ...(cursor ? { cursor } : {}),
      }));
      if (page.homeId !== input.homeId || page.machineId !== input.machineId
        || page.references.some(reference => reference.kind !== 'deployment_environment')) throw new Error('deployment_references_target_invalid');
      if (page.coverage !== 'complete') coverage = 'partial';
      references.push(...page.references);
      if (page.nextCursor !== null && page.nextCursor === cursor) throw new Error('deployment_references_cursor_invalid');
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  } catch {
    input.signal?.throwIfAborted();
    coverage = 'partial';
  }
  return { homeId: input.homeId, machineId: input.machineId, coverage, references, nextCursor: null };
}

/** A disclosure-only projection of current owners. It never removes, repairs or retargets a reference. */
export async function readMachineReferenceCensusV1(input: Readonly<{
  homeId: string;
  machineId: string | null;
  homeAliases?: readonly string[];
  signal?: AbortSignal;
}>, ports: MachineReferenceCensusPortsV1): Promise<MachineReferenceCensusV1> {
  const references: MachineReferenceV1[] = [];
  const unavailable = new Set<MachineReferenceCensusV1['unavailable'][number]>();
  if (!input.machineId) return { homeId: input.homeId, machineId: null, coverage: 'partial', references, unavailable: ['target'] };
  const homes = new Set([input.homeId, ...(input.homeAliases ?? [])]);
  const matches = (homeId: string, machineId: string) => homes.has(homeId) && machineId === input.machineId;
  const readBoards = async () => {
    const references: MachineReferenceV1[] = [];
    try {
      let cursor: string | undefined;
      do {
        input.signal?.throwIfAborted();
        const page = await ports.artifacts.list({
          limit: 500, kind: 'work-board.v1', coarseKind: 'work_board', includeBody: true,
          ...(cursor ? { cursor } : {}), signal: input.signal,
        });
        if (page.coverage !== 'complete') unavailable.add('artifacts');
        for (const row of page.items) {
          if (row.header.kind !== 'work-board.v1') continue;
          try {
            const board = readWorkBoardArtifactV1({ artifactId: row.artifactId, header: row.header, body: row.body ?? null });
            if (!board) { unavailable.add('artifacts'); continue; }
            if (board.source.picked.some(ref => ref.kind === 'machine' && matches(ref.qualifiedId.serverId, ref.qualifiedId.id))) {
              references.push({ kind: 'board', id: board.id, name: board.name });
            }
          } catch { unavailable.add('artifacts'); }
        }
        if (page.nextCursor !== undefined && page.nextCursor === cursor) throw new Error('artifact_list_cursor_invalid');
        cursor = page.nextCursor;
      } while (cursor);
    } catch { unavailable.add('artifacts'); }
    return references;
  };
  const readProfiles = async () => {
    const references: MachineReferenceV1[] = [];
    try {
      const settings = await ports.readSettings();
      const catalog = await ports.readProfileCatalog?.(settings);
      if (!catalog || (catalog.status !== 'ready' && catalog.status !== 'partial') || !catalog.source) throw new Error('profile_catalog_unavailable');
      if (catalog.status === 'partial') unavailable.add('profiles');
      if (catalog.source === 'legacy' && settings.profiles !== undefined && !Array.isArray(settings.profiles)) unavailable.add('profiles');
      const profileRows = catalog.source === 'destination' ? catalog.records.map(row => row.record)
        : Array.isArray(settings.profiles) ? settings.profiles : [];
      const artifactsById = await loadAiLaunchProfileArtifacts(profileRows, {
        read: (artifactId, options) => ports.artifacts.read(artifactId, { ...options, fresh: true }),
        readMany: async (artifactIds, options) => {
          const rows = await ports.artifacts.readMany(artifactIds, { ...options, fresh: true });
          if (rows.some((row, index) => !row || row.artifactId !== artifactIds[index])) unavailable.add('profiles');
          return rows;
        },
        list: async options => {
          const page = await ports.artifacts.list(options);
          if (page.coverage !== 'complete') unavailable.add('profiles');
          return page;
        },
      }, input.signal);
      const profiles = catalog.source === 'destination'
        ? readAiLaunchProfileRecords(profileRows, { artifactsById, includeShared: true })
        : readAiLaunchProfileCollection(profileRows, { artifactsById, includeShared: true });
      if (profiles.diagnostics.length > 0) unavailable.add('profiles');
      for (const entry of profiles.entries) {
        if (entry.kind === 'opaque') continue;
        const placement = 'v' in entry.profile ? entry.profile.placement : undefined;
        if (placement && typeof placement === 'object' && matches(placement.fixed.serverId, placement.fixed.machineId)) {
          references.push({ kind: 'profile', id: entry.profile.id, name: entry.profile.name });
        }
      }
    } catch { unavailable.add('profiles'); }
    return references;
  };
  const readPools = async () => {
    const references: MachineReferenceV1[] = [];
    try {
      const { pools } = await ports.readPools();
      for (const { pool } of pools) if (pool.members.some(member => member.machineId === input.machineId)) {
        references.push({ kind: 'machine_pool', id: pool.id, name: pool.name });
      }
    } catch { unavailable.add('pools'); }
    return references;
  };
  const readAssignments = async () => {
    const references: MachineReferenceV1[] = [];
    try {
      let cursor: string | undefined;
      do {
        input.signal?.throwIfAborted();
        const page = await ports.readAssignments(cursor);
        for (const assignment of page.automations) if (assignment.assignments.some(member => member.machineId === input.machineId)) {
          references.push({ kind: assignment.workflowDefinitionId ? 'workflow_assignment' : 'automation_assignment', id: assignment.id, name: assignment.name });
        }
        if (page.nextCursor !== null && page.nextCursor === cursor) throw new Error('automation_list_cursor_invalid');
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
    } catch { unavailable.add('assignments'); }
    return references;
  };
  // These Account-owned sources are independent. Preserve presentation order
  // while a slow family cannot serialize the other fresh checks behind it.
  const families = await Promise.all([readBoards(), readProfiles(), readPools(), readAssignments()]);
  input.signal?.throwIfAborted();
  return { homeId: input.homeId, machineId: input.machineId, coverage: unavailable.size === 0 ? 'complete' : 'partial', references: families.flat(),
    unavailable: (['artifacts', 'profiles', 'pools', 'assignments'] as const).filter(source => unavailable.has(source)) };
}

export const MachineDeploymentReferencesPageV1Schema = lazyZodSchema(() => z.readonly(z.strictObject({
  homeId: z.string().check(z.trim(), z.minLength(1)), machineId: z.string().check(z.trim(), z.minLength(1)),
  coverage: z.enum(['complete', 'partial']), references: z.readonly(z.array(MachineReferenceV1Schema)), nextCursor: z.nullable(z.string()),
})));

export const MachineDeploymentReferencesInputV1Schema = lazyZodSchema(() => z.readonly(z.strictObject({
  homeId: z.string().check(z.trim(), z.minLength(1)), machineId: z.string().check(z.trim(), z.minLength(1)),
  cursor: z.optional(z.string().check(z.minLength(1))),
})));
export type MachineDeploymentReferencesInputV1 = z.infer<typeof MachineDeploymentReferencesInputV1Schema>;
export type MachineDeploymentReferencesPageV1 = z.infer<typeof MachineDeploymentReferencesPageV1Schema>;
