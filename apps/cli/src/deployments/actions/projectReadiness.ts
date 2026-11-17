import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import {
  PROJECT_READINESS_FACT_OWNERS_V1,
  type ActionExecutorContext, type ActionExecuteFailure, type DeploymentBackupInventoryInputV1,
  type DeploymentBackupRecordedHealthV1,
  type ProjectReadinessEnvironmentSelectionV1, type ProjectReadinessFactKindV1, type ProjectReadinessFactOutcomeV1,
  type ProjectReadinessFactV1, type ProjectReadinessReadInputV1,
} from '@happier-dev/protocol';
import type { DeploymentBackupConfigurationV1, DeploymentEnvironmentBackupV1, DeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { deploymentBackupTargetOperands, selectDeploymentRuntimeTargetLinkV1 } from '@happier-dev/deployments';
// Keep after the protocol imports: placed first, it broke this module graph's schema initialization (A/B, 11-17).
import { recordFailureCause } from '@/diagnostics/recordFailureCause';

export type ProjectReadinessEnvironmentV1 =
  Readonly<{ kind: 'available'; durableData: 'present' | 'absent' | 'unknown'; backup?: DeploymentEnvironmentBackupV1;
    backupTarget?: DeploymentBackupInventoryInputV1;
    /** Borrowed for this finite composite, never persisted or reopened by constituent readers. */
    detail: DeploymentEnvironmentDetailV1 }>;
export type ProjectReadinessEnvironmentScopeV1 = Readonly<{
  serverId: string; projectId: string; environment: ProjectReadinessEnvironmentSelectionV1;
}>;
export type ProjectReadinessHostPortsV1 = Readonly<{
  /** Forge owns exact Project repository/source admission and its current source/check projection. */
  readProjectSources?: (scope: Readonly<{ serverId: string; projectId: string }>,
    context: ActionExecutorContext) => Promise<Readonly<{
      ci: ProjectReadinessFactOutcomeV1; security: ProjectReadinessFactOutcomeV1;
    }>>;
  /** Persistence owner resolves the exact Project membership and Environment revision. */
  readEnvironment: (scope: ProjectReadinessEnvironmentScopeV1,
    context: ActionExecutorContext) => Promise<ProjectReadinessEnvironmentV1>;
  /** One retained Account census supplies both facts for the whole admitted selection, in selection order. */
  readHealthAndAlerts: (environments: readonly Readonly<{ scope: ProjectReadinessEnvironmentScopeV1;
    environment: ProjectReadinessEnvironmentV1 }>[], context: ActionExecutorContext) =>
    Promise<readonly Readonly<{ health: ProjectReadinessFactOutcomeV1; alerts: ProjectReadinessFactOutcomeV1 }>[]>;
  /** Existing scoped operation receipts; this read never acquires repository credentials. */
  readRecordedBackups?: (input: DeploymentBackupInventoryInputV1, configuration: DeploymentBackupConfigurationV1,
    context: ActionExecutorContext) => Promise<DeploymentBackupRecordedHealthV1 | ActionExecuteFailure>;
}>;

/** The Environment reader already owns content/access admission; this binds its fact to the selected scope. */
export function projectReadinessEnvironmentFactForHost(scope: ProjectReadinessEnvironmentScopeV1,
  controllerMachineId: string, detail: DeploymentEnvironmentDetailV1): ProjectReadinessEnvironmentV1 {
  if (detail.environment.serverId !== scope.serverId || detail.environment.projectSourceId !== scope.projectId
    || detail.environment.controllerMachineId !== controllerMachineId) {
    throw createActionExecuteFailureError({ ok: false, errorCode: 'target_mismatch', error: 'target_mismatch' });
  }
  if (detail.environment.revision !== scope.environment.expectedRevision) {
    throw createActionExecuteFailureError({ ok: false, errorCode: 'stale_input', error: 'stale_input' });
  }
  const backupTarget = detail.content.backup && !('notNeeded' in detail.content.backup)
    ? deploymentBackupTargetOperands({ environment: detail.environment,
      runtimeTargetLink: selectDeploymentRuntimeTargetLinkV1(detail) }, detail.content.backup) : null;
  return { kind: 'available', durableData: detail.content.template
    ? detail.content.template.data?.length ? 'present' : 'absent' : 'unknown', backup: detail.content.backup,
    ...(backupTarget ? { backupTarget: { ...backupTarget, serverId: scope.serverId } } : {}), detail };
}

const unavailable = (reason: string): ProjectReadinessFactOutcomeV1 => ({ status: 'unavailable', reason });
const missingOwnerReasons = {
  ci: 'ci_source_projection_unavailable', secrets: 'secret_scope_projection_unavailable',
  security: 'security_source_projection_unavailable',
} as const;

/** A fresh read of owner facts; it stores no score, policy, timer or inferred Source selection. */
export function createProjectReadinessActionForHost(ports: ProjectReadinessHostPortsV1) {
  return async (request: ProjectReadinessReadInputV1, context: ActionExecutorContext) => {
    try {
      const input = request;
      const projectScope = { serverId: input.serverId, projectId: input.projectId };
      const fact = (kind: ProjectReadinessFactKindV1, outcome: ProjectReadinessFactOutcomeV1,
        environmentId?: string): ProjectReadinessFactV1 => ({ ...outcome, kind,
        owner: PROJECT_READINESS_FACT_OWNERS_V1[kind], ...(environmentId ? { environmentId } : {}) });
      const readBackups = async (environment: ProjectReadinessEnvironmentV1, selection: ProjectReadinessEnvironmentSelectionV1) => {
        if (environment.durableData === 'absent') return null;
        if (environment.durableData === 'unknown') return unavailable('durable_data_projection_unavailable');
        if (environment.backup && 'notNeeded' in environment.backup) return { status: 'ready', reason: 'notNeeded' } as const;
        if (!environment.backup) return { status: 'actionNeeded', reason: 'backup_configuration_required' } as const;
        const target = selection.backups ?? environment.backupTarget;
        if (!target || !ports.readRecordedBackups) return unavailable('backup_target_selection_unavailable');
        if (target.configRevision !== environment.backup.configRevision) return unavailable('backup_configuration_revision_mismatch');
        const recorded = await ports.readRecordedBackups(target, environment.backup, context);
        return 'errorCode' in recorded ? unavailable(recorded.errorCode) : recorded;
      };
      const [projectSources, environments] = await Promise.all([
        ports.readProjectSources ? ports.readProjectSources(projectScope, context) : Promise.resolve({
          ci: unavailable(missingOwnerReasons.ci), security: unavailable(missingOwnerReasons.security),
        }),
        (async () => {
          const admitted = await Promise.all(input.environments.map(async selection => {
            const scope = { ...projectScope, environment: selection };
            const environment = await ports.readEnvironment(scope, context);
            return { scope, environment };
          }));
          const [backups, healthAndAlerts] = await Promise.all([
            Promise.all(admitted.map(({ scope, environment }) => readBackups(environment, scope.environment))),
            admitted.length ? ports.readHealthAndAlerts(admitted, context) : Promise.resolve([]),
          ]);
          return admitted.map(({ scope, environment }, index) => {
            const environmentId = scope.environment.environmentId;
            return [fact('health', healthAndAlerts[index]!.health, environmentId),
              fact('alerts', healthAndAlerts[index]!.alerts, environmentId),
              fact('secrets', environment.detail.secretScope
                ? { status: environment.detail.secretScope.status, reason: environment.detail.secretScope.reason,
                  secretScope: { requiredGrantCount: environment.detail.secretScope.requiredGrantCount,
                    missingGrantCount: environment.detail.secretScope.missingGrantCount } }
                : unavailable(missingOwnerReasons.secrets), environmentId),
              ...(backups[index] ? [fact('backups', backups[index]!, environmentId)] : [])];
          });
        })(),
      ]);
      const facts = [fact('ci', projectSources.ci), fact('security', projectSources.security), ...environments.flat()];
      if (input.environments.length === 0) for (const kind of ['health', 'alerts', 'secrets', 'backups'] as const) {
        facts.push(fact(kind, unavailable('environment_selection_required')));
      }
      const status = facts.some(item => item.status === 'unavailable') ? 'unavailable'
        : facts.some(item => item.status === 'actionNeeded') ? 'actionNeeded' : 'ready';
      return { serverId: input.serverId, projectId: input.projectId, status, facts } as const;
    } catch (error) {
      const code = context.signal?.aborted ? 'cancelled' : readRpcErrorCode(error)
        ?? (error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'action_failed');
      return recordFailureCause(error, 'deployment.project.readiness',
        { ok: false, errorCode: code, error: code, details: { step: 'readiness', code } } as const);
    }
  };
}
