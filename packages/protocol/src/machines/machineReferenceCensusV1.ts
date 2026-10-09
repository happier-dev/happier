import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { readWorkBoardArtifactV1 } from '../boards/workBoardArtifactV1.js';
import { loadAiLaunchProfileArtifacts, readAiLaunchProfileCollection, readAiLaunchProfileRecords } from '../profiles/read.js';
import type { ProfileCatalogSnapshotV1 } from '../profiles/profileCatalogV1.js';
import type { WorkflowDefinitionArtifactOperations } from '../actions/executor/workflowDefinitions.js';
import type { AutomationDefinitionListResponse } from '../automations/automationApiV3.js';
import type { MachinePoolListOutputV1 } from './pools/v1.js';

export const MachineReferenceV1Schema = lazyZodSchema(() => z.object({
  kind: z.enum(['board', 'profile', 'machine_pool', 'workflow_assignment', 'automation_assignment']),
  id: z.string().trim().min(1), name: z.string(),
}).strict().readonly());
export const MachineReferenceCensusV1Schema = lazyZodSchema(() => z.object({
  homeId: z.string().trim().min(1), machineId: z.string().trim().min(1).nullable(),
  coverage: z.enum(['complete', 'partial']), references: z.array(MachineReferenceV1Schema).readonly(),
  unavailable: z.array(z.enum(['target', 'artifacts', 'profiles', 'pools', 'assignments', 'requester_authority'])).readonly(),
}).strict().readonly());
export type MachineReferenceV1 = z.infer<typeof MachineReferenceV1Schema>;
export type MachineReferenceCensusV1 = z.infer<typeof MachineReferenceCensusV1Schema>;
export type MachineReferenceCensusPortsV1 = Readonly<{
  artifacts: Pick<WorkflowDefinitionArtifactOperations, 'read' | 'list'>;
  readSettings(): Promise<Readonly<Record<string, unknown>>>;
  readProfileCatalog?(settings: Readonly<Record<string, unknown>>): Promise<ProfileCatalogSnapshotV1>;
  readPools(): Promise<MachinePoolListOutputV1>;
  readAssignments(cursor?: string): Promise<AutomationDefinitionListResponse>;
}>;

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
  const rows: Awaited<ReturnType<MachineReferenceCensusPortsV1['artifacts']['list']>>['items'][number][] = [];
  try {
    let cursor: string | undefined;
    do {
      input.signal?.throwIfAborted();
      const page = await ports.artifacts.list({ includeBody: true, ...(cursor ? { cursor } : {}), signal: input.signal });
      if (page.coverage !== 'complete') unavailable.add('artifacts');
      rows.push(...page.items);
      if (page.nextCursor !== undefined && page.nextCursor === cursor) throw new Error('artifact_list_cursor_invalid');
      cursor = page.nextCursor;
    } while (cursor);
    for (const row of rows) {
      if (row.header.kind !== 'work-board.v1') continue;
      try {
        const board = readWorkBoardArtifactV1({ artifactId: row.artifactId, header: row.header, body: row.body ?? null });
        if (!board) { unavailable.add('artifacts'); continue; }
        if (board.source.picked.some(ref => ref.kind === 'machine' && matches(ref.qualifiedId.serverId, ref.qualifiedId.id))) {
          references.push({ kind: 'board', id: board.id, name: board.name });
        }
      } catch { unavailable.add('artifacts'); }
    }
  } catch { unavailable.add('artifacts'); }
  try {
    const settings = await ports.readSettings();
    const catalog = await ports.readProfileCatalog?.(settings);
    if (!catalog || (catalog.status !== 'ready' && catalog.status !== 'partial') || !catalog.source) throw new Error('profile_catalog_unavailable');
    if (catalog.status === 'partial') unavailable.add('profiles');
    const profileRows = catalog.source === 'destination' ? catalog.records.map(row => row.record)
      : Array.isArray(settings.profiles) ? settings.profiles : [];
    const artifactsById = await loadAiLaunchProfileArtifacts(profileRows, ports.artifacts, input.signal);
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
  try {
    const { pools } = await ports.readPools();
    for (const { pool } of pools) if (pool.members.some(member => member.machineId === input.machineId)) {
      references.push({ kind: 'machine_pool', id: pool.id, name: pool.name });
    }
  } catch { unavailable.add('pools'); }
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
  input.signal?.throwIfAborted();
  return { homeId: input.homeId, machineId: input.machineId, coverage: unavailable.size === 0 ? 'complete' : 'partial', references, unavailable: [...unavailable] };
}
