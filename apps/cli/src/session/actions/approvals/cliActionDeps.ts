import type { CliActionDepsParams } from '../cliActionDeps/types';
import type { logger } from '@/ui/logger';
import { ManagedDeleteInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { createExecutionRunHostActionApprovalDecision } from '@happier-dev/protocol/actions';
import { SessionSpawnNewActionInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { projectRequesterSessionCredentialDisclosure } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import type { buildPluginInstallApprovalPreview } from '@/plugins/devLoop/installApprovalPreview';
import { readPluginInstallApprovalPendingReview } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import type { executePluginDevLoopAction } from '@/plugins/devLoop/actions';
import type { createMarketplaceIndexService } from '@/plugins/store/marketplace/service';
import type { CliPluginAdministrationActionDeps } from '../cliActionDeps/pluginAdministration';

export type CliApprovalActionDeps = Pick<ActionExecutorDeps, 'buildApprovalPreview' | 'recordApprovalRetirementWarning' | 'executionRunHostActionApprovalReplay'> & Readonly<{
  artifactApprovalStore: ReturnType<typeof createCliApprovalsArtifactStore> | null;
}>;
export function createCliApprovalActionDeps(
  params: Pick<CliActionDepsParams, 'happyHomeDir' | 'requesterSessionBootstrap'>,
  { approvalsStore, managedMachineReferences, normalizeStringValue, pluginInstallApprovalChangeServices, readRecord, resolvePluginInstallWorkspaceRoot, resolvePluginInstallRegistry }: Readonly<{
    approvalsStore: ReturnType<typeof createCliApprovalsArtifactStore> | null;
    managedMachineReferences: NonNullable<ActionExecutorDeps["managedMachineReferences"]>;
    normalizeStringValue: (value: unknown) => string | null;
    pluginInstallApprovalChangeServices: CliPluginAdministrationActionDeps["pluginInstallApprovalChangeServices"];
    readRecord: (value: unknown) => Record<string, unknown>;
    resolvePluginInstallWorkspaceRoot: CliPluginAdministrationActionDeps["resolvePluginInstallWorkspaceRoot"];
    resolvePluginInstallRegistry: CliPluginAdministrationActionDeps["resolvePluginInstallRegistry"];
  }>,
): CliApprovalActionDeps {
  const artifactApprovalStore = approvalsStore;
  return { artifactApprovalStore,
    ...(approvalsStore ? { executionRunHostActionApprovalReplay: createExecutionRunHostActionApprovalDecision({
      read: artifactId => approvalsStore.executionRunHostActionApprovalsGet({ artifactId }),
      update: args => approvalsStore.executionRunHostActionApprovalsUpdate(args),
    }) } : {}),
    ...(artifactApprovalStore ? { recordApprovalRetirementWarning: (warning: Readonly<{ artifactId?: string; code: string }>) => {
      void import('@/ui/logger').then(({ logger }) => {
        logger.warnLocalFile('[Approval retirement]', { ...(warning.artifactId ? { artifactId: warning.artifactId } : {}), code: warning.code });
      }).catch(() => undefined);
    } } : {}),
buildApprovalPreview: async ({ actionId, input, context, defaultPreview, machineReferences }) => {
      if (actionId === 'machines.managed.delete') {
        const references = machineReferences ?? await managedMachineReferences({ input: ManagedDeleteInputV1Schema.parse(input),
          context, signal: context.signal });
        return { ...defaultPreview, machineReferences: references };
      }
      if (actionId === 'session.spawn_new' && params.requesterSessionBootstrap
        && await params.requesterSessionBootstrap.isCurrent()) {
        const bootstrap = params.requesterSessionBootstrap;
        const parsed = SessionSpawnNewActionInputV2Schema.safeParse(input);
        if (parsed.success && parsed.data.executionTarget.serverId === bootstrap.attribution.serverId
          && parsed.data.executionTarget.machineId === bootstrap.attribution.machineId) {
          return { ...defaultPreview, requesterCredentialDisclosure: projectRequesterSessionCredentialDisclosure({
            disposition: 'ordinary_requester', accountId: bootstrap.attribution.accountId,
            machineId: bootstrap.attribution.machineId,
          }) };
        }
      }
      if (actionId === 'plugins.install') {
        const [{ buildPluginInstallApprovalPreview }, { executePluginDevLoopAction }] = await Promise.all([
          import('@/plugins/devLoop/installApprovalPreview'), import('@/plugins/devLoop/actions'),
        ]);
        const installInput = readRecord(input);
        const requestedSource = readRecord(installInput.source);
        const developmentPathInstall = installInput.dev === true && installInput.dryRun !== true
          && installInput.kind !== 'archive' && installInput.kind !== 'npm'
          && requestedSource.kind !== 'marketplace' && requestedSource.kind !== 'installed';
        // Development preparation and its retained daemon review never consult
        // Session-relative trust policy, so avoid a Session metadata round trip.
        const workspaceRoot = developmentPathInstall
          ? undefined
          : await resolvePluginInstallWorkspaceRoot(input, context.signal);
        const marketplaceInstall = input !== null && typeof input === 'object'
          && 'source' in input && input.source !== null && typeof input.source === 'object'
          && 'kind' in input.source && input.source.kind === 'marketplace';
        const registryResult = marketplaceInstall ? await resolvePluginInstallRegistry(context) : null;
        if (registryResult && !registryResult.ok) return registryResult;
        const registry = registryResult?.registry ?? null;
        const evaluation = await executePluginDevLoopAction({
          actionId,
          input,
          happyHomeDir: params.happyHomeDir,
          workspaceRoot,
          context,
        }, {
          ...pluginInstallApprovalChangeServices,
          ...(registry ? { marketplaceIndexService: (await import('@/plugins/store/marketplace/service')).createMarketplaceIndexService({
            happyHomeDir: params.happyHomeDir,
            registryHost: registry,
          }) } : {}),
        });
        const daemonEvaluation = readPluginInstallApprovalPendingReview({
          pluginInstall: { pendingReview: readRecord(evaluation).pendingReview },
        });
        if (!daemonEvaluation && installInput.dryRun !== true) {
          const result = readRecord(evaluation);
          const change = readRecord(result.change);
          const diagnostic = readRecord(Array.isArray(result.diagnostics) ? result.diagnostics[0] : null);
          const errorCode = normalizeStringValue(result.errorCode) ?? normalizeStringValue(change.code)
            ?? normalizeStringValue(diagnostic.code) ?? 'approval_context_unavailable';
          return { ok: false, errorCode,
            error: normalizeStringValue(result.error) ?? normalizeStringValue(diagnostic.message) ?? errorCode };
        }
        return await buildPluginInstallApprovalPreview({
          input,
          defaultPreview,
          workspaceRoot,
          ...(daemonEvaluation ? { daemonEvaluation } : {}),
        });
      }
      return defaultPreview;
    }
  };
}
