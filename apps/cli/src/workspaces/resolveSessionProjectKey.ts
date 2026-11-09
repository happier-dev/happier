import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { resolveSessionProjectKeyV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { StoredCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import { readProjectAccountRows, type ProjectAccountRowsReadInput, type ProjectAccountRowsSelection } from './projectAccountRows';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';
import { classifyHomeReadPreparationError } from '@/agent/prompts/library/homeReadPreparationError';

export type SessionProjectPromptStackInput = Readonly<{
  credentials: StoredCredentials; metadata: unknown; signal?: AbortSignal; machineId: string; directory?: string; serverId?: string;
  operationContext?: SavedSecretOperationContextV1;
}>;
export type SessionProjectKeyResolution = Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'resolved'; projectKey: string; workspaceRef: WorkspaceRefV1 }>
  | Readonly<{ kind: 'pending'; reason: 'project_association_unavailable' }>;
export type SessionProjectAccountRowsReader = (input: ProjectAccountRowsReadInput & Readonly<{ selection: ProjectAccountRowsSelection }>)
  => ReturnType<typeof readProjectAccountRows>;

/** Every selected Session read keeps the same captured Account custody. */
export async function readSessionProjectAccountRows(input: SessionProjectPromptStackInput,
  selection: ProjectAccountRowsSelection,
  readRows: SessionProjectAccountRowsReader = readProjectAccountRows): Promise<Awaited<ReturnType<typeof readProjectAccountRows>>> {
  input.signal?.throwIfAborted();
  const serverId = input.serverId ?? input.credentials.requesterSessionCredentialScope?.serverId ?? configuration.activeServerId;
  const accountId = input.operationContext ? readAccountIdFromToken(input.credentials.token) : null;
  if (input.operationContext && (!accountId || input.operationContext.credentials.token !== input.credentials.token)) {
    throw Object.assign(new Error('project_requester_authority_unavailable'), { code: 'project_requester_authority_unavailable' });
  }
  return await readRows({ credentials: input.credentials, serverId, signal: input.signal, selection,
    ...(input.operationContext && accountId ? { sessionCustody: { serverId, accountId,
      serverHttpBaseUrl: input.operationContext.serverHttpBaseUrl, isCurrent: input.operationContext.isCurrent } } : {}) });
}

/** Account association selects an exact checkout; filesystem containment does not select a Project. */
export async function resolveSessionProjectKey(input: SessionProjectPromptStackInput,
  readRows: SessionProjectAccountRowsReader = readProjectAccountRows): Promise<SessionProjectKeyResolution> {
  input.signal?.throwIfAborted();
  const pending = { kind: 'pending', reason: 'project_association_unavailable' } as const;
  const serverId = input.serverId ?? input.credentials.requesterSessionCredentialScope?.serverId ?? configuration.activeServerId;
  const metadata = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
    ? { ...input.metadata, machineId: input.machineId, ...(input.directory !== undefined ? { path: input.directory } : {}) }
    : null;
  const directory: unknown = metadata && Reflect.get(metadata, 'path');
  if ((typeof directory !== 'string' || !directory.trim())
    && resolveSessionProjectKeyV1(metadata, serverId, []).kind === 'none') return { kind: 'none' };
  const homeId = await resolveServerProfileHomeIdentityId(serverId) ?? serverId;
  let snapshot: Awaited<ReturnType<typeof readProjectAccountRows>>;
  try {
    snapshot = await readSessionProjectAccountRows(input, { kinds: ['workspace-ref'], serverId: homeId }, readRows);
  }
  catch (error) {
    input.signal?.throwIfAborted();
    // A failed Home read says nothing about the association. Keep the shared
    // preparation disposition so startup respawn and pre-turn custody can recover.
    const preparationError = classifyHomeReadPreparationError(error);
    if (preparationError !== error) throw preparationError;
    return pending;
  }
  input.signal?.throwIfAborted();
  const resolved = resolveSessionProjectKeyV1(metadata, homeId, snapshot.workspaceRefs);
  if (resolved.kind === 'none') return resolved;
  if (resolved.kind !== 'resolved' || !resolved.ref) return pending;
  const project = resolved.projectKey;
  return { kind: 'resolved', projectKey: project.projectKey, workspaceRef: resolved.ref };
}
