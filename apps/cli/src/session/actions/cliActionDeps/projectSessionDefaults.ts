import { loadManagedSessionDefaultsContextV1 } from '@happier-dev/protocol/projects/loadManagedSessionDefaultsContextV1';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { HomeSessionDefaultsProjectionV1Schema } from '@happier-dev/protocol/home/governance/projection';
import { ActionExecuteFailureSchema, createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { PROJECT_SESSION_DEFAULTS_GET_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { readProjectSessionDefaults } from '@/workspaces/projectAccountRows';
import type { CliProjectAdmission } from './projectAdmission';

function readGovernance(value: unknown): unknown {
  const failure = ActionExecuteFailureSchema.safeParse(value);
  if (failure.success) throw createActionExecuteFailureError(failure.data);
  return value;
}

export function createCliProjectSessionDefaultsActionDeps(
  admission: Pick<CliProjectAdmission, 'projectAccountAdmission' | 'projectHomeAdmission' | 'projectRowsAuthority' | 'withProjectHome' | 'resolveProjectHomeIdentity'>,
  readPorts: () => Pick<ActionExecutorDeps, 'projectSourcesRead' | 'homeDomainAction'>,
): Pick<ActionExecutorDeps, 'projectsSessionDefaultsGet'> {
  return {
    projectsSessionDefaultsGet: async (input, context) => {
      const selectedHome = input.projectRef?.serverId ?? input.sourceRef?.serverId;
      const refusal = input.projectRef ? await admission.projectAccountAdmission(selectedHome, context)
        : await admission.projectHomeAdmission(selectedHome, context);
      if (refusal) return refusal;
      if (input.sourceRef && input.sourceRef.serverId !== selectedHome) {
        const refusal = await admission.projectHomeAdmission(input.sourceRef.serverId, context);
        if (refusal) return refusal;
      }
      const ports = readPorts();
      if (!ports.homeDomainAction || input.sourceRef && !ports.projectSourcesRead) return {
        ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${PROJECT_SESSION_DEFAULTS_GET_ACTION_ID_V1}`,
      };
      const serverId = await admission.resolveProjectHomeIdentity();
      return loadManagedSessionDefaultsContextV1(input, {
        readPersonalDefaults: project => admission.withProjectHome(() => readProjectSessionDefaults({
          ...admission.projectRowsAuthority(context, PROJECT_SESSION_DEFAULTS_GET_ACTION_ID_V1, context?.signal),
          ...project, serverId,
        })),
        readSource: source => ports.projectSourcesRead!({ ...source, serverId }, context),
        readTeam: async teamId => {
          const raw = await ports.homeDomainAction!({ actionId: 'teams.get', input: { v: 1, teamId }, context: context ?? {},
            ...(context?.signal ? { signal: context.signal } : {}) });
          const failure = ActionExecuteFailureSchema.safeParse(raw);
          return failure.success ? failure.data : TeamSummaryV1Schema.parse(raw);
        },
        readHome: async () => HomeSessionDefaultsProjectionV1Schema.parse(readGovernance(await ports.homeDomainAction!({
          actionId: 'home.governance.get', input: { projection: 'session_defaults' }, context: context ?? {},
          ...(context?.signal ? { signal: context.signal } : {}),
        }))),
      });
    },
  };
}
