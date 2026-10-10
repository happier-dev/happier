import { PromptStacksV1Schema } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import type { PromptArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';
import {
  resolvePromptStackSystemAppendBlocksV1,
  PromptStackPreparationError,
  type PromptStackScopeV1,
  type PromptStackSystemAppendInputV1,
  type PromptStackSystemAppendResultV1,
} from '@happier-dev/protocol/prompts/library/resolvePromptStackSystemAppendBlocksV1';

import {
  createCredentialedAccountArtifactStore,
  ArtifactEncryptionMaterialUnavailableError,
} from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import {
  readStoredCredentialsForServerId,
  type StoredCredentials,
} from '@/persistence';
import { resolveCliHomeTarget, resolveCurrentCliHomeTarget } from '@/server/homeTarget';
import { getServerProfile } from '@/server/serverProfiles';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';

export type CliPromptLibraryArtifactReader = Required<
  Pick<PromptStackSystemAppendInputV1, 'readArtifact' | 'readArtifactHeader'>
> & Readonly<{ readScope: () => Promise<PromptStackScopeV1 | null> }>;
export type CliPromptLibraryArtifactReaderOptions = Readonly<{
  credentials?: StoredCredentials | null;
  serverId?: string | null;
  signal?: AbortSignal;
}>;
export type CliPromptStackSystemAppendInput = Omit<
  PromptStackSystemAppendInputV1,
  'readArtifact' | 'readArtifactHeader' | 'promptStacksV1'
> &
  Partial<Omit<CliPromptLibraryArtifactReader, 'readScope'>> &
  CliPromptLibraryArtifactReaderOptions &
  Readonly<{ settings?: unknown; promptStacksV1?: unknown }>;

/** Only this finite preparation retains qualified credential/store/header reads. */
export async function withCliPromptLibraryArtifactReader<T>(
  run: (reader: CliPromptLibraryArtifactReader) => Promise<T>,
  options?: CliPromptLibraryArtifactReaderOptions,
): Promise<T> {
  const activeServerId = configuration.activeServerId;
  const defaultServerId = options?.serverId?.trim() || options?.credentials?.requesterSessionCredentialScope?.serverId || activeServerId;
  const resolveTarget = (serverId: string) => serverId === activeServerId
    ? resolveCurrentCliHomeTarget()
    : resolveCliHomeTarget({ kind: 'saved_profile', profileRef: serverId });
  let boundProfileId: Promise<string | null> | undefined;
  const resolveBoundProfileId = () => boundProfileId ??= resolveTarget(defaultServerId).then((target) => target.profileId);
  const stores = new Map<
    string,
    Promise<
      Readonly<{
        serverId: string;
        serverUrl: string;
        accountId: string | null;
        store: ReturnType<typeof createCredentialedAccountArtifactStore> | null;
      }>
    >
  >();
  const headers = new Map<
    string,
    Promise<
      Awaited<
        ReturnType<
          ReturnType<typeof createCredentialedAccountArtifactStore>['list']
        >
      >
    >
  >();
  const storeForHome = (serverId: string) => {
    options?.signal?.throwIfAborted();
    let pending = stores.get(serverId);
    if (!pending) {
      pending = (async () => {
        const requesterScope = options?.credentials?.requesterSessionCredentialScope;
        if (requesterScope) {
          if (serverId !== requesterScope.serverId) throw new ArtifactEncryptionMaterialUnavailableError();
          // Exact Home was established by the private credential owner. Do not
          // consult the daemon's saved profile or another Account's credentials.
          return { serverId: requesterScope.serverId, serverUrl: requesterScope.serverHttpBaseUrl,
            accountId: readAccountIdFromToken(options.credentials!.token),
            store: createCredentialedAccountArtifactStore(options.credentials!) };
        }
        const target = await resolveTarget(serverId);
        if (!target.profileId && serverId !== activeServerId)
          throw new Error('prompt_library_home_unavailable');
        const profileId = target.profileId ? (await getServerProfile(target.profileId)).id : activeServerId;
        const useBoundCredentials = options?.credentials !== undefined && (serverId === defaultServerId
          || (target.profileId !== null && profileId === await resolveBoundProfileId()));
        const credentials =
          useBoundCredentials
            ? options?.credentials
            : await readStoredCredentialsForServerId(profileId);
        options?.signal?.throwIfAborted();
        return {
          serverId: profileId,
          serverUrl: target.applicationUrl,
          accountId: credentials ? readAccountIdFromToken(credentials.token) : null,
          store: credentials ? createCredentialedAccountArtifactStore(credentials) : null,
        };
      })();
      stores.set(serverId, pending);
    }
    return { serverId, pending };
  };
  const storeFor = (ref: PromptArtifactRefV1) => storeForHome(ref.serverId?.trim() || defaultServerId);
  return run({
    readScope: async () => {
      const { pending } = storeForHome(defaultServerId);
      const bound = await pending;
      options?.signal?.throwIfAborted();
      // Canonical Profile aliases share the existing capture rather than load
      // another Account when Protocol qualifies the formerly omitted Home.
      stores.set(bound.serverId, pending);
      return bound.accountId ? { serverId: bound.serverId, accountId: bound.accountId } : null;
    },
    readArtifact: async (ref) => {
      const { pending } = storeFor(ref);
      const { serverUrl, store } = await pending;
      if (!store) throw new ArtifactEncryptionMaterialUnavailableError();
      const artifact = await runWithServerHttpBaseUrl(serverUrl, () =>
        store.read(ref.artifactId, { signal: options?.signal }),
      );
      return artifact
        ? {
            id: artifact.artifactId,
            revision: artifact.revision,
            header: artifact.header,
            body: typeof artifact.body === 'string' ? artifact.body : null,
          }
        : null;
    },
    readArtifactHeader: async (ref) => {
      const { serverId, pending } = storeFor(ref);
      let inventory = headers.get(serverId);
      if (!inventory) {
        inventory = pending.then(({ serverUrl, store }) => {
          if (!store) throw new ArtifactEncryptionMaterialUnavailableError();
          return runWithServerHttpBaseUrl(serverUrl, () =>
            store.list({
              sort: 'title_asc',
              includeBody: false,
              signal: options?.signal,
            }),
          );
        });
        headers.set(serverId, inventory);
      }
      const page = await inventory;
      const artifact = page.items.find(
        (item) => item.artifactId === ref.artifactId,
      );
      if (!artifact && page.coverage !== 'complete')
        throw Object.assign(new Error('Artifact header inventory is unavailable'), {
          code: 'artifact_read_unavailable',
        });
      if (artifact && Object.keys(artifact.header).length === 0)
        throw new ArtifactEncryptionMaterialUnavailableError();
      return artifact ? { header: artifact.header } : null;
    },
  });
}

/** The Protocol owner composes and validates; this host only supplies transport. */
export async function resolveCliPromptStackSystemAppendBlocks(
  args: CliPromptStackSystemAppendInput,
): Promise<PromptStackSystemAppendResultV1> {
  const settings =
    args.settings &&
    typeof args.settings === 'object' &&
    !Array.isArray(args.settings)
      ? args.settings
      : {};
  const promptStacksV1 = PromptStacksV1Schema.parse(
    args.promptStacksV1 ?? Reflect.get(settings, 'promptStacksV1'),
  );
  const resolve = async (reader: CliPromptLibraryArtifactReader) => {
    let scope = args.scope;
    if (scope === undefined && (!args.readArtifact || args.credentials)) {
      try { scope = await reader.readScope(); }
      catch (error) {
        args.signal?.throwIfAborted();
        if (error instanceof PromptStackPreparationError) throw error;
        throw new PromptStackPreparationError('unavailable');
      }
      if (scope && args.profileId?.trim()) scope = { ...scope, profileId: args.profileId.trim() };
    }
    return resolvePromptStackSystemAppendBlocksV1({
      ...args,
      scope,
      promptStacksV1,
      readArtifact: args.readArtifact ?? reader.readArtifact,
      readArtifactHeader: args.readArtifact ? args.readArtifactHeader : args.readArtifactHeader ?? reader.readArtifactHeader,
    });
  };
  return withCliPromptLibraryArtifactReader(resolve, { ...args, serverId: args.scope?.serverId ?? args.serverId });
}
