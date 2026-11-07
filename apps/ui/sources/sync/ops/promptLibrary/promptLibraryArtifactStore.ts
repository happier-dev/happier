import type {
  PromptLibraryArtifactStore,
  PromptLibraryStoredArtifact,
} from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import type { PromptArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';
import { listArtifactHeadersV1, selectArtifactHeaderPageV1 } from '@happier-dev/protocol/artifacts/artifactListSelectionV1';
import type { WorkflowDefinitionArtifactOperations } from '@happier-dev/protocol/actions';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { withActionAccountRequestSignal } from '@/sync/ops/actions/actionAccountContext';
import { awaitPendingArtifactInventory } from '@/sync/engine/artifacts/syncArtifacts';
import { encodeArtifactListCursor } from '@/sync/api/artifacts/apiArtifacts';
import type { ArtifactFolderActionPortV1 } from '@happier-dev/protocol/prompts/library/promptFolderActionsV1';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import { randomUUID } from '@/platform/randomUUID';
import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { isArtifactInventoryLoaded } from '@/sync/domains/artifacts/artifactInventory';
import { readPromptLibraryCatalogInCapturedAccount } from '@/sync/engine/settings/promptLibraryCatalogEngine';

function readCompleteAccountArtifactInventory(scope: ServerAccountScope, kinds?: readonly string[]) {
  const state = readRegisteredStorageState();
  if (!state || !isArtifactInventoryLoaded(state, kinds)
    || !areServerAccountScopesEqual(getActiveServerAccountScope(), scope)
    || !areServerAccountScopesEqual(state.settingsScope, scope)) return null;
  const rows = Object.values(state.artifacts).filter(artifact => {
    if (!kinds) return true;
    const kind = artifact.rawHeader?.kind ?? artifact.header?.kind ?? artifact.kindHint;
    // Later arrivals retain the census fact. An unknown locked row can still
    // belong to this selection; only a known different kind excludes it.
    return typeof kind !== 'string' || kinds.includes(kind);
  });
  // Loaded membership can still contain a refused matching header observation.
  if (!rows.every(artifact => artifact.isDecrypted && artifact.rawHeader && artifact.access !== undefined)) return null;
  return kinds ? rows.filter(artifact => typeof artifact.rawHeader?.kind === 'string' && kinds.includes(artifact.rawHeader.kind)) : rows;
}

/** Keep reads and the writes they derive in one exact Home/Account lifetime. */
export async function withUiPromptLibraryArtifactStore<T>(
  run: (store: PromptLibraryArtifactStore, account: LazyActionAccountContext) => Promise<T>,
  options?: Readonly<{ serverId?: string | null; expectedAccountId?: string; signal?: AbortSignal }>,
): Promise<T> {
  throwIfAborted(options?.signal);
  const serverId =
    options?.serverId?.trim() || getActiveServerAccountScope()?.serverId;
  if (!serverId)
    throw Object.assign(new Error('Prompt library Home is unavailable'), {
      code: 'content_unavailable',
    });
  const { captureLazyActionAccountContext } =
    await import('@/sync/ops/actions/actionAccountContext');
  const account = await captureLazyActionAccountContext(
    serverId,
    options?.signal,
  );
  try {
    if (options?.expectedAccountId !== undefined && options.expectedAccountId !== account.accountId)
      throw Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
    return await run(
      createUiPromptLibraryArtifactStore(account.workflowArtifacts, account),
      account,
    );
  } finally {
    account.dispose();
  }
}

/** A preparation owns these qualified reads and discards them when it finishes. */
export async function withUiPromptLibraryArtifactReader<T>(
  run: (
    reader: Readonly<{
      readArtifact(
        ref: PromptArtifactRefV1,
      ): Promise<PromptLibraryStoredArtifact | null>;
      readArtifactHeader(
        ref: PromptArtifactRefV1,
      ): Promise<Readonly<{
        header: Readonly<Record<string, unknown>> | null;
        access: PromptLibraryStoredArtifact['access'];
      }> | null>;
    }>,
  ) => Promise<T>,
  options?: Readonly<{ serverId?: string | null; signal?: AbortSignal; accountContext?: LazyActionAccountContext }>,
): Promise<T> {
  const defaultServerId =
    options?.serverId?.trim() || options?.accountContext?.serverId || getActiveServerAccountScope()?.serverId;
  const accounts = new Map<string, Promise<LazyActionAccountContext>>();
  const headers = new Map<string, Promise<Readonly<{
    header: Readonly<Record<string, unknown>>; access: PromptLibraryStoredArtifact['access'];
  }> | null>>();
  const accountFor = (ref: PromptArtifactRefV1) => {
    throwIfAborted(options?.signal);
    const serverId = ref.serverId?.trim() || defaultServerId;
    if (!serverId)
      throw Object.assign(new Error('Prompt library Home is unavailable'), {
        code: 'content_unavailable',
      });
    const borrowed = options?.accountContext;
    if (borrowed && areServerProfileIdentifiersEquivalent(serverId, borrowed.serverId)) {
      borrowed.assertCurrent();
      return { serverId: borrowed.serverId, pending: Promise.resolve(borrowed) };
    }
    let pending = accounts.get(serverId);
    if (!pending) {
      pending = import('@/sync/ops/actions/actionAccountContext').then(
        ({ captureLazyActionAccountContext }) =>
          captureLazyActionAccountContext(serverId, options?.signal),
      );
      accounts.set(serverId, pending);
    }
    return { serverId, pending };
  };
  try {
    return await run({
      readArtifact: async (ref) => {
        const { pending } = accountFor(ref);
        const account = await pending;
        return createUiPromptLibraryArtifactStore(
          account.workflowArtifacts, account,
        ).read(ref.artifactId, { signal: options?.signal });
      },
      readArtifactHeader: async (ref) => {
        const { serverId, pending } = accountFor(ref);
        const key = JSON.stringify([serverId, ref.artifactId]);
        let header = headers.get(key);
        if (!header) {
          header = pending.then(async (account) => {
            // The existing exact-read owner joins concurrent ids into its one
            // headers batch, preserving transport limits and per-id refusals.
            // The captured transport's Home-change revision excludes pre-wake
            // joins while allowing this read's concurrent requested ids to batch.
            const artifact = await account.readArtifactHeader(ref.artifactId, { signal: options?.signal });
            account.assertCurrent();
            if (!artifact) return null;
            if (!artifact.isDecrypted || !artifact.rawHeader || artifact.access === undefined)
              throw Object.assign(new Error('Artifact header is unavailable'), { code: 'content_unavailable' });
            return { header: artifact.rawHeader, access: artifact.access };
          });
          headers.set(key, header);
        }
        const artifact = await header;
        (await pending).assertCurrent();
        return artifact;
      },
    });
  } finally {
    await Promise.all(
      [...accounts.values()].map(async (pending) => {
        try {
          (await pending).dispose();
        } catch {
          /* Failed captures release their own lifetime. */
        }
      }),
    );
  }
}

/** The Action host already owns an exact Account Artifact transport and CAS. */
export function createUiPromptLibraryArtifactStore(
  artifacts: WorkflowDefinitionArtifactOperations,
  account?: LazyActionAccountContext,
): PromptLibraryArtifactStore {
  const storedArtifact = (artifact: Awaited<ReturnType<WorkflowDefinitionArtifactOperations['read']>>): PromptLibraryStoredArtifact | null => artifact ? {
    id: artifact.artifactId, revision: artifact.revision, header: artifact.header,
    body: typeof artifact.body === 'string' ? artifact.body : null,
    ...(artifact.provenance ? { provenance: artifact.provenance } : {}),
    owned: artifact.access === 'owner', access: artifact.access,
  } : null;
  const organization: ArtifactFolderActionPortV1 | undefined = account ? {
    serverId: account.serverId,
    matchesServerId: serverId => areServerProfileIdentifiersEquivalent(serverId, account.serverId),
    assertCurrent: account.assertCurrent,
    readCatalog: (signal, key = 'folders') => readPromptLibraryCatalogInCapturedAccount(account, signal, key),
    writeRecord: async (input, signal) => {
      const { writePromptLibraryRecordAndPublishInContext } = await import('@/sync/api/account/apiPromptLibraryCatalog');
      return await writePromptLibraryRecordAndPublishInContext(account, input, signal);
    },
    readArtifactHeader: async (artifactId, signal) => {
      const artifact = await account.readArtifactHeader(artifactId, { signal });
      account.assertCurrent();
      if (!artifact) return null;
      if (!artifact.isDecrypted || !artifact.rawHeader || artifact.access === undefined)
        throw Object.assign(new Error('content_unavailable'), { code: 'content_unavailable' });
      return { header: artifact.rawHeader, owned: artifact.access === 'owner' };
    },
  } : undefined;
  return {
    ...(organization ? { organization } : {}),
    ...(account ? { readMany: async (ids: readonly string[], options?: Readonly<{ signal?: AbortSignal }>) => {
      throwIfAborted(options?.signal);
      const results = await account.readArtifactContents(ids, options);
      account.assertCurrent(); throwIfAborted(options?.signal);
      return results.map(result => result.status === 'rejected' ? result
        : { status: 'fulfilled' as const, value: storedArtifact(result.value) });
    }, readHeadersByIds: async (ids: readonly string[], options?: Readonly<{ signal?: AbortSignal }>) => {
      throwIfAborted(options?.signal);
      return Promise.allSettled(ids.map(async id => {
        const artifact = await account.readArtifactHeader(id, options);
        account.assertCurrent(); throwIfAborted(options?.signal);
        if (!artifact) return null;
        if (!artifact.isDecrypted || !artifact.rawHeader || artifact.bodyVersion === undefined || artifact.access === undefined)
          throw Object.assign(new Error('content_unavailable'), { code: 'content_unavailable' });
        return { id: artifact.id, header: artifact.rawHeader, body: null,
          revision: { headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion },
          ...(artifact.provenance ? { provenance: artifact.provenance } : {}), owned: artifact.access === 'owner', access: artifact.access };
      }));
    } } : {}),
    read: async (id, options) => {
      throwIfAborted(options?.signal);
      const artifact = await (account ? account.readArtifactContent(id, options) : artifacts.read(id, options));
      return storedArtifact(artifact);
    },
    create: async (input) => {
      throwIfAborted(input.signal);
      const artifactId = randomUUID();
      if (account) {
        const created = await account.createArtifactDocument({ ...input, artifactId });
        return { artifactId: created.artifactId, revision: created.revision };
      }
      await artifacts.create({ ...input, artifactId });
      return artifactId;
    },
    update: async (input) => {
      throwIfAborted(input.signal);
      const result = await artifacts.update(input);
      if (!result.ok)
        throw Object.assign(new Error(result.error), {
          code: result.errorCode,
        });
      return { revision: result.revision };
    },
    delete: async ({ artifactId, expectedRevision, signal }) => {
      throwIfAborted(signal);
      const result = await artifacts.delete(artifactId, { expectedRevision, ...(signal ? { signal } : {}) });
      if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
    },
    list: async (options) => {
      throwIfAborted(options?.signal);
      account?.assertCurrent();
      const scope = account?.accountLifetime.scope;
      // A selective read must not wait for an unrelated full inventory scan.
      const filtered = (options?.coarseKind !== undefined || options?.kinds !== undefined) && account !== undefined;
      // Background inventory deliberately omits private attribution. Demand the
      // existing header projection when listing Skills so absence stays honest.
      const skills = options?.coarseKind === 'skill' || options?.kinds?.includes('prompt_bundle.v2');
      let rows = scope && !skills ? readCompleteAccountArtifactInventory(scope, options?.kinds) : null;
      if (!filtered && !rows && account && scope
        && areServerAccountScopesEqual(getActiveServerAccountScope(), scope)
        && areServerAccountScopesEqual(readRegisteredStorageState()?.settingsScope, scope)) {
        await withActionAccountRequestSignal(account, options?.signal, async signal => {
          await awaitPendingArtifactInventory({ scope, credentials: account.credentials, signal });
        });
        account.assertCurrent();
        throwIfAborted(options?.signal);
        rows = readCompleteAccountArtifactInventory(scope);
      }
      if (account && rows) {
        // Membership was already admitted above. Pure canonical selection does
        // not pretend these local rows are a new HTTP classification witness.
        const page = selectArtifactHeaderPageV1({
          items: rows.map(artifact => ({ artifactId: artifact.id,
            header: artifact.isDecrypted ? artifact.rawHeader ?? {} : {},
            provenance: artifact.provenance, headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion,
            createdAt: artifact.createdAt, updatedAt: artifact.updatedAt, access: artifact.access })),
          options,
          encodeCursor: item => account.encodeArtifactListCursor(item),
        });
        account.assertCurrent();
        return { items: page.items.map(item => ({ id: item.artifactId, header: item.header,
          ...(item.bodyVersion === undefined ? {} : { revision: { headerVersion: item.headerVersion, bodyVersion: item.bodyVersion } }),
          ...(item.provenance ? { provenance: item.provenance } : {}),
          updatedAtMs: item.updatedAt, owned: item.access === 'owner' })), coverage: 'complete',
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
      }
      const page = account ? await listArtifactHeadersV1({
        options: { ...options, includeBody: false },
        readPage: pageOptions => account.listArtifacts(pageOptions ?? {}),
        encodeCursor: encodeArtifactListCursor,
      }) : await artifacts.list({ ...options, includeBody: false });
      return {
        items: page.items.map((item) => ({
          id: item.artifactId,
          header: item.header,
          ...(item.bodyVersion === undefined ? {} : { revision: { headerVersion: item.headerVersion, bodyVersion: item.bodyVersion } }),
          ...(item.provenance ? { provenance: item.provenance } : {}),
          updatedAtMs: item.updatedAt,
          owned: item.access === 'owner',
        })),
        coverage: page.coverage === 'partial' || page.items.some(
          (item) => Object.keys(item.header).length === 0,
        )
          ? 'partial'
          : 'complete',
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    },
  };
}
