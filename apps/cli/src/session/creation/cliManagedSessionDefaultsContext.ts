import { ActionExecuteFailureSchema, createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ManagedSessionDefaultsContextLoaderV1 } from '@happier-dev/protocol/projects/loadManagedSessionDefaultsContextV1';
import { ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { HomeSessionDefaultsProjectionV1Schema } from '@happier-dev/protocol/home/governance/projection';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { StoredCredentials } from '@/persistence';
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
}>): ManagedSessionDefaultsContextLoaderV1 {
  const home = createAccountServerActionDeps({ credentials: input.credentials, token: input.credentials.token,
    serverId: input.serverId, serverHttpBaseUrl: input.serverHttpBaseUrl });
  const context = { surface: 'cli' as const, serverId: input.serverId, ...(input.signal ? { signal: input.signal } : {}) };
  const sources = createCliProjectSourceActionDeps({ serverHttpBaseUrl: input.serverHttpBaseUrl,
    admitAccount: async serverId => await isServerProfileHomeIdentity(input.serverId, serverId) ? null
      : { ok: false, errorCode: 'target_mismatch', error: 'target_mismatch' },
    resolveRequestHeaders: () => ({ Authorization: `Bearer ${input.credentials.token}` }),
  });
  return {
    readPersonalDefaults: project => runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () =>
      readProjectSessionDefaults({ credentials: input.credentials, ...project, ...(input.signal ? { signal: input.signal } : {}) })),
    readSource: async source => {
      const raw = await sources.projectSourcesRead!(source, context);
      const failure = ActionExecuteFailureSchema.safeParse(raw);
      return failure.success ? failure.data : ProjectSourcesReadOutputV1Schema.parse(raw);
    },
    readTeam: async teamId => {
      const raw = await home.homeDomainAction!({ actionId: 'teams.get', input: { v: 1, teamId }, context,
        ...(input.signal ? { signal: input.signal } : {}) });
      const failure = ActionExecuteFailureSchema.safeParse(raw);
      return failure.success ? failure.data : TeamSummaryV1Schema.parse(raw);
    },
    readHome: async () => HomeSessionDefaultsProjectionV1Schema.parse(governanceValue(await home.homeDomainAction!({
      actionId: 'home.governance.get', input: { projection: 'session_defaults' }, context,
      ...(input.signal ? { signal: input.signal } : {}) }))),
  };
}
