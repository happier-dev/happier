import type { MemorySearchQueryV1 } from '@happier-dev/protocol/memory/memorySearch';
import { SESSION_LIST_PAGE_MAX_LIMIT } from '@happier-dev/protocol/sessions/listing/query';
import { projectSessionOwnerCompatibilityViewV1, SESSION_METADATA_LAYOUT_VERSION_V1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { MemoryDocBodyV1StoredSchema, MEMORY_ARCHIVE_TOPIC_TITLE_V1, projectMemoryDocIndexV1 } from '@happier-dev/protocol/prompts/library/memoryDocV1';
import { PromptDocBodyV1Schema } from '@happier-dev/protocol/prompts/library/promptDocV2';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { PromptStackPreparationError, resolvePromptStackSystemAppendBlocksV1 } from '@happier-dev/protocol/prompts/library/resolvePromptStackSystemAppendBlocksV1';
import type { PromptArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';
import type { PromptLibraryStoredArtifact } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { prepareSessionPromptStackInputs } from '@/agent/prompting/coding/sessionPromptStack';
import { createSessionProjectPromptStackPreparation } from '@/agent/prompting/coding/sessionProjectPromptStack';
import { withCliPromptLibraryArtifactReader } from '@/agent/prompts/library/resolveCliPromptStackSystemAppendBlocks';
import { readRequesterAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentnessObservation';
import { fetchSessionById, fetchSessionsPage, type RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { readSessionOwnerLocality, tryDecryptSessionOwnerMetadata, tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import type { StoredCredentials } from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshotLifetimeToken, isActiveAccountSettingsSnapshotLifetimeCurrent } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { logger } from '@/ui/logger';
import type { DeepIndexDbHandle, DeepIndexDocumentEntry, DeepIndexDocumentIdentity } from './deepIndex/deepIndexDb';
import { matchSessionProjectFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { readSessionAccessProjectionRoleV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { createSessionProjectKeyResolverV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { QualifiedProjectKeyV1, WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import { isServerProfileHomeIdentity, resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';
import type { MemoryDocumentIndexUpdate } from './memoryIndexerBoundary';

export type MemoryDocumentSearchScope = Readonly<{
  state: 'ready' | 'partial';
  /** Fresh authenticated membership; required for Project transcript searches. */
  eligibleSessionIds?: readonly string[];
  eligibleDocuments: readonly DeepIndexDocumentIdentity[];
  /** Same admitted documents, restricted by their decoded memory header; instructions are excluded. */
  eligibleMemoryDocuments?: readonly DeepIndexDocumentIdentity[];
  /** Only a named Session has one preparation; global admission is a union of attachments. */
  preparation?: readonly (DeepIndexDocumentIdentity & Readonly<{ loadedFactIds: readonly string[] }>)[];
  assertCurrent: () => void;
}> | Readonly<{ state: 'pending' | 'unavailable'; eligibleDocuments: readonly DeepIndexDocumentIdentity[]; eligibleSessionIds?: never }>;

export type ReadMemoryProjectContext = (projectRef: QualifiedProjectKeyV1, signal?: AbortSignal) => Promise<Readonly<{
  entries: readonly PromptStackEntryV1[]; workspaceRefs: readonly WorkspaceRefV1[];
}>>;

/** A finite fresh admission, not an access cache or a second attachment selector. */
export async function syncMemoryDocuments(params: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  scope: MemorySearchQueryV1['scope'];
  includeArchivedSessions: boolean;
  db?: DeepIndexDbHandle;
  /** The daemon retains fresh admission; the indexer owns all FTS writes. */
  writeIndex?: (update: MemoryDocumentIndexUpdate, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  assertCurrent: () => void;
  readProjectContext?: ReadMemoryProjectContext;
}>): Promise<MemoryDocumentSearchScope> {
  const startedAtMs = Date.now();
  let phaseStartedAtMs = startedAtMs;
  let phase = 'account_currentness';
  let currentSessionId = params.scope.type === 'session' ? params.scope.sessionId : undefined;
  logger.infoFile('[memoryDocuments] Admission started', {
    scopeType: params.scope.type,
    ...(params.scope.type === 'session' ? { sessionId: params.scope.sessionId } : {}),
  });
  const nextPhase = (next: string) => {
    const now = Date.now();
    logger.infoFile('[memoryDocuments] Admission phase', {
      scopeType: params.scope.type,
      ...(params.scope.type === 'session' ? { sessionId: params.scope.sessionId } : {}),
      phase, durationMs: now - phaseStartedAtMs, elapsedMs: now - startedAtMs,
    });
    phase = next;
    phaseStartedAtMs = now;
  };
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
    const accountMode = (await readRequesterAccountEncryptionCurrentness({ token: params.credentials.token, signal: params.signal })).mode;
    nextPhase('session_inventory');
    const sessions = new Map<string, RawSessionRecord>();
    if (params.scope.type === 'session') {
      const session = await fetchSessionById({ reason: 'memory-change', token: params.credentials.token, sessionId: params.scope.sessionId, signal: params.signal });
      if (session) sessions.set(session.id, session);
    }
    else {
      // Document attachments are current context, not transcript backfill/history coverage.
      for (const scope of params.includeArchivedSessions ? ['active', 'archived'] as const : ['active'] as const) {
        let cursor: string | undefined;
        const seen = new Set<string>();
        for (;;) {
          const page = await fetchSessionsPage({ token: params.credentials.token, cursor,
            ...(scope === 'archived' ? { archivedOnly: true } : { activeOnly: false }),
            limit: SESSION_LIST_PAGE_MAX_LIMIT, signal: params.signal });
          if (page.metadataUpgradeRequiredCount) throw new Error('session_inventory_incomplete');
          // Admission needs full metadata; the shared facade batches document demand
          // for each compact page instead of fetching individual Session details.
          for (const session of page.sessions) sessions.set(session.id, session);
          if (!page.hasNext) break;
          if (!page.nextCursor || seen.has(page.nextCursor)) throw new Error('session_inventory_incomplete');
          seen.add(page.nextCursor);
          cursor = page.nextCursor;
        }
      }
    }
    nextPhase('home_scope');
    return await withCliPromptLibraryArtifactReader(async reader => {
      const home = await reader.readScope();
      if (!home) throw new Error('context_source_unavailable');
      const requestedProject = params.scope.type === 'project' ? params.scope.projectRef : undefined;
      const project = requestedProject ? { ...requestedProject,
        serverId: await resolveServerProfileHomeIdentityId(requestedProject.serverId) ?? requestedProject.serverId } : undefined;
      if (project && (!await isServerProfileHomeIdentity(home.serverId, project.serverId) || !params.readProjectContext)) {
        throw new Error('context_source_unavailable');
      }
      const projectContext = project ? await params.readProjectContext!(project, params.signal) : undefined;
      const sessionProjectKeyResolver = project ? createSessionProjectKeyResolverV1(projectContext?.workspaceRefs) : undefined;
      const projectPreparation = createSessionProjectPromptStackPreparation({ credentials: params.credentials,
        serverId: home.serverId, signal: params.signal });
      const eligibleSessionIds: string[] = [];
      let partial = false;
      const projections = new Map<string, DeepIndexDocumentIdentity & { entries: readonly DeepIndexDocumentEntry[]; memory: boolean }>();
      const preparation = new Map<string, DeepIndexDocumentIdentity & { loadedFactIds: readonly string[] }>();
      const assertions: (() => void)[] = [params.assertCurrent, assertAccount];
      const reads = new Map<string, Promise<PromptLibraryStoredArtifact | null>>();
      const key = (ref: PromptArtifactRefV1) => JSON.stringify([ref.serverId ?? home.serverId, ref.artifactId]);
      const readArtifact = (ref: PromptArtifactRefV1) => {
        let read = reads.get(key(ref));
        if (!read) { read = reader.readArtifact(ref); reads.set(key(ref), read); }
        return read;
      };
      let accountCatalogRefreshed = false;
      let profileCatalogRefreshed = false;
      const admit = async (session?: RawSessionRecord) => {
        const sessionId = session?.id;
        const ownsSession = !!session && readSessionAccessProjectionRoleV1(session) === 'owner'
          && (session.ownerAccountId === undefined || session.ownerAccountId === home.accountId);
        nextPhase('session_metadata');
        currentSessionId = sessionId;
        let metadata: Record<string, unknown> | null = null;
        let machineId = params.machineId;
        if (session) {
          if (!params.includeArchivedSessions && session.archivedAt != null) return;
          if (project) {
            // The Home's accepted key is independent of owner metadata availability.
            const published = matchSessionProjectFilterV1(null, project.serverId, project, undefined,
              { projectKey: session.projectKey });
            if (published !== 'unavailable') {
              if (published === 'match') eligibleSessionIds.push(session.id);
              return;
            }
          }
          const input = { credentials: params.credentials, accountEncryptionMode: accountMode, rawSession: session };
          if (session.metadataLayoutVersion === SESSION_METADATA_LAYOUT_VERSION_V1) {
            // Context and locality are Account-owned. A historical Session's
            // shared-content key is independent and need not be available here.
            const ownerMetadata = tryDecryptSessionOwnerMetadata(input);
            metadata = ownerMetadata ? projectSessionOwnerCompatibilityViewV1({ ownerMetadata, sharedMetadata: { v: 1 } }) : null;
          } else {
            metadata = tryDecryptSessionOwnerMetadataView(input);
          }
          if (!metadata) throw Object.assign(new Error('context_source_unavailable'), {
            code: session.metadataLayoutVersion === SESSION_METADATA_LAYOUT_VERSION_V1
              ? 'session_owner_metadata_unavailable' : 'session_metadata_unavailable',
          });
          if (project) {
            const match = matchSessionProjectFilterV1(metadata, project.serverId, project,
              ownsSession ? projectContext?.workspaceRefs : undefined,
              { projectKey: session.projectKey, sessionProjectKeyResolver: ownsSession ? sessionProjectKeyResolver : undefined });
            if (match === 'unavailable') partial = true;
            if (match !== 'match') return;
            eligibleSessionIds.push(session.id);
            return;
          }
          const locality = readSessionOwnerLocality({ metadata, rawSession: session });
          if (locality?.machineId) machineId = locality.machineId;
          else if (metadata.workspaceId !== undefined || metadata.projectId !== undefined) {
            throw Object.assign(new Error('context_source_unavailable'), { code: 'session_locality_unavailable' });
          }
        }
        nextPhase('prompt_inputs');
        // Named Project admission uses only that Project's attachments. A matching
        // Session does not relabel its Account/Profile/Bot context as Project docs.
        const prepared = project ? null : await prepareSessionPromptStackInputs({ credentials: params.credentials, metadata, sessionId,
          machineId, directory: typeof metadata?.path === 'string' ? metadata.path : undefined,
          serverId: home.serverId, signal: params.signal, accountContext, projectPreparation,
          ...(!ownsSession ? { projectEntries: [] } : {}),
          refreshCatalogs: !accountCatalogRefreshed || (typeof metadata?.profileId === 'string' && !profileCatalogRefreshed) });
        // Currentness assertions and invalidation still run for every Session;
        // a finite admission shares the fresh Account/Profile catalog reads.
        accountCatalogRefreshed = true;
        if (prepared?.profileId) profileCatalogRefreshed = true;
        if (prepared && prepared.scope?.accountId !== home.accountId) throw new Error('context_source_unavailable');
        if (prepared) assertions.push(prepared.assertCurrentAccount);
        nextPhase('prompt_admission');
        const inventory = await resolvePromptStackSystemAppendBlocksV1({ ...prepared,
          ...(project ? { projectEntries: projectContext?.entries ?? [] } : {}),
          scope: { ...prepared?.scope, ...home, ...(project ? { projectKey: project.projectKey } : {}), ...(sessionId ? { sessionId } : {}) }, surface: 'coding',
          memoryEnabled: sessionId ? prepared?.memoryEnabled ?? true : true,
          readArtifact, readArtifactHeader: reader.readArtifactHeader, signal: params.signal });
        prepared?.assertCurrentAccount();
        // A missing named Project attachment is incomplete coverage, including
        // after revocation. Optional preparation may skip it for other scopes.
        const incomplete = inventory.admittedEntries.find(entry => entry.outcome === 'unavailable'
          && (project || entry.reason === 'unavailable'));
        if (incomplete?.outcome === 'unavailable') throw new PromptStackPreparationError(incomplete.reason, incomplete.ref);
        nextPhase('artifact_projection');
        for (const admitted of inventory.admittedEntries) {
          if (admitted.ref.kind !== 'doc' || admitted.outcome === 'unavailable') continue;
          const artifact = await readArtifact(admitted.ref);
          if (!artifact || !artifact.body) throw new Error('context_source_unavailable');
          const body: unknown = JSON.parse(artifact.body);
          if (params.scope.type === 'session' && admitted.memory) {
            const previous = preparation.get(key(admitted.ref));
            preparation.set(key(admitted.ref), {
              ref: { serverId: admitted.ref.serverId ?? home.serverId, artifactId: admitted.ref.artifactId },
              revision: admitted.revision,
              loadedFactIds: [...new Set([...(previous?.loadedFactIds ?? []), ...admitted.memory.loadedFactIds])],
            });
          }
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
            revision: admitted.revision, entries, memory: artifact.header?.kind === 'memory_doc.v1' });
        }
      };
      if (params.scope.type === 'global' || project) await admit();
      for (const session of sessions.values()) {
        if (!project) { await admit(session); continue; }
        // Membership is independent of document availability. Unknown metadata
        // excludes this Session while preserving other proven Project results.
        try { await admit(session); }
        catch { params.signal?.throwIfAborted(); partial = true; }
      }
      const assertCurrent = () => {
        params.signal?.throwIfAborted();
        for (const assert of assertions) assert();
      };
      await projectPreparation.assertCurrent();
      assertCurrent();
      const eligibleDocuments = [...projections.values()].map(({ ref, revision }) => ({ ref, revision }));
      const eligibleMemoryDocuments = [...projections.values()].filter(document => document.memory)
        .map(({ ref, revision }) => ({ ref, revision }));
      if (params.writeIndex) {
        await params.writeIndex({ documents: [...projections.values()], prune: params.scope.type === 'global' }, params.signal);
        assertCurrent();
      } else {
        if (!params.db) throw new Error('memory_document_index_unavailable');
        for (const projection of projections.values()) params.db.replaceDocumentIndexData(projection);
        // A single Session cannot revoke another Session's attached document projection.
        if (params.scope.type === 'global') params.db.pruneDocumentIndexData({ eligibleDocuments });
      }
      nextPhase('complete');
      return { state: partial ? 'partial' : 'ready', eligibleDocuments, eligibleMemoryDocuments, assertCurrent,
        ...(project ? { eligibleSessionIds } : {}),
        ...(params.scope.type === 'session' ? { preparation: [...preparation.values()] } : {}) };
    }, { credentials: params.credentials, signal: params.signal });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    const cause: unknown = error instanceof Error ? error.cause : undefined;
    const causeCode = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
    const abortReason: unknown = params.signal?.reason;
    const abortCode = abortReason && typeof abortReason === 'object' && 'code' in abortReason ? abortReason.code : undefined;
    const knownCodes = new Set(['RPC_REQUEST_TIMEOUT', 'ERR_CANCELED', 'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET',
      'ETIMEDOUT', 'account_encryption_currentness_unavailable', 'account_storage_currentness_unavailable', 'context_source_unavailable',
      'session_owner_metadata_unavailable', 'session_metadata_unavailable', 'session_locality_unavailable']);
    logger.infoFile('[memoryDocuments] Admission failed', {
      scopeType: params.scope.type,
      ...(currentSessionId ? { sessionId: currentSessionId } : {}),
      phase, durationMs: Date.now() - phaseStartedAtMs, elapsedMs: Date.now() - startedAtMs,
      cancelled: params.signal?.aborted === true,
      errorCode: typeof code === 'string' && knownCodes.has(code) ? code : 'unclassified',
      ...(typeof causeCode === 'string' && knownCodes.has(causeCode) ? { causeCode } : {}),
      ...(typeof abortCode === 'string' && knownCodes.has(abortCode) ? { abortCode } : {}),
    });
    params.signal?.throwIfAborted();
    // Incomplete admission must never disclose cached text or prune a partial global inventory.
    const pending = error instanceof Error && ('status' in error && error.status === 'preparation_pending');
    return { state: pending ? 'pending' : 'unavailable', eligibleDocuments: [] };
  }
}
