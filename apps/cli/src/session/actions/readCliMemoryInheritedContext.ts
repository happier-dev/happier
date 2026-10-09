import type { ActionExecutorContext, ActionExecutorDeps, MemoryInheritedContextV1, MemorySessionSnapshotV1, MemoryScopeContextV1, MemoryScopeTargetV1 } from '@happier-dev/protocol/actions/executor/types';
import { readProjectContextAttachmentTargetV1 } from '@happier-dev/protocol/projects/projectContextV1';
import type { ActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { readPromptLibraryCatalogRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { resolveSessionProjectPromptStack } from '@/agent/prompting/coding/sessionProjectPromptStack';
import { createCliPromptLibraryStore } from '@/settings/prompts/promptLibraryStore';
import { refreshActivePromptLibraryCatalogAfterChange } from '@/settings/prompts/hydratePromptLibraryCatalog';
import { getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { StoredCredentials } from '@/persistence';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

/** Transport and captured row CAS only; the shared Action owner chooses the destination. */
export async function readCliMemoryInheritedContext(input: Readonly<{
  credentials: StoredCredentials; serverId: string; snapshot: MemorySessionSnapshotV1; context: ActionExecutorContext;
}>): Promise<MemoryInheritedContextV1> {
  const { credentials, serverId, snapshot, context } = input;
  const machineId = snapshot.machineId
    ?? (typeof snapshot.metadata.machineId === 'string' ? snapshot.metadata.machineId.trim() : '');
  const projectEntries = await resolveSessionProjectPromptStack({ credentials, serverId,
    metadata: snapshot.metadata, machineId, signal: context.signal });
  const readAccountContext = createCliMemoryAccountContextReader({ credentials, context });
  return { projectEntries, readAccountContext: async () => {
    const account = await readAccountContext();
    return { accountEntries: account.entries, attachAccountMemory: account.attachMemory };
  } };
}

function createCliMemoryAccountContextReader(input: Readonly<{
  credentials: StoredCredentials; context: ActionExecutorContext;
}>): () => Promise<MemoryScopeContextV1> {
  const { credentials, context } = input;
  // Capture the exact Home and incumbent lifetime while this finite host read is bound.
  // Constructing the store is inert; Account I/O only begins if the Action demands it.
  const serverHttpBaseUrl = resolveServerHttpBaseUrl();
  const store = createCliPromptLibraryStore({ credentials, signal: context.signal });
  const scopeKey = resolveAccountSettingsScopeKey(credentials);
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  return async () => {
    const catalog = await store.readPromptLibraryCatalog();
    const absent = (catalog.status === 'ready' || catalog.status === 'partial')
      && !catalog.rows.some(row => row.record.key === 'coding')
      && !catalog.tombstones.some(row => row.key === 'coding')
      && !catalog.diagnostics.some(row => row.key === 'coding');
    const source = absent ? await store.readSourceSnapshot() : null;
    const read = readPromptLibraryCatalogRecordV1({ catalog, key: 'coding', ...(source ? { rawSettings: source.raw } : {}) });
    store.assertCurrent();
    if (read.status !== 'ready' || read.record.key !== 'coding') throw Object.assign(new Error('memory_target_unavailable'), {
      code: read.status === 'unavailable' ? read.reason : 'memory_target_unavailable',
    });
    const record = read.record;
    return { entries: record.value.entries, safety: 'safe',
      attachMemory: async ref => {
        store.assertCurrent();
        if (record.value.entries.some(entry => entry.id === 'account.memory')) return false;
        const result = await store.writeRecord({ record: { ...record, value: { ...record.value, entries: [...record.value.entries,
          { id: 'account.memory', ref, enabled: true, placement: 'system_append' }] } }, expectedRevision: read.revision,
          ...(source ? { sourceSettingsVersion: source.version } : {}) });
        if (result.status === 'conflict' || result.status === 'settings-conflict') return false;
        if (result.status !== 'updated') throw Object.assign(new Error(result.status), { code: result.status });
        try { await runWithServerHttpBaseUrl(serverHttpBaseUrl, () =>
          refreshActivePromptLibraryCatalogAfterChange({ credentials, scopeKey, lifetimeToken })); }
        catch { /* The durable attachment receipt survives a failed projection refresh. */ }
        return true;
      } };
  };
}

/** Scope transport delegates attachment semantics to the existing Project/Source Action owners. */
export async function readCliMemoryScopeContext(input: Readonly<{
  credentials: StoredCredentials; serverId: string; target: MemoryScopeTargetV1; context: ActionExecutorContext;
  readProjectRows(): Promise<ActiveProjectAccountRowsSnapshot>;
  projectsContextUpdate: NonNullable<ActionExecutorDeps['projectsContextUpdate']>;
  projectSourcesRead: NonNullable<ActionExecutorDeps['projectSourcesRead']>;
  projectSourcesUpdate: NonNullable<ActionExecutorDeps['projectSourcesUpdate']>;
}>): Promise<MemoryScopeContextV1> {
  const { target, context } = input;
  if (target.scope === 'account') return createCliMemoryAccountContextReader(input)();
  if (target.projectRef.serverId !== input.serverId) throw Object.assign(new Error('server_target_mismatch'), { code: 'server_target_mismatch' });
  const project = await readProjectContextAttachmentTargetV1({ readRows: input.readProjectRows,
    readSource: request => input.projectSourcesRead(request, context),
    updateSource: request => input.projectSourcesUpdate(request, context),
    updatePersonalContext: request => input.projectsContextUpdate(request, context),
  }, target.projectRef);
  return { entries: project.entries, safety: project.safety,
    attachMemory: ref => project.attach({ id: 'project.memory', ref, enabled: true, placement: 'system_append' }) };
}
