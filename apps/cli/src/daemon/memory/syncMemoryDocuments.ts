import type { MemorySearchQueryV1 } from '@happier-dev/protocol/memory/memorySearch';
import { MemoryDocBodyV1StoredSchema, MEMORY_ARCHIVE_TOPIC_TITLE_V1, projectMemoryDocIndexV1 } from '@happier-dev/protocol/prompts/library/memoryDocV1';
import { PromptDocBodyV1Schema } from '@happier-dev/protocol/prompts/library/promptDocV2';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { resolvePromptStackSystemAppendBlocksV1 } from '@happier-dev/protocol/prompts/library/resolvePromptStackSystemAppendBlocksV1';
import type { PromptArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';
import type { PromptLibraryStoredArtifact } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { prepareSessionPromptStackInputs } from '@/agent/prompting/coding/sessionPromptStack';
import { withCliPromptLibraryArtifactReader } from '@/agent/prompts/library/resolveCliPromptStackSystemAppendBlocks';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { readSessionOwnerLocality, tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchSessionInventoryPage } from '@/daemon/sessions/sessionInventoryVisibility';
import type { StoredCredentials } from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshotLifetimeToken, isActiveAccountSettingsSnapshotLifetimeCurrent } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { DeepIndexDbHandle, DeepIndexDocumentEntry, DeepIndexDocumentIdentity } from './deepIndex/deepIndexDb';

export type MemoryDocumentSearchScope = Readonly<{
  state: 'ready';
  eligibleDocuments: readonly DeepIndexDocumentIdentity[];
  assertCurrent: () => void;
}> | Readonly<{ state: 'pending' | 'unavailable'; eligibleDocuments: readonly DeepIndexDocumentIdentity[] }>;

