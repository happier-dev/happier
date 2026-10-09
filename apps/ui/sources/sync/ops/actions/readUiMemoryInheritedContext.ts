import type { ActionExecutorContext, MemoryInheritedContextV1, MemorySessionSnapshotV1 } from '@happier-dev/protocol/actions/executor/types';
import { readPromptLibraryCatalogRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { resolveWorkspaceRefV1, projectWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { resolveSessionWorkspaceRootForMachine } from '@happier-dev/protocol/sessions/metadata/sessionWorkspaceLocationV1';
import { readPromptLibraryCatalogProjectionInContext, writePromptLibraryRecordAndPublishInContext } from '@/sync/api/account/apiPromptLibraryCatalog';
import { createUiProjectAccountRowsClient } from '@/sync/api/projects/projectAccountRowsClient';
import { createProjectSourceActionDeps } from '@/sync/api/projects/projectSourceActions';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import type { LazyActionAccountContext } from './actionAccountContext';
import type { PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';

function pending(reason: 'project_association_unavailable' | 'project_source_unavailable'): never {
  throw Object.assign(new Error(reason), { code: 'preparation_pending', reason });
}

/** Qualified row/Source transport feeds the canonical workspace association owner. */
export async function readUiSessionProjectPromptStack(account: LazyActionAccountContext, snapshot: MemorySessionSnapshotV1,
  context: ActionExecutorContext): Promise<readonly PromptStackEntryV1[]> {
  const metadata = snapshot.metadata;
  if (metadata.workspaceId === undefined && metadata.projectId === undefined) return [];
  const workspaceId = metadata.workspaceId;
  const path = metadata.path;
  const machineId = resolveSessionMachineId(metadata);
  if (typeof workspaceId !== 'string' || !workspaceId.trim() || typeof path !== 'string' || !path.trim() || !machineId) {
    return pending('project_association_unavailable');
  }
  const root = resolveSessionWorkspaceRootForMachine({ metadata, machineId, candidatePath: path });
  let rows: Awaited<ReturnType<ReturnType<typeof createUiProjectAccountRowsClient>['read']>>;
  try { rows = await createUiProjectAccountRowsClient(account).read(context.signal); }
  catch { account.assertCurrent(); context.signal?.throwIfAborted(); return pending('project_association_unavailable'); }
  account.assertCurrent();
  const resolved = resolveWorkspaceRefV1(rows.workspaceRefs, { serverId: account.serverId, workspaceId,
    machineId, rootPath: root.machinePath });
  if (resolved.kind !== 'resolved') return pending('project_association_unavailable');
  const project = projectWorkspaceRefV1(resolved.ref);
  if (metadata.projectId !== undefined && metadata.projectId !== project.projectKey) return pending('project_association_unavailable');
  const personal = rows.organizations.find(row => row.key.serverId === account.serverId
    && row.key.projectKey === project.projectKey)?.value.promptStack ?? [];
  let shared: readonly PromptStackEntryV1[] = [];
  if (resolved.ref.source) {
    const result = await createProjectSourceActionDeps(account).projectSourcesRead({ serverId: account.serverId,
      sourceId: resolved.ref.source.sourceId }, context);
    account.assertCurrent(); context.signal?.throwIfAborted();
    if (!result.ok) return pending('project_source_unavailable');
    shared = (result.source.attachments ?? []).flatMap(attachment => attachment.purpose === 'context' ? [attachment.entry] : []);
  }
  return [...shared, ...personal].map(entry => ({ ...entry, ref: { ...entry.ref, serverId: entry.ref.serverId ?? account.serverId } }));
}

/** Destination selection stays in the shared Action owner; Account attachments use captured coding-row CAS. */
export async function readUiMemoryInheritedContext(account: LazyActionAccountContext, snapshot: MemorySessionSnapshotV1,
  context: ActionExecutorContext): Promise<MemoryInheritedContextV1> {
  account.assertCurrent(); context.signal?.throwIfAborted();
  const projectEntries = await readUiSessionProjectPromptStack(account, snapshot, context);
  return { projectEntries, readAccountContext: async () => {
    account.assertCurrent(); context.signal?.throwIfAborted();
    const projection = await readPromptLibraryCatalogProjectionInContext(account, context.signal);
    const read = readPromptLibraryCatalogRecordV1({ catalog: projection.catalog, key: 'coding', rawSettings: projection.rawSettings });
    account.assertCurrent(); context.signal?.throwIfAborted();
    if (read.status !== 'ready' || read.record.key !== 'coding') throw Object.assign(new Error('memory_target_unavailable'), {
      code: read.status === 'unavailable' ? read.reason : 'memory_target_unavailable',
    });
    const record = read.record;
    return { accountEntries: record.value.entries,
      attachAccountMemory: async ref => {
        account.assertCurrent(); context.signal?.throwIfAborted();
        if (record.value.entries.some(entry => entry.id === 'account.memory')) return false;
        const result = await writePromptLibraryRecordAndPublishInContext(account, { record: { ...record,
          value: { ...record.value, entries: [...record.value.entries,
            { id: 'account.memory', ref, enabled: true, placement: 'system_append' }] } }, expectedRevision: read.revision,
          ...(read.authority === 'inactive' ? { sourceSettingsVersion: projection.sourceSettingsVersion } : {}) }, context.signal);
        if (result.status === 'conflict' || result.status === 'settings-conflict') return false;
        if (result.status !== 'updated') throw Object.assign(new Error(result.status), { code: result.status });
        return true;
      } };
  } };
}
