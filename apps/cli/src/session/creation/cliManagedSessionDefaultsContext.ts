import { ActionExecuteFailureSchema, createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ManagedSessionDefaultsContextLoaderV1 } from '@happier-dev/protocol/projects/loadManagedSessionDefaultsContextV1';
import { ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { HomeSessionDefaultsProjectionV1Schema } from '@happier-dev/protocol/home/governance/projection';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { hasStoredSessionCredentialProvenance, type StoredCredentials } from '@/persistence';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { resolveExternalActionServerRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import { requireExternalActionHeaders } from '@/api/externalActionHeaderRefusal';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import { createCliProjectSourceActionDeps } from '@/session/actions/projectSourceActionDeps';
import { readProjectSessionDefaults } from '@/workspaces/projectAccountRows';

function governanceValue(value: unknown): unknown {
  const failure = ActionExecuteFailureSchema.safeParse(value);
  if (failure.success) throw createActionExecuteFailureError(failure.data);
  return value;
}

/** Network ports bound to the creating Account, never the installed custodian. */
export function createCliManagedSessionDefaultsContextLoader(input: Readonly<{
  credentials: StoredCredentials; serverId: string; serverHttpBaseUrl: string; signal?: AbortSignal;
  context?: ActionExecutorContext;
}> & Pick<Parameters<typeof createAccountServerActionDeps>[0],
  'serverIdentityId' | 'externalActionMachineInstallationId' | 'externalActionMachineRequestPrivateKey'>
): ManagedSessionDefaultsContextLoaderV1 {
  const home = createAccountServerActionDeps({ credentials: input.credentials, token: input.credentials.token,
    serverId: input.serverId, serverHttpBaseUrl: input.serverHttpBaseUrl,
    serverIdentityId: input.serverIdentityId, externalActionMachineInstallationId: input.externalActionMachineInstallationId,
    externalActionMachineRequestPrivateKey: input.externalActionMachineRequestPrivateKey });
  const context = { ...input.context, surface: input.context?.surface ?? 'cli' as const, serverId: input.serverId, ...(input.signal ? { signal: input.signal } : {}) };
  const sources = createCliProjectSourceActionDeps({ serverHttpBaseUrl: input.serverHttpBaseUrl,
    admitAccount: async serverId => await isServerProfileHomeIdentity(input.serverId, serverId) ? null
      : { ok: false, errorCode: 'target_mismatch', error: 'target_mismatch' },
    resolveRequestHeaders: (context, actionId, request) => requireExternalActionHeaders(resolveExternalActionServerRequestHeaders({
      context, effectActionId: actionId, ...request, daemonToken: input.credentials.token, serverIdentityId: input.serverIdentityId,
      privateKey: input.externalActionMachineRequestPrivateKey, installationId: input.externalActionMachineInstallationId,
    })),
  });
  const requester = readRequesterAccountActionContext(context.externalActionExecutionAuthorization);
  const privateAccountAvailable = Boolean(requester) || hasStoredSessionCredentialProvenance(input.credentials)
    && !context.externalActionCredential && !context.externalActionExecutionAuthorization;
  const homeAvailable = privateAccountAvailable
    || context.externalActionExecutionAuthorization?.binding.projectSessionDefaultsAdmission !== undefined;
  return {
    ...(privateAccountAvailable ? {
      readPersonalDefaults: (project: Parameters<NonNullable<ManagedSessionDefaultsContextLoaderV1['readPersonalDefaults']>>[0]) =>
        runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () => readProjectSessionDefaults({ credentials: input.credentials,
          ...project, ...(input.signal ? { signal: input.signal } : {}) })),
    } : {}),
    readSource: async source => {
      const raw = await sources.projectSourcesRead!(source, context);
      const failure = ActionExecuteFailureSchema.safeParse(raw);
      return failure.success ? failure.data : ProjectSourcesReadOutputV1Schema.parse(raw);
    },
    ...(homeAvailable ? {
      readTeam: async (teamId: string) => {
        const raw = await home.homeDomainAction!({ actionId: 'teams.get', input: { v: 1, teamId }, context,
          ...(input.signal ? { signal: input.signal } : {}) });
        const failure = ActionExecuteFailureSchema.safeParse(raw);
        return failure.success ? failure.data : TeamSummaryV1Schema.parse(raw);
      },
    } : {}),
    ...(homeAvailable ? {
      readHome: async () => HomeSessionDefaultsProjectionV1Schema.parse(governanceValue(await home.homeDomainAction!({
        actionId: 'home.governance.get', input: { projection: 'session_defaults' }, context,
        ...(input.signal ? { signal: input.signal } : {}) }))),
    } : {}),
  };
}
