import type {
  PromptLibraryArtifactStore,
  PromptLibraryStoredArtifact,
} from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import type { PromptArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';
import { listArtifactHeadersV1 } from '@happier-dev/protocol/artifacts/artifactListSelectionV1';
import type { WorkflowDefinitionArtifactOperations } from '@happier-dev/protocol/actions';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import type { ArtifactFolderActionPortV1 } from '@happier-dev/protocol/prompts/library/promptFolderActionsV1';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import { randomUUID } from '@/platform/randomUUID';

/** Keep reads and the writes they derive in one exact Home/Account lifetime. */
export async function withUiPromptLibraryArtifactStore<T>(
  run: (store: PromptLibraryArtifactStore, account: LazyActionAccountContext) => Promise<T>,
  options?: Readonly<{ serverId?: string | null; signal?: AbortSignal }>,
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
  const headers = new Map<
    string,
    Promise<Readonly<{ items: ReadonlyMap<string, Readonly<{ header: Readonly<Record<string, unknown>>; access: PromptLibraryStoredArtifact['access'] }>>; coverage: 'complete' | 'partial' }>>
  >();
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
        return createUiPromptLibraryArtifactStore(
          (await pending).workflowArtifacts,
        ).read(ref.artifactId, { signal: options?.signal });
      },
      readArtifactHeader: async (ref) => {
        const { serverId, pending } = accountFor(ref);
        let inventory = headers.get(serverId);
        if (!inventory) {
          inventory = pending.then(async (account) => {
            const page = await listArtifactHeadersV1({
              options: { includeBody: false, signal: options?.signal },
              readPage: (options) => account.listArtifacts(options ?? {}),
              encodeCursor: (item) =>
                account.encodeArtifactListCursor({
                  artifactId: item.artifactId,
                  updatedAt: item.updatedAt,
                }),
            });
            account.assertCurrent();
            return { items: new Map(page.items.map((item) => [item.artifactId, { header: item.header, access: item.access }])), coverage: page.coverage };
          });
          headers.set(serverId, inventory);
        }
        const page = await inventory;
        const artifact = page.items.get(ref.artifactId);
        (await pending).assertCurrent();
        if (!artifact) {
          if (page.coverage !== 'complete') throw Object.assign(new Error('Artifact header inventory is incomplete'), { code: 'artifact_read_unavailable' });
          return null;
        }
        if (Object.keys(artifact.header).length === 0)
          throw Object.assign(new Error('Artifact header is locked'), {
            code: 'content_unavailable',
          });
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
  const organization: ArtifactFolderActionPortV1 | undefined = account ? {
    serverId: account.serverId,
    matchesServerId: serverId => areServerProfileIdentifiersEquivalent(serverId, account.serverId),
    assertCurrent: account.assertCurrent,
    readCatalog: async signal => {
      const { refreshPromptLibraryCatalog } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
      const { getPromptLibraryCatalogSnapshot } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
      throwIfAborted(signal);
      account.assertCurrent();
      // The catalog loader publishes readable authority before retained-source/history maintenance,
      // and owns the Account lifetime until that maintenance settles. Actions share that read owner.
      const scope = { serverId: account.serverId, accountId: account.accountId };
      await refreshPromptLibraryCatalog(scope);
      throwIfAborted(signal);
      account.assertCurrent();
      const projection = getPromptLibraryCatalogSnapshot(scope);
      if (!projection) throw new Error('Artifact folder catalog is unavailable');
      return projection;
    },
    writeRecord: async (input, signal) => {
      const { writePromptLibraryRecordAndPublishInContext } = await import('@/sync/api/account/apiPromptLibraryCatalog');
      return await writePromptLibraryRecordAndPublishInContext(account, input, signal);
    },
    readArtifactHeader: async (artifactId, signal) => {
      const inventory = await organization!.listArtifactHeaders(signal);
      account.assertCurrent();
      const artifact = inventory.items.find(item => item.artifactId === artifactId);
      if (!artifact) {
        if (inventory.coverage !== 'complete') throw Object.assign(new Error('artifact_inventory_incomplete'), { code: 'artifact_inventory_incomplete' });
        return null;
      }
      if (Object.keys(artifact.header).length === 0) throw Object.assign(new Error('content_unavailable'), { code: 'content_unavailable' });
      return { header: artifact.header, owned: artifact.owned };
    },
    listArtifactHeaders: async signal => {
      const page = await listArtifactHeadersV1({ options: { includeBody: false, signal },
        readPage: options => account.listArtifacts(options ?? {}),
        encodeCursor: item => account.encodeArtifactListCursor({ artifactId: item.artifactId, updatedAt: item.updatedAt }) });
      account.assertCurrent();
      return { items: page.items.map(item => ({ artifactId: item.artifactId, header: item.header, owned: item.access === 'owner' })),
        coverage: page.nextCursor ? 'partial' : page.coverage };
    },
  } : undefined;
  return {
    ...(organization ? { organization } : {}),
    read: async (id, options) => {
      throwIfAborted(options?.signal);
      const artifact = await artifacts.read(id, options);
      return artifact
        ? {
            id: artifact.artifactId,
            revision: artifact.revision,
            header: artifact.header,
            body: typeof artifact.body === 'string' ? artifact.body : null,
            owned: artifact.access === 'owner',
            access: artifact.access,
          }
        : null;
    },
    create: async (input) => {
      throwIfAborted(input.signal);
      const artifactId = randomUUID();
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
    list: async (options) => {
      throwIfAborted(options?.signal);
      const page = await artifacts.list({ ...options, includeBody: false });
      return {
        items: page.items.map((item) => ({
          id: item.artifactId,
          header: item.header,
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
