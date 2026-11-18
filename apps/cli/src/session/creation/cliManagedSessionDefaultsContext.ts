import { isExternalActionProjectSessionDefaultsReadAdmittedV1 } from '@happier-dev/protocol/actions/externalActionApi';
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
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

/** CLI-private data travels with executor context, never with the admitted Action input. */
export const sessionCreationAccountSettingsContext = Symbol('sessionCreationAccountSettingsContext');
export type CliSessionCreationDefaults = NonNullable<ActionExecutorContext['sessionCreationDefaults']> & Readonly<{
  [sessionCreationAccountSettingsContext]?: ActiveAccountSettingsSnapshot;
}>;

export function readSessionCreationAccountSettingsContext(defaults: ActionExecutorContext['sessionCreationDefaults']): ActiveAccountSettingsSnapshot | undefined {
  return (defaults as CliSessionCreationDefaults | undefined)?.[sessionCreationAccountSettingsContext];
}

function governanceValue(value: unknown): unknown {
  const failure = ActionExecuteFailureSchema.safeParse(value);
  if (failure.success) throw createActionExecuteFailureError(failure.data);
  return value;
}

/** Private preferences require the creating Account's retained custody or ordinary stored login. */
export function canReadPrivateSessionDefaults(credentials: StoredCredentials, context?: ActionExecutorContext): boolean {
  return Boolean(readRequesterAccountActionContext(context?.externalActionExecutionAuthorization))
    || hasStoredSessionCredentialProvenance(credentials)
      && !context?.externalActionCredential && !context?.externalActionExecutionAuthorization;
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
  const privateAccountAvailable = canReadPrivateSessionDefaults(input.credentials, context);
  const binding = context.externalActionExecutionAuthorization?.binding;
  const teamAvailable = privateAccountAvailable
    || (binding !== undefined && isExternalActionProjectSessionDefaultsReadAdmittedV1(binding, 'teams.get'));
  const homeAvailable = privateAccountAvailable
    || (binding !== undefined && isExternalActionProjectSessionDefaultsReadAdmittedV1(binding, 'home.governance.get'));
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
    ...(teamAvailable ? {
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
