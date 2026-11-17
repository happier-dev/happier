import { loadManagedSessionDefaultsContextV1, type ManagedSessionDefaultsContextLoaderV1 } from '@happier-dev/protocol/projects/loadManagedSessionDefaultsContextV1';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { HomeSessionDefaultsProjectionV1Schema } from '@happier-dev/protocol/home/governance/projection';
import { ActionExecuteFailureSchema, createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorDeps, ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { canUsePrivateProjectAccountAction, createUiProjectAccountRowsClient } from './projectAccountRowsClient';
import { createProjectSourceActionDeps } from './projectSourceActions';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

function readGovernance(value: unknown): unknown {
    const failure = ActionExecuteFailureSchema.safeParse(value);
    if (failure.success) throw createActionExecuteFailureError(failure.data);
    return value;
}

/** Captured UI transports for the canonical loader, shared by reads and creation. */
export function createUiManagedSessionDefaultsContextLoader(account: LazyActionAccountContext,
    homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']>, context: ActionExecutorContext = {}): ManagedSessionDefaultsContextLoaderV1 {
    return {
        readPersonalDefaults: project => {
            if (!canUsePrivateProjectAccountAction(account, context)) throw createActionExecuteFailureError({
                ok: false, errorCode: 'project_organization_access_denied', error: 'project_organization_access_denied', effectAttempted: false,
            });
            if (!areServerProfileIdentifiersEquivalent(project.serverId, account.serverId)) throw createActionExecuteFailureError({
                ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch', effectAttempted: false,
            });
            return createUiProjectAccountRowsClient(account).readSessionDefaults({ ...project, serverId: account.serverId }, context.signal);
        },
        readSource: source => createProjectSourceActionDeps(account).projectSourcesRead(source, context),
        readTeam: async teamId => {
            const raw = await homeDomainAction({ actionId: 'teams.get', input: { v: 1, teamId }, context,
                ...(context.signal ? { signal: context.signal } : {}) });
            const failure = ActionExecuteFailureSchema.safeParse(raw);
            return failure.success ? failure.data : TeamSummaryV1Schema.parse(raw);
        },
        readHome: async () => HomeSessionDefaultsProjectionV1Schema.parse(readGovernance(await homeDomainAction({
            actionId: 'home.governance.get', input: { projection: 'session_defaults' }, context,
            ...(context.signal ? { signal: context.signal } : {}),
        }))),
    };
}

/** Exact captured Account transports; the shared loader owns context assembly. */
export function createUiProjectSessionDefaultsActionDeps(account: LazyActionAccountContext,
    homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']>): Pick<ActionExecutorDeps, 'projectsSessionDefaultsGet'> {
    return {
        projectsSessionDefaultsGet: async (input, context) => {
            return loadManagedSessionDefaultsContextV1(input, createUiManagedSessionDefaultsContextLoader(account, homeDomainAction, context));
        },
    };
}
