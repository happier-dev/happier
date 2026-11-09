import {
  PROJECT_READINESS_FACT_OWNERS_V1,
  type ActionExecutorContext, type ActionExecuteFailure, type DeploymentBackupInventoryInputV1,
  type DeploymentBackupRecordedHealthV1, type DeploymentHealthReadInputV1, type DeploymentHealthReadResultV1,
  type ProjectReadinessEnvironmentSelectionV1, type ProjectReadinessFactKindV1, type ProjectReadinessFactOutcomeV1,
  type ProjectReadinessFactV1, type ProjectReadinessReadInputV1,
} from '@happier-dev/protocol';
import type { DeploymentBackupConfigurationV1, DeploymentEnvironmentBackupV1, DeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

export type ProjectReadinessEnvironmentV1 =
  Readonly<{ kind: 'available'; durableData: 'present' | 'absent' | 'unknown'; backup?: DeploymentEnvironmentBackupV1 }>;
export type ProjectReadinessEnvironmentScopeV1 = Readonly<{
  serverId: string; projectId: string; environment: ProjectReadinessEnvironmentSelectionV1;
}>;
export type ProjectReadinessHostPortsV1 = Readonly<{
  /** Persistence owner resolves the exact Project membership and Environment revision. */
  readEnvironment: (scope: ProjectReadinessEnvironmentScopeV1,
    context: ActionExecutorContext) => Promise<ProjectReadinessEnvironmentV1>;
  /** Native placement is delegated through the existing target-daemon Actions. */
  readHealth?: (input: DeploymentHealthReadInputV1, context: ActionExecutorContext) => Promise<DeploymentHealthReadResultV1 | ActionExecuteFailure>;
  /** Existing scoped operation receipts; this read never acquires repository credentials. */
  readRecordedBackups?: (input: DeploymentBackupInventoryInputV1, configuration: DeploymentBackupConfigurationV1,
    context: ActionExecutorContext) => Promise<DeploymentBackupRecordedHealthV1 | ActionExecuteFailure>;
}>;

/** The Environment reader already owns content/access admission; this binds its fact to the selected scope. */
export function projectReadinessEnvironmentFactForHost(scope: ProjectReadinessEnvironmentScopeV1,
  controllerMachineId: string, detail: Pick<DeploymentEnvironmentDetailV1, 'environment' | 'content'>): ProjectReadinessEnvironmentV1 {
  if (detail.environment.serverId !== scope.serverId || detail.environment.projectSourceId !== scope.projectId
    || detail.environment.controllerMachineId !== controllerMachineId) {
    throw Object.assign(new Error('target_mismatch'), { code: 'target_mismatch' });
  }
  if (detail.environment.revision !== scope.environment.expectedRevision) {
    throw Object.assign(new Error('stale_input'), { code: 'stale_input' });
  }
  return { kind: 'available', durableData: detail.content.template
    ? detail.content.template.data?.length ? 'present' : 'absent' : 'unknown', backup: detail.content.backup };
}

const unavailable = (reason: string): ProjectReadinessFactOutcomeV1 => ({ status: 'unavailable', reason });
const missingOwnerReasons = {
  ci: 'ci_source_projection_unavailable', health: 'health_check_coverage_projection_unavailable',
  alerts: 'alert_wiring_projection_unavailable', secrets: 'secret_scope_projection_unavailable',
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
        if (!selection.backups || !ports.readRecordedBackups) return unavailable('backup_target_selection_unavailable');
        if (selection.backups.configRevision !== environment.backup.configRevision) return unavailable('backup_configuration_revision_mismatch');
        const recorded = await ports.readRecordedBackups(selection.backups, environment.backup, context);
        return 'errorCode' in recorded ? unavailable(recorded.errorCode) : recorded;
      };
      const environments = await Promise.all(input.environments.map(async selection => {
          const scope = { ...projectScope, environment: selection };
          const environment = await ports.readEnvironment(scope, context);
          const [backups, health] = await Promise.all([
            readBackups(environment, selection),
            selection.health && ports.readHealth ? ports.readHealth(selection.health, context) : Promise.resolve(undefined),
          ]);
          const healthFact = health && 'errorCode' in health ? unavailable(health.errorCode)
            : { ...unavailable(missingOwnerReasons.health), ...(health ? { health } : {}) };
          return [fact('health', healthFact, selection.environmentId),
            fact('alerts', unavailable(missingOwnerReasons.alerts), selection.environmentId),
            fact('secrets', unavailable(missingOwnerReasons.secrets), selection.environmentId),
            ...(backups ? [fact('backups', backups, selection.environmentId)] : [])];
        }));
      const facts = [fact('ci', unavailable(missingOwnerReasons.ci)),
        fact('security', unavailable(missingOwnerReasons.security)), ...environments.flat()];
      if (input.environments.length === 0) for (const kind of ['health', 'alerts', 'secrets', 'backups'] as const) {
        facts.push(fact(kind, unavailable('environment_selection_required')));
      }
      // CI/security selection and the scoped coverage/grant producers are not exposed yet.
      return { serverId: input.serverId, projectId: input.projectId, status: 'unavailable', facts } as const;
    } catch (error) {
      const code = context.signal?.aborted ? 'cancelled' : readRpcErrorCode(error)
        ?? (error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'action_failed');
      return { ok: false, errorCode: code, error: code, details: { step: 'readiness', code } } as const;
    }
  };
}