/** A finite fresh admission, not an access cache or a second attachment selector. */
export async function syncMemoryDocuments(params: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  scope: MemorySearchQueryV1['scope'];
  includeArchivedSessions: boolean;
  db: DeepIndexDbHandle;
  signal?: AbortSignal;
  assertCurrent: () => void;
}>): Promise<MemoryDocumentSearchScope> {
  // Bind before the first HTTP read: returning to the same Account is a new lifetime.
  const accountContext = { scopeKey: resolveAccountSettingsScopeKey(params.credentials),
    lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(), settings: null };
  const assertAccount = () => {
    if (!isActiveAccountSettingsSnapshotLifetimeCurrent(accountContext)) {
      throw Object.assign(new Error('context_source_unavailable'), { status: 'preparation_pending' });
    }
  };
  try {
    params.signal?.throwIfAborted();
    assertAccount();
    const accountMode = (await fetchAccountEncryptionCurrentness({ token: params.credentials.token, signal: params.signal })).mode;
    const sessionIds = new Set<string>();
    if (params.scope.type === 'session') sessionIds.add(params.scope.sessionId);
    else {
      // Document attachments are current context, not transcript backfill/history coverage.
      for (const scope of params.includeArchivedSessions ? ['active', 'archived'] as const : ['active'] as const) {
        let cursor: string | undefined;
        const seen = new Set<string>();
        for (;;) {
          const page = await fetchSessionInventoryPage({ token: params.credentials.token, scope, cursor, signal: params.signal });
          for (const session of page.sessions) sessionIds.add(session.id);
          if (!page.hasNext) break;
          if (!page.nextCursor || seen.has(page.nextCursor)) throw new Error('session_inventory_incomplete');
          seen.add(page.nextCursor);
          cursor = page.nextCursor;
        }
      }
    }
    return await withCliPromptLibraryArtifactReader(async reader => {
      const home = await reader.readScope();
      if (!home) throw new Error('context_source_unavailable');
      const projections = new Map<string, DeepIndexDocumentIdentity & { entries: readonly DeepIndexDocumentEntry[] }>();
      const assertions: (() => void)[] = [params.assertCurrent, assertAccount];
      const reads = new Map<string, Promise<PromptLibraryStoredArtifact | null>>();
      const key = (ref: PromptArtifactRefV1) => JSON.stringify([ref.serverId ?? home.serverId, ref.artifactId]);
      const readArtifact = (ref: PromptArtifactRefV1) => {
        let read = reads.get(key(ref));
        if (!read) { read = reader.readArtifact(ref); reads.set(key(ref), read); }
        return read;
      };
      const admit = async (sessionId?: string) => {
        let metadata: Record<string, unknown> | null = null;
        let machineId = params.machineId;
        if (sessionId) {
          const session = await fetchSessionById({ token: params.credentials.token, sessionId, signal: params.signal });
          if (!session) return;
          if (!params.includeArchivedSessions && session.archivedAt != null) return;
          metadata = tryDecryptSessionOwnerMetadataView({ credentials: params.credentials, accountEncryptionMode: accountMode, rawSession: session });
          if (!metadata) throw new Error('context_source_unavailable');
          const locality = readSessionOwnerLocality({ metadata, rawSession: session });
          if (locality?.machineId) machineId = locality.machineId;
          else if (metadata.workspaceId !== undefined || metadata.projectId !== undefined) throw new Error('context_source_unavailable');
        }
        const prepared = await prepareSessionPromptStackInputs({ credentials: params.credentials, metadata, sessionId,
          machineId, directory: typeof metadata?.path === 'string' ? metadata.path : undefined,
          serverId: home.serverId, signal: params.signal, refreshCatalogs: true, accountContext });
        if (prepared.scope?.accountId !== home.accountId) throw new Error('context_source_unavailable');
        assertions.push(prepared.assertCurrentAccount);
        const inventory = await resolvePromptStackSystemAppendBlocksV1({ ...prepared,
          scope: { ...prepared.scope, ...home, ...(sessionId ? { sessionId } : {}) }, surface: 'coding',
          memoryEnabled: sessionId ? prepared.memoryEnabled : true,
          readArtifact, readArtifactHeader: reader.readArtifactHeader, signal: params.signal });
        prepared.assertCurrentAccount();
        for (const admitted of inventory.admittedEntries) {
          if (admitted.ref.kind !== 'doc' || admitted.outcome === 'unavailable') continue;
          const artifact = await readArtifact(admitted.ref);
          if (!artifact || !artifact.body) throw new Error('context_source_unavailable');
          const body: unknown = JSON.parse(artifact.body);
          const entries: DeepIndexDocumentEntry[] = artifact.header?.kind === 'memory_doc.v1'
            ? (() => {
              const stored = MemoryDocBodyV1StoredSchema.parse(body);
              const indexFactIds = new Set(projectMemoryDocIndexV1(stored, Date.now()).index.map(fact => fact.id));
              return [
                ...stored.index.map(fact => ({ factId: fact.id, text: fact.text,
                  location: indexFactIds.has(fact.id) ? 'facts' as const : 'archive' as const })),
                ...stored.topics.flatMap(topic => topic.facts.map(fact => ({ factId: fact.id, text: fact.text,
                  location: topic.title === MEMORY_ARCHIVE_TOPIC_TITLE_V1 ? 'archive' as const : { type: 'topic' as const, title: topic.title } }))),
              ];
            })()
            : [{ location: 'document', text: createStoredReadSchema(PromptDocBodyV1Schema).parse(body).markdown }];
          projections.set(key(admitted.ref), { ref: { serverId: admitted.ref.serverId ?? home.serverId, artifactId: admitted.ref.artifactId },
            revision: admitted.revision, entries });
        }
      };
      if (params.scope.type === 'global') await admit();
      for (const id of sessionIds) await admit(id);
      const assertCurrent = () => {
        params.signal?.throwIfAborted();
        for (const assert of assertions) assert();
      };
      assertCurrent();
      const eligibleDocuments = [...projections.values()].map(({ ref, revision }) => ({ ref, revision }));
      for (const projection of projections.values()) params.db.replaceDocumentIndexData(projection);
      // A single Session cannot revoke another Session's attached document projection.
      if (params.scope.type === 'global') params.db.pruneDocumentIndexData({ eligibleDocuments });
      return { state: 'ready', eligibleDocuments, assertCurrent };
    }, { credentials: params.credentials, signal: params.signal });
  } catch (error) {
    params.signal?.throwIfAborted();
    // Incomplete admission must never disclose cached text or prune a partial global inventory.
    const pending = error instanceof Error && ('status' in error && error.status === 'preparation_pending');
    return { state: pending ? 'pending' : 'unavailable', eligibleDocuments: [] };
  }
}
