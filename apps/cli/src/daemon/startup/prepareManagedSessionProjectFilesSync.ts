import { PluginError } from '@happier-dev/plugin-sdk';
import { acquireRequesterAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentnessObservation';
import { configuration } from '@/configuration';
import type { StoredCredentials } from '@/persistence';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import {
  createWorkspaceSyncManagedTargetCredentialCustody,
  type AdmittedRequesterSessionBootstrap,
} from '../sessionEncryption/requesterSessionCredentials';
import type { PrepareManagedProjectFilesSyncInput, ProductionDaemonWorkspaceSyncRuntime } from './createProductionDaemonWorkspaceSyncRuntime';

type ManagedSessionProjectFilesCustodyInput = Readonly<{
  targetManaged: PrepareManagedProjectFilesSyncInput['targetManaged'];
  requesterAccountId: string;
  credentials: StoredCredentials;
  bootstrap?: Pick<AdmittedRequesterSessionBootstrap, 'attribution' | 'homeServerIdentityId'> & Readonly<{
    savedSecretOperationContext: Pick<SavedSecretOperationContextV1, 'isCurrent' | 'serverHttpBaseUrl' | 'machineAdmission'>;
  }>;
  sourceExecutionIdentity?: PrepareManagedProjectFilesSyncInput['sourceExecutionIdentity'];
  sourceHomeServerIdentityId?: string;
  sourceWorkspace?: PrepareManagedProjectFilesSyncInput['sourceWorkspace'];
  contentPolicy?: PrepareManagedProjectFilesSyncInput['contentPolicy'];
  actionContext?: PrepareManagedProjectFilesSyncInput['actionContext'];
  openProject?: PrepareManagedProjectFilesSyncInput['openProject'];
  sourceRootPath: string;
  targetRootPath: string;
  signal?: AbortSignal;
}>;

/** Retain the admitted Account for the relationship, independently of Session custody. */
export async function prepareManagedSessionProjectFilesSync(input: ManagedSessionProjectFilesCustodyInput & Readonly<{
  runtime: ProductionDaemonWorkspaceSyncRuntime['prepareManagedProjectFilesSync'];
  mode: PrepareManagedProjectFilesSyncInput['mode'];
}>): ReturnType<ProductionDaemonWorkspaceSyncRuntime['prepareManagedProjectFilesSync']> {
  return await withManagedProjectFilesCustody(input, request => input.runtime({ ...request, mode: input.mode }));
}

/** Finite native seeding uses the incumbent Project SOURCE materializer. */
export async function prepareManagedSessionProjectFilesSeed(input: ManagedSessionProjectFilesCustodyInput & Readonly<{
  runtime: ProductionDaemonWorkspaceSyncRuntime['prepareManagedProjectFilesSeed'];
}>): ReturnType<ProductionDaemonWorkspaceSyncRuntime['prepareManagedProjectFilesSeed']> {
  return await withManagedProjectFilesCustody(input, input.runtime);
}

async function withManagedProjectFilesCustody<T>(input: ManagedSessionProjectFilesCustodyInput,
  run: (request: Omit<PrepareManagedProjectFilesSyncInput, 'mode'>) => Promise<T>): Promise<T> {
  const { bootstrap } = input;
  const request = { sourceRootPath: input.sourceRootPath, targetRootPath: input.targetRootPath,
    targetManaged: input.targetManaged, requesterAccountId: input.requesterAccountId,
    credentials: input.credentials, ...(input.sourceExecutionIdentity ? { sourceExecutionIdentity: input.sourceExecutionIdentity } : {}),
    ...(input.sourceWorkspace ? { sourceWorkspace: input.sourceWorkspace } : {}),
    ...(input.contentPolicy ? { contentPolicy: input.contentPolicy } : {}),
    ...(input.actionContext ? { actionContext: input.actionContext } : {}),
    ...(input.openProject ? { openProject: input.openProject } : {}),
    ...(input.signal ? { signal: input.signal } : {}) };
  const attribution = input.sourceExecutionIdentity?.kind === 'isolated'
    ? input.sourceExecutionIdentity.requester : bootstrap?.attribution;
  const retainRelationship: PrepareManagedProjectFilesSyncInput['retainRelationship'] = attribution ? async (relationshipId, workspace) => {
    const custody = { happyHomeDir: configuration.happyHomeDir, relationshipId, attribution, credentials: input.credentials,
      ...(bootstrap?.homeServerIdentityId || input.sourceHomeServerIdentityId
        ? { homeServerIdentityId: bootstrap?.homeServerIdentityId ?? input.sourceHomeServerIdentityId } : {}) };
    await createWorkspaceSyncManagedTargetCredentialCustody({ ...custody, workspace,
      ...(input.sourceExecutionIdentity?.kind === 'isolated'
        && (!input.sourceWorkspace || input.sourceWorkspace.machineId === workspace.controller.machineId)
        ? { sourceExecutionIdentity: input.sourceExecutionIdentity } : {}) });
  } : undefined;
  if (!bootstrap) return await run({ ...request, ...(retainRelationship ? { retainRelationship } : {}) });
  const source = bootstrap.savedSecretOperationContext;
  if (bootstrap.attribution.accountId !== input.requesterAccountId || !await source.isCurrent()) {
    throw new PluginError({ code: 'project_requester_authority_unavailable', message: 'Requester Sync custody is unavailable' });
  }
  const observation = acquireRequesterAccountEncryptionCurrentness({ accountId: input.requesterAccountId,
    token: input.credentials.token, serverBaseUrl: source.serverHttpBaseUrl });
  let handedOff = false;
  try {
    const identity = await observation.read(input.signal);
    const accountRowsCustody = { serverId: bootstrap.homeServerIdentityId ?? bootstrap.attribution.serverId, accountId: input.requesterAccountId,
      serverHttpBaseUrl: source.serverHttpBaseUrl, isCurrent: async () => observation.isCurrent(identity) };
    handedOff = true;
    return await run({ ...request, accountRowsCustody, releaseCustody: () => observation.dispose(),
      ...(retainRelationship ? { retainRelationship } : {}) });
  } finally {
    if (!handedOff) await observation.dispose();
  }
}
