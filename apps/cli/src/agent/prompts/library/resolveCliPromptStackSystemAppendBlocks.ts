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
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import {
  readStoredCredentialsForServerId,
  sameStoredCredentials,
  type StoredCredentials,
} from '@/persistence';
import { resolveCliHomeTarget, resolveCurrentCliHomeTarget } from '@/server/homeTarget';
import { getServerProfile, isServerProfileHomeIdentity } from '@/server/serverProfiles';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { HomeTargetResolutionError } from '@happier-dev/cli-common/homeTarget';
import { logger } from '@/ui/logger';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { recordPromptPreparationFailure, classifyHomeReadPreparationError } from './homeReadPreparationError';

const promptReadErrorCodes = new Set([
  'artifact_read_unavailable', 'artifact_read_invalid', 'artifact_encryption_material_unavailable',
  'artifact_account_mode_mismatch', 'account_encryption_mode_unavailable', 'artifact_content_unavailable',
  'content_unavailable', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'ERR_NETWORK',
]);

export type CliPromptLibraryArtifactReader = Required<
  Pick<PromptStackSystemAppendInputV1, 'readArtifact' | 'readArtifactHeader'>
> & Readonly<{ readScope: () => Promise<PromptStackScopeV1 | null> }>;
export type CliPromptLibraryArtifactReaderOptions = Readonly<{
  credentials?: StoredCredentials | null;
  serverId?: string | null;
  signal?: AbortSignal;
  operationContext?: SavedSecretOperationContextV1;
}>;
export type CliPromptStackSystemAppendInput = Omit<
  PromptStackSystemAppendInputV1,
  'readArtifact' | 'readArtifactHeader' | 'readScope' | 'promptStacksV1'
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
  const activeServerHttpBaseUrl = resolveServerHttpBaseUrl();
  const defaultServerId = options?.serverId?.trim() || options?.credentials?.requesterSessionCredentialScope?.serverId || activeServerId;
  const resolveTarget = (serverId: string) => serverId === activeServerId
    ? resolveCurrentCliHomeTarget()
    : resolveCliHomeTarget({ kind: 'saved_profile', profileRef: serverId });
  const assertOperationCurrent = async () => {
    options?.signal?.throwIfAborted();
    const operation = options?.operationContext;
    if (operation && (!options?.credentials || !sameStoredCredentials(operation.credentials, options.credentials)
      || !await operation.isCurrent())) throw new ArtifactEncryptionMaterialUnavailableError();
  };
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
          ReturnType<typeof createCredentialedAccountArtifactStore>['readHeader']
        >
      >
    >
  >();
  const headerReaders = new Map<string, ReturnType<
    ReturnType<typeof createCredentialedAccountArtifactStore>['createHeaderReader']
  >>();
  const storeForHome = (serverId: string) => {
    options?.signal?.throwIfAborted();
    let pending = stores.get(serverId);
    if (!pending) {
      pending = (async () => {
        const operation = options?.operationContext;
        if (operation) {
          await assertOperationCurrent();
          if (!await isServerProfileHomeIdentity(defaultServerId, serverId)) throw new ArtifactEncryptionMaterialUnavailableError();
          // The captured invocation owns transport and Account credentials. Saved
          // profiles only resolve same-Home aliases; they never supply private material.
          return { serverId, serverUrl: operation.serverHttpBaseUrl,
            accountId: readAccountIdFromToken(operation.credentials.token),
            store: createCredentialedAccountArtifactStore(operation.credentials) };
        }
        const requesterScope = options?.credentials?.requesterSessionCredentialScope;
        if (requesterScope) {
          if (!await isServerProfileHomeIdentity(requesterScope.serverId, serverId)) throw new ArtifactEncryptionMaterialUnavailableError();
          // Exact Home was established by the private credential owner. Do not
          // use another Account's credentials; saved bindings only prove aliases.
          return { serverId: requesterScope.serverId, serverUrl: requesterScope.serverHttpBaseUrl,
            accountId: readAccountIdFromToken(options.credentials!.token),
            store: createCredentialedAccountArtifactStore(options.credentials!) };
        }
        const target = await resolveTarget(serverId);
        if (!target.profileId && serverId !== activeServerId)
          throw new Error('prompt_library_home_unavailable');
        const profileId = target.profileId ? (await getServerProfile(target.profileId)).id : activeServerId;
        const isBoundHome = await isServerProfileHomeIdentity(defaultServerId, serverId);
        const useBoundCredentials = options?.credentials !== undefined && isBoundHome;
        const credentials =
          useBoundCredentials
            ? options?.credentials
            : await readStoredCredentialsForServerId(profileId);
        options?.signal?.throwIfAborted();
        return {
          serverId: profileId,
          // Saved profiles establish Home/Account identity. The current Home's
          // admitted invocation/runtime route is owned by session transport.
          serverUrl: profileId === activeServerId && isBoundHome ? activeServerHttpBaseUrl : target.applicationUrl,
          accountId: credentials ? readAccountIdFromToken(credentials.token) : null,
          store: credentials ? createCredentialedAccountArtifactStore(credentials) : null,
        };
      })();
      stores.set(serverId, pending);
    }
    return { serverId, pending };
  };
  const storeFor = (ref: PromptArtifactRefV1) => storeForHome(ref.serverId?.trim() || defaultServerId);
  const read = async <T>(operation: 'scope' | 'artifact' | 'header', ref: PromptArtifactRefV1 | undefined,
    load: () => Promise<T>): Promise<T> => {
    try {
      await assertOperationCurrent();
      const result = await load();
      await assertOperationCurrent();
      return result;
    }
    catch (error) {
      recordPromptPreparationFailure(operation === 'scope' ? 'artifact.scope' : operation === 'header' ? 'artifact.header' : 'artifact', error);
      options?.signal?.throwIfAborted();
      const code: unknown = error && typeof error === 'object'
        ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
      const status: unknown = error && typeof error === 'object'
        ? Object.getOwnPropertyDescriptor(error, 'status')?.value : undefined;
      // Never carry raw error text, HTTP payload/config, credentials, refs or Account ids into diagnostics.
      logger.infoFile('Prompt library read failed', {
        operation,
        errorCode: error instanceof HomeTargetResolutionError ? error.code
          : typeof code === 'string' && promptReadErrorCodes.has(code) ? code : 'unclassified',
        httpStatus: typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
        qualifiedHome: Boolean(ref?.serverId),
        privateRequester: Boolean(options?.credentials?.requesterSessionCredentialScope),
      });
      if (error instanceof HomeTargetResolutionError) {
        // Keep the typed configuration cause across Protocol preparation without
        // publishing the private Home/reference carried in its error text.
        const reason = operation !== 'scope' && error.code === 'profile_missing' ? 'not_found' : 'unavailable';
        throw Object.assign(new PromptStackPreparationError(reason, ref), { cause: error });
      }
      throw classifyHomeReadPreparationError(error, ref);
    }
  };
  return run({
    readScope: async () => read('scope', undefined, async () => {
      const { pending } = storeForHome(defaultServerId);
      const bound = await pending;
      options?.signal?.throwIfAborted();
      // Canonical Profile aliases share the existing capture rather than load
      // another Account when Protocol qualifies the formerly omitted Home.
      stores.set(bound.serverId, pending);
      return bound.accountId ? { serverId: bound.serverId, accountId: bound.accountId } : null;
    }),
    readArtifact: async (ref) => read('artifact', ref, async () => {
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
    }),
    readArtifactHeader: async (ref) => read('header', ref, async () => {
      const { serverId, pending } = storeFor(ref);
      const key = JSON.stringify([serverId, ref.artifactId]);
      let header = headers.get(key);
      if (!header) {
        header = pending.then(({ serverUrl, store }) => {
          if (!store) throw new ArtifactEncryptionMaterialUnavailableError();
          let readHeader = headerReaders.get(serverId);
          if (!readHeader) {
            readHeader = store.createHeaderReader({ signal: options?.signal });
            headerReaders.set(serverId, readHeader);
          }
          return runWithServerHttpBaseUrl(serverUrl, () =>
            readHeader(ref.artifactId),
          );
        });
        headers.set(key, header);
      }
      const artifact = await header;
      return artifact ? { header: artifact.header } : null;
    }),
  });
}

/** The Protocol owner composes and validates; this host only supplies transport. */
export async function resolveCliPromptStackSystemAppendBlocks(
  args: CliPromptStackSystemAppendInput,
): Promise<PromptStackSystemAppendResultV1> {
  const promptStacksV1 = PromptStacksV1Schema.parse(args.promptStacksV1);
  const resolve = async (reader: CliPromptLibraryArtifactReader) =>
    resolvePromptStackSystemAppendBlocksV1({
      ...args,
      readScope: !args.readArtifact || args.credentials ? async () => {
        const scope = await reader.readScope();
        return scope && args.profileId?.trim() ? { ...scope, profileId: args.profileId.trim() } : scope;
      } : undefined,
      promptStacksV1,
      readArtifact: args.readArtifact ?? reader.readArtifact,
      readArtifactHeader: args.readArtifact ? args.readArtifactHeader : args.readArtifactHeader ?? reader.readArtifactHeader,
    });
  return withCliPromptLibraryArtifactReader(resolve, { ...args, serverId: args.scope?.serverId ?? args.serverId });
}
