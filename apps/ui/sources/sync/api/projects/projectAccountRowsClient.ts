import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import type { ProjectAccountOrganizationV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import type { WorkspaceAddressV1, WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { ProjectRepositoryObservationV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createProjectAccountRowsSync } from '@/sync/engine/projects/projectAccountRowsSync';
import { createApiProjectAccountRowsTransport } from '@/sync/api/account/apiProjectAccountRows';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { readCurrentProjectAccountRows } from '@/sync/store/domains/projectAccountRows';
import { resolveWorkspaceRefByAddress } from '@/sync/domains/workspaces/workspaceRefs';
import { workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { resolveProjectAccountReferenceV1 } from '@happier-dev/protocol/projects/projectAccountSnapshotV1';
import type { QualifiedProjectKeyV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import type { ProjectSessionDefaultsV1 } from '@happier-dev/protocol/projects/projectSessionDefaultsV1';

type Account = Pick<LazyActionAccountContext, 'serverId' | 'accountId' | 'credentials' | 'request' | 'assertCurrent' | 'resolveAccountEncryption'>;
type Caller = Pick<ActionExecutorContext, 'serverId' | 'runtimeAccountId' | 'externalActionCredential' | 'externalActionExecutionAuthorization'>;

/** Private Project rows require the actual captured Account, never a custodian's keys. */
export function canUsePrivateProjectAccountAction(account: Pick<Account, 'serverId' | 'accountId' | 'assertCurrent'> | undefined, context?: Caller): boolean {
  if (!account || (context?.serverId && !areServerProfileIdentifiersEquivalent(context.serverId, account.serverId))
    || (context?.runtimeAccountId && context.runtimeAccountId !== account.accountId)
    || (context?.externalActionCredential && context.externalActionCredential.accountId !== account.accountId)
    || (context?.externalActionExecutionAuthorization && context.externalActionExecutionAuthorization.binding.accountId !== account.accountId)) return false;
  try { account.assertCurrent(); return true; } catch { return false; }
}

function refused(errorCode: string) { return { ok: false as const, errorCode, error: errorCode }; }
function mutationFailure(error: unknown, signal?: AbortSignal) {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return refused(error.code);
  if (signal?.aborted) return refused('cancelled');
  return refused('outcome_unknown');
}

/** Captured-Account HTTP adapter; row opening, projection and CAS stay in the existing sync owner. */
export function createUiProjectAccountRowsClient(account: Account) {
  async function createOwner() {
    const { accountMode } = await account.resolveAccountEncryption(); account.assertCurrent();
    const scope = { serverId: account.serverId, accountId: account.accountId };
    return createProjectAccountRowsSync({ scope,
      cipher: createProjectAccountRowCipherV1({ mode: accountMode,
        material: accountMode === 'plain' ? null : resolveAccountScopedCryptoMaterialFromCredentials(account.credentials), randomBytes: getRandomBytes }),
      isCurrent: () => { try { account.assertCurrent(); return true; } catch { return false; } },
      apply: (...args) => storage.getState().applyProjectAccountRowsForScope(scope, ...args),
      // The focused sync owner already projected authoring-memory recency; a structural Action read must not erase it.
      readRecency: ref => {
        const current = readCurrentProjectAccountRows(storage.getState());
        if (current?.scope.serverId !== scope.serverId || current.scope.accountId !== scope.accountId) return undefined;
        const resolved = resolveWorkspaceRefByAddress(current.workspaceRefs, workspaceAddressFromRefV1(ref));
        return resolved.kind === 'resolved' ? resolved.ref.lastOpenedAtMs ?? undefined : undefined;
      },
      transport: createApiProjectAccountRowsTransport({ request: account.request }),
    });
  }
  let owner: ReturnType<typeof createOwner> | undefined;
  // The app's own Account/Home already holds these rows opened and hint-maintained: read and mutate
  // through that one owner. Only another captured Account builds its own reader, which has no hint
  // stream and therefore lists on every read.
  const appOwner = () => { account.assertCurrent(); return sync?.projectAccountRowsOwnerFor?.({ serverId: account.serverId, accountId: account.accountId }) ?? null; };
  const getOwner = () => appOwner() ?? (owner ??= createOwner());
  const read = async (signal?: AbortSignal) => {
    const app = appOwner();
    return app ? (await app).read(signal) : (await (owner ??= createOwner())).refresh(signal);
  };
  return {
    read,
    readSessionDefaults: async (project: QualifiedProjectKeyV1, signal?: AbortSignal) =>
      (await getOwner()).readSessionDefaults(project, signal),
    mutateSessionDefaults: async (input: Readonly<{
      serverId: string; projectKey: string; expectedRevision: number | 'absent'; defaults: ProjectSessionDefaultsV1 | null; signal?: AbortSignal;
    }>) => (await getOwner()).mutateSessionDefaults(input),
    waitForWorkspaceRef: async (address: WorkspaceAddressV1, signal?: AbortSignal) => {
      // Only the app retains a hint-maintained projection. Finite foreign-Home readers
      // take their census at their next Action and have no pending push to await.
      const app = appOwner();
      if (app) await (await app).waitForWorkspaceRef(address, signal);
    },
    readProjectReference: async (project: QualifiedProjectKeyV1, signal?: AbortSignal, context?: Caller) => {
      if (!canUsePrivateProjectAccountAction(account, context) || !areServerProfileIdentifiersEquivalent(project.serverId, account.serverId))
        throw Object.assign(new Error('project_account_access_denied'), { code: 'project_account_access_denied' });
      // A delete guard decides a write, so it takes a census like every mutation; the app owner
      // still reuses its opened payloads for unchanged rows instead of re-opening them.
      return resolveProjectAccountReferenceV1(await (await getOwner()).refresh(signal), project, resolveServerProfileScopeIdForIdentifier);
    },
    updateWorkspace: async (input: Readonly<{ serverId: string; workspaceId: string; label?: string | null; pinned?: boolean; projectKey?: string; signal?: AbortSignal }>, context?: Caller) => {
      if (!canUsePrivateProjectAccountAction(account, context)) return refused('project_account_access_denied');
      try { return { ok: true as const, ...await (await getOwner()).mutateWorkspaceMetadata(input) }; }
      catch (error) { return mutationFailure(error, input.signal); }
    },
    recordWorkspaceSource: async (address: WorkspaceAddressV1, source: NonNullable<WorkspaceRefV1['source']>, signal?: AbortSignal) => {
      if (!canUsePrivateProjectAccountAction(account)) return refused('project_account_access_denied');
      try {
        const result = await (await getOwner()).recordWorkspaceSource(address, source, signal);
        return result.ok ? { ok: true as const, workspaceId: result.workspaceRefId } : refused(result.code);
      } catch (error) { return mutationFailure(error, signal); }
    },
    recordWorkspaceRepositoryObservation: async (address: WorkspaceAddressV1, observation: ProjectRepositoryObservationV1, signal?: AbortSignal, context?: Caller) => {
      if (!canUsePrivateProjectAccountAction(account, context)) return refused('project_account_access_denied');
      try { return await (await getOwner()).recordWorkspaceRepositoryObservation(address, observation, signal); }
      catch (error) { return mutationFailure(error, signal); }
    },
    /** Pin or unpin a service on this Home through the one opened owner (projects.services.pin). */
    setEnvironmentPinned: async (input: Readonly<{ serverId: string; environmentId: string; pinned: boolean; signal?: AbortSignal }>, context?: Caller) => {
      if (!canUsePrivateProjectAccountAction(account, context)) return refused('project_account_access_denied');
      try { return { ok: true as const, ...await (await getOwner()).setEnvironmentPinned(input) }; }
      catch (error) { return mutationFailure(error, input.signal); }
    },
    forgetWorkspace: async (input: Readonly<{ serverId: string; workspaceId: string; signal?: AbortSignal }>, context?: Caller) => {
      if (!canUsePrivateProjectAccountAction(account, context)) return refused('project_account_access_denied');
      try {
        const result = await (await getOwner()).mutateRef({ kind: 'remove', serverId: input.serverId, workspaceRefId: input.workspaceId }, input.signal);
        if (!result.ok) return { ...refused(result.code), ...('relationshipIds' in result ? { details: { relationshipIds: [...result.relationshipIds] } } : {}) };
        return { ok: true as const, workspaceId: input.workspaceId };
      } catch (error) { return mutationFailure(error, input.signal); }
    },
    mutateOrganization: async (input: Readonly<{
      serverId: string; projectKey: string; expectedRevision?: number | 'absent'; signal?: AbortSignal;
      mutate(value: ProjectAccountOrganizationV1): ProjectAccountOrganizationV1 | Promise<ProjectAccountOrganizationV1>;
    }>) => (await getOwner()).mutateOrganizationAtRevision(input),
  };
}
