import * as deploymentActionIds from '../../deployments/deploymentActionIdsV1.js';
import { summarizeDeploymentRestoreReviewV1 } from '../../deployments/deploymentBackupRestoreV1.js';
import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { deploymentTeardownOperationReentryV1 } from '../operations/v1.js';
import type { ActionSpecProjectionMetadata, PreNormalizedActionSpec } from './definition.js';
import { createDeploymentDeployActionCompletionV1 } from '../actionCompletion.js';
import { DeploymentActionInputSchemasV1, DeploymentActionOutputSchemasV1, DeploymentTargetCheckInputV1Schema, DeploymentTargetCheckResultV1Schema, type DeploymentActionIdV1 } from '../../deployments/deploymentActionsV1.js';
import { deploymentBindingSelectionNarrowing } from '../../deployments/deploymentBindingSelectionNarrowing.js';
import { readRecord } from '../../inputs/inputRecords.js';
import { actionInputServerId } from './definition.js';
import { redactObservationInputPaths } from './observationRedaction.js';
import { readApprovalSavedSecretReference } from '../actionApprovalValueReferences.js';
import { isDeploymentTargetLinkActionIdV1, isDeploymentBackupActionIdV1, isDeploymentBackupReadActionIdV1, isDeploymentDomainChildActionIdV1, isDeploymentDomainRemoveActionIdV1, isDeploymentPromoteActionIdV1 } from '../../deployments/deploymentActionIdsV1.js';
import { isDeploymentNativeReadActionIdV1 } from '../../deployments/deploymentReadAdmissionV1.js';
import { DEPLOYMENT_BACKUP_CONFIGURE_INTENT_OPTIONS_V1 } from '../../deployments/deploymentBackupConfigureV1.js';
import { isDeploymentAccountPageActionIdV1 } from '../../deployments/deploymentActionIdsV1.js';
import { declareDeploymentPreparationScopeV1 } from './deploymentPreparationScope.js';
import { createDeploymentReadScopeV1, DEPLOYMENT_DATA_ROLE_CHILD_METADATA_READS_V1,
  DEPLOYMENT_DOMAIN_DISCOVERY_CHILD_METADATA_READS_V1, DEPLOYMENT_DOMAIN_DNS_CHILD_METADATA_READS_V1 } from './deploymentReadScope.js';

const deploymentDeployActionCompletionV1 = createDeploymentDeployActionCompletionV1(DeploymentActionOutputSchemasV1[deploymentActionIds.DEPLOYMENT_DEPLOY_ACTION_ID_V1]);
const deploymentDeployDescription = 'Deploy an existing saved Environment to a linked target. Discover the named Environment with deployments.environments.list, then use deployments.environments.get to choose its linked target. To deploy that saved definition, supply only serverId, environmentId and targetLinkId from those results. The Action prepares the exact deployment candidate, revisions and hashes for review. The contentArtifactId/contentHeaderVersion/contentBodyVersion input branch accepts an already prepared deployment candidate; Environment and target content Artifacts are not deployment candidates. No caller-authored candidate or shell hash calculation is needed.';
const deploymentRollbackDescription = 'Roll back to a historical deployment. Discover the saved Environment with deployments.environments.list or deployments.environments.get, then select deploymentId from deployments.receipts.list. Supply serverId, environmentId and deploymentId; requestKey and restoreBackupId are optional. Review shows the return version, the serving version it will replace, the target and whether restoring a backup will replace data. The prepared contentArtifactId/contentHeaderVersion/contentBodyVersion branch is also accepted.';
const deploymentTeardownDescription = 'Stop and remove a deployment from a saved Environment. Supply serverId, environmentId and reason: "manual" for an explicit request; the controller resolves the current target and exact runtime inventory. Set mode: "preview" to inspect the teardown first, and removeEnvironment: true to remove the saved Environment after teardown. targetLinkId, requestKey, volumes and machines are optional selections. Prepared content and revision fields are only needed when continuing an already prepared operation.';
const deploymentBackupConfigureDescription = 'Configure backups for a saved Environment, including before its first deployment. Test proves the selected repository without saving configuration; initializeAndSave explicitly creates a missing repository. Retain returned destinationSetup and setupOperation when continuing receiver setup. After kind: "configured", a captured nonnull review.creationDefaults.values.backupSchedule is a separate follow-up: resolve the Nightly backups starter through workflow.starters.list and workflow.starters.resolve, then call workflow.trigger.add with that exact schedule, backupEnvironment: { serverId, environmentId }, and backupPolicy containing the returned configuration except configRevision. Include verificationLevel: "manifestReadBack". The standing approval binds the Environment and destination policy; each occurrence resolves its current deployment. A null schedule means no schedule Action. If schedule authoring fails, retry only workflow.trigger.add; do not repeat Configure. Stopping after Configure leaves the backup configured with no schedule.';

type DeploymentActionSpec<TId extends DeploymentActionIdV1> = ActionSpecProjectionMetadata & Readonly<{
  id: TId;
  inputSchema: (typeof DeploymentActionInputSchemasV1)[TId];
  outputSchema: (typeof DeploymentActionOutputSchemasV1)[TId];
  approval: { result: 'required' };
  requiredAuthority: 'account_automation';
}>;

function deploymentSpec<TId extends DeploymentActionIdV1>(id: TId, title: string, path: string | undefined,
  description: string | undefined, read = false): DeploymentActionSpec<TId> {
  const accountPage = isDeploymentAccountPageActionIdV1(id);
  const voice = id === deploymentActionIds.DEPLOYMENT_ENVIRONMENT_LIST_ACTION_ID_V1;
  const toolName = id.replaceAll('.', '_');
  const backup = isDeploymentBackupActionIdV1(id);
  const dataSize = deploymentActionIds.isDeploymentDataSizeActionIdV1(id);
  const telemetrySet = id === deploymentActionIds.DEPLOYMENT_ENVIRONMENT_TELEMETRY_SET_ACTION_ID_V1;
  const backupConfigure = id === deploymentActionIds.DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1;
  const rollout = deploymentActionIds.isDeploymentRolloutActionIdV1(id);
  const irreversible = id === deploymentActionIds.DEPLOYMENT_BACKUP_PRUNE_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_TEARDOWN_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_TARGET_UNLINK_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_ENVIRONMENT_DELETE_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_DOMAINS_REMOVE_ACTION_ID_V1;
  const preparedContentRequired = id !== deploymentActionIds.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1 && id !== deploymentActionIds.DEPLOYMENT_TARGET_LINK_ACTION_ID_V1
    && id !== deploymentActionIds.DEPLOYMENT_ROLLBACK_ACTION_ID_V1 && id !== deploymentActionIds.DEPLOYMENT_TEARDOWN_ACTION_ID_V1 && id !== deploymentActionIds.DEPLOYMENT_DOMAIN_ADD_ACTION_ID_V1 && !backupConfigure && !telemetrySet && !isDeploymentPromoteActionIdV1(id);
  const previewForInput = id === deploymentActionIds.DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_TEARDOWN_ACTION_ID_V1
    ? (input: unknown): boolean => {
      const parsed = DeploymentActionInputSchemasV1[id].safeParse(input);
      return parsed.success && 'mode' in parsed.data && parsed.data.mode === 'preview';
    } : undefined;
  const secretPath = id === deploymentActionIds.DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1 ? 'set.[].source.ref'
    : id === deploymentActionIds.DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1 ? 'bindings.[].source.ref' : null;
  const inputHints = telemetrySet ? { description: 'Configure the Environment collector. Changes apply on redeploy. Moving or turning off deletes telemetry stored on the previous collector; confirmDelete acknowledges that deletion. Omit collector to use the Project default or runtime Machine.', fields: [
      { path: 'serverId', title: 'Home', widget: 'text', required: true },
      { path: 'environmentId', title: 'Environment', widget: 'text', required: true },
      { path: 'expectedRevision', title: 'Environment revision', widget: 'number', required: true },
      { path: 'collector', title: 'Collector, or null to turn off', widget: 'json' },
      { path: 'publicCollectorDomain', title: 'Public HTTPS Domain on the collector App (Vercel or Cloudflare Workers)', widget: 'json' },
      { path: 'rotate', title: 'Rotate the ingest token', widget: 'boolean' },
      { path: 'confirmDelete', title: 'Delete telemetry on the previous collector', widget: 'boolean' },
    ] } as const : deploymentActionIds.isDeploymentDomainDnsActionIdV1(id) ? { description: 'Create or inspect the DNS records already required by the retained Domain. Select a DNS Action, connected account, hosted zone and TTL. A configured match does not establish public propagation, route readiness or application health.', fields: [
      { path: 'serverId', title: 'Home', widget: 'text', required: true },
      { path: 'environmentId', title: 'Environment', widget: 'text', required: true },
      { path: 'domainId', title: 'Domain', widget: 'text', required: true },
      { path: 'expectedRevision', title: 'Environment revision', widget: 'number', required: true },
      { path: 'expectedDomainRevision', title: 'Domain revision', widget: 'number', required: true },
      { path: 'dns', title: 'DNS account, hosted zone, TTL and record Action', widget: 'json', required: true },
      { path: 'requestKey', title: 'Request key', widget: 'text', required: true },
    ] } as const : backupConfigure ? { description: deploymentBackupConfigureDescription, fields: [
      { path: 'serverId', title: 'Home', widget: 'text', required: true },
      { path: 'environmentId', title: 'Environment', widget: 'text', required: true },
      { path: 'expectedRevision', title: 'Environment revision', widget: 'number', required: true },
      { path: 'intent', title: 'Backup setup action', widget: 'select', required: true,
        options: DEPLOYMENT_BACKUP_CONFIGURE_INTENT_OPTIONS_V1 },
      { path: 'configuration', title: 'Destination and included sources', widget: 'json' },
    ] } as const : backup ? { fields: [
      { path: 'serverId', title: 'Home', widget: 'text', required: true },
      { path: 'environmentId', title: 'Environment', widget: 'text', required: true },
      { path: 'machineId', title: 'Runtime Machine', widget: 'text', required: true },
      { path: 'installationId', title: 'Machine installation', widget: 'text', required: true },
      { path: 'targetLinkId', title: 'Deployment target', widget: 'text', required: true },
      { path: 'deploymentId', title: 'Deployment receipt', widget: 'text', required: true },
      { path: 'expectedRevision', title: 'Environment revision', widget: 'number', required: true },
      { path: 'configRevision', title: 'Backup configuration revision', widget: 'number', required: true },
      ...(id === deploymentActionIds.DEPLOYMENT_BACKUP_VERIFY_ACTION_ID_V1 ? [
        { path: 'backupOperationId', title: 'Exact capture operation', widget: 'text' as const, required: true },
        { path: 'snapshotId', title: 'Exact snapshot', widget: 'text' as const, required: true },
        { path: 'level', title: 'Verification level', widget: 'text' as const, required: true },
      ] : []),
      ...(id === deploymentActionIds.DEPLOYMENT_BACKUP_PRUNE_ACTION_ID_V1 ? [
        { path: 'retention', title: 'Chosen retention policy', widget: 'json' as const, required: true },
      ] : []),
    ] } as const : id === deploymentActionIds.DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1 ? { fields: [
      { path: 'mode', title: 'Prepare, confirm or recover restore', widget: 'text', required: true },
      { path: 'serverId', title: 'Home', widget: 'text', required: true },
      { path: 'environmentId', title: 'Environment', widget: 'text', required: true },
      { path: 'machineId', title: 'Runtime Machine', widget: 'text', required: true },
      { path: 'installationId', title: 'Machine installation', widget: 'text', required: true },
      { path: 'targetLinkId', title: 'Current deployment target', widget: 'text', required: true },
      { path: 'deploymentId', title: 'Backup capture receipt', widget: 'text', required: true },
      { path: 'source', title: 'Repository snapshot or uploaded backup', widget: 'json', required: true },
      { path: 'destination', title: 'Database or named volume destination', widget: 'json' },
      { path: 'dataCheck', title: 'Confidential restored-data statement', widget: 'secret' },
      { path: 'snapshot', title: 'Take a Machine snapshot before replacing data', widget: 'boolean' },
      { path: 'snapshotReview', title: 'Provider snapshot facts retained by preparation', widget: 'json' },
      { path: 'expectedRevision', title: 'Environment revision', widget: 'number', required: true },
      { path: 'prepareOperationId', title: 'Prepared restore operation', widget: 'text' },
      { path: 'operationId', title: 'Restore operation to recover', widget: 'text' },
    ] } as const : id === deploymentActionIds.DEPLOYMENT_PUBLISH_PREPARE_ACTION_ID_V1 ? { fields: [
      { path: 'serverId', title: 'Home', widget: 'text', required: true },
      { path: 'machineId', title: 'Runtime Machine', widget: 'text', required: true },
      { path: 'installationId', title: 'Machine installation', widget: 'text', required: true },
      { path: 'projectSourceId', title: 'Existing Project source', widget: 'text' },
      { path: 'sourceRevision', title: 'Existing Source revision', widget: 'number' },
      { path: 'newProject', title: 'New repository-free Project and owner', widget: 'json' },
      { path: 'templateRef', title: 'Pinned catalog app', widget: 'json', required: true },
      { path: 'explicit', title: 'Your creation choices', widget: 'json' },
    ] } as const : id === deploymentActionIds.DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1 ? {
      description: 'Export the captured stored Compose definition through a repository pull request. Preview the existing-file diff first. Stored Compose remains active while the pull request is open. Continue with the original returned references after merge; changed merged or stored content requires explicit useMergedVersion review.',
      fields: [
        { path: 'mode', title: 'Preview or apply', widget: 'text', required: true },
        { path: 'serverId', title: 'Home', widget: 'text', required: true },
        { path: 'environmentId', title: 'Environment', widget: 'text', required: true },
        { path: 'definition', title: 'Captured stored definition', widget: 'json', required: true },
        { path: 'path', title: 'Repository Compose path', widget: 'text', required: true },
        { path: 'repository', title: 'Existing repository', widget: 'json' },
        { path: 'sourceRepository', title: 'Project repository attachment', widget: 'json' },
        { path: 'createRepository', title: 'Create repository', widget: 'json' },
        { path: 'workspace', title: 'Workspace reference', widget: 'json' },
        { path: 'baseCommit', title: 'Exact repository base', widget: 'text' },
        { path: 'baseBranch', title: 'Pull request base branch', widget: 'text' },
        { path: 'selectors', title: 'Compose selection', widget: 'json' },
        { path: 'continuation', title: 'Original pull request', widget: 'json' },
        { path: 'pullRequestReference', title: 'Reopen existing pull request', widget: 'json' },
        { path: 'repositoryWork', title: 'Acknowledged repository work', widget: 'json' },
        { path: 'useMergedVersion', title: 'Reviewed merged contents', widget: 'json' },
      ],
    } as const : id === deploymentActionIds.DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 ? {
      description: 'Preview the pinned deployment template before installing it. To add another service or database to an existing Environment, use intent: "add" and destination: { kind: "stored" }; the Action reads its saved definition and preserves existing services. Discover the Environment revision and target with deployments.environments.get; no internal Artifact read or caller-computed digest is needed. For each template generatedSecrets key, select bindings: [{ purpose: "variable", name: key, phase: "runtime", source: { kind: "generated", key } }]. Omitted generatedSecretAudience keeps new credentials private to their creator; explicit grants are reviewed. A new Environment with domainBindings deploys automatically even when deploy is omitted. If review.deploy is present, apply starts the app as well as saving its definition, bindings and routes; do not describe that preview as definition-only. An existing Environment deploys only when deploy is supplied.',
      fields: [
      { path: 'mode', title: 'Preview or apply', widget: 'text', required: true },
      { path: 'serverId', title: 'Home', widget: 'text', required: true },
      { path: 'machineId', title: 'Target Machine', widget: 'text', required: true },
      { path: 'projectSourceId', title: 'Existing Project source', widget: 'text' },
      { path: 'newProject', title: 'New repository-free Project and owner', widget: 'json' },
      { path: 'templateRef', title: 'Pinned registry app', widget: 'json', required: true },
      { path: 'environment', title: 'Environment', widget: 'json', required: true },
      { path: 'target', title: 'Runtime target', widget: 'json', required: true },
      { path: 'destination', title: 'Stored definition', widget: 'json', required: true },
      { path: 'bindings', title: 'Variable bindings', widget: 'json', required: true },
      { path: 'generatedSecretAudience', title: 'Generated credential audience', widget: 'json' },
      { path: 'connectTo', title: 'Connect application service', widget: 'json' },
      { path: 'replace', title: 'Explicit key replacements', widget: 'json' },
      { path: 'domainBindings', title: 'Domain bindings', widget: 'json' },
      { path: 'deploy', title: 'Deploy after committing the definition and bindings', widget: 'json' },
    ] } as const : id === deploymentActionIds.DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1 ? { fields: [
      { path: 'serverId', title: 'Home', widget: 'text', required: true },
      { path: 'environmentId', title: 'Environment', widget: 'text', required: true },
      { path: 'expectedRevision', title: 'Environment revision', widget: 'number', required: true },
      { path: 'set', title: 'Bindings to set', widget: 'json', required: true },
      { path: 'remove', title: 'Bindings to remove', widget: 'json', required: true },
    ] } as const : id === deploymentActionIds.DEPLOYMENT_PREPARE_ACTION_ID_V1 ? { fields: [
      { path: 'projectSourceId', title: 'Project source', widget: 'text', required: true },
      { path: 'sourceRevision', title: 'Source revision', widget: 'number', required: true },
      { path: 'repository', title: 'Repository', widget: 'json', required: true },
      { path: 'baseCommit', title: 'Base commit', widget: 'text', required: true },
      { path: 'workspace', title: 'Workspace reference', widget: 'json', required: true },
      { path: 'environmentId', title: 'Environment', widget: 'text' },
      { path: 'target', title: 'Target reference', widget: 'json' },
      { path: 'sessionRef', title: 'Existing Session', widget: 'json' },
      { path: 'importFrom', title: 'Import configuration references', widget: 'json' },
    ] } as const : id === deploymentActionIds.DEPLOYMENT_ROLLBACK_ACTION_ID_V1 ? {
      description: deploymentRollbackDescription,
      fields: [
        { path: 'serverId', title: 'Home', widget: 'text', required: true },
        { path: 'environmentId', title: 'Environment', widget: 'text', required: true },
        { path: 'deploymentId', title: 'Historical deployment receipt', widget: 'text', required: true },
        { path: 'requestKey', title: 'Request identity', widget: 'text' },
        { path: 'restoreBackupId', title: 'Backup to restore', widget: 'text' },
      ],
    } as const : id === deploymentActionIds.DEPLOYMENT_TEARDOWN_ACTION_ID_V1 ? {
      description: deploymentTeardownDescription,
      fields: [
        { path: 'serverId', title: 'Home', widget: 'text', required: true },
        { path: 'environmentId', title: 'Environment', widget: 'text', required: true },
        { path: 'reason', title: 'Teardown reason', widget: 'text', required: true },
        { path: 'mode', title: 'Preview without applying', widget: 'text' },
        { path: 'removeEnvironment', title: 'Remove saved Environment', widget: 'boolean' },
        { path: 'targetLinkId', title: 'Deployment target', widget: 'text' },
        { path: 'requestKey', title: 'Request identity', widget: 'text' },
        { path: 'volumes', title: 'Volume dispositions', widget: 'json' },
        { path: 'machines', title: 'Selected Machines', widget: 'json' },
      ],
    } as const : {
      ...(id === deploymentActionIds.DEPLOYMENT_DEPLOY_ACTION_ID_V1 ? { description: deploymentDeployDescription } : {}),
      ...(id === deploymentActionIds.DEPLOYMENT_LOGS_READ_ACTION_ID_V1 ? {
        description: 'Read the retained deployment log. Platform targets need serverId, environmentId, deploymentId and kind; the receipt supplies routing. Native Machine logs also need targetLinkId, machineId and installationId, plus service for runtime logs.',
      } : {}),
      fields: [
      { path: 'serverId', title: 'Home', widget: 'text', required: true },
      ...(id === deploymentActionIds.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_ENVIRONMENT_LIST_ACTION_ID_V1 || accountPage
        ? [{ path: 'projectSourceId', title: 'Project source', widget: 'text' as const }]
        : [{ path: 'environmentId', title: 'Environment', widget: 'text' as const, required: id !== deploymentActionIds.DEPLOYMENT_RECEIPT_GET_ACTION_ID_V1 }]),
      ...(id === deploymentActionIds.DEPLOYMENT_ENVIRONMENT_LIST_ACTION_ID_V1
        ? [{ path: 'machineId', title: 'Machine', widget: 'text' as const },
          { path: 'environmentIds', title: 'Exact Environment headers', widget: 'json' as const }] : []),
      ...(accountPage ? [{ path: 'cursor', title: 'Next page cursor', widget: 'text' as const },
        { path: 'limit', title: 'Page size', widget: 'number' as const }] : []),
      ...(dataSize ? [
        { path: 'deploymentId', title: 'Active deployment', widget: 'text' as const, required: true },
        { path: 'targetLinkId', title: 'Deployment target', widget: 'text' as const, required: true },
        { path: 'machineId', title: 'Runtime Machine', widget: 'text' as const, required: true },
        { path: 'installationId', title: 'Machine installation', widget: 'text' as const, required: true },
        { path: 'expectedRevision', title: 'Environment revision', widget: 'number' as const, required: true },
        { path: 'service', title: 'Database service', widget: 'text' as const, required: true },
      ] : []),
      ...(isDeploymentNativeReadActionIdV1(id) || id === deploymentActionIds.DEPLOYMENT_RESTART_ACTION_ID_V1 ? [
        { path: 'deploymentId', title: id === deploymentActionIds.DEPLOYMENT_LOGS_READ_ACTION_ID_V1 ? 'Deployment receipt' : 'Active deployment', widget: 'text' as const, required: true },
        { path: 'targetLinkId', title: id === deploymentActionIds.DEPLOYMENT_LOGS_READ_ACTION_ID_V1 ? 'Native Machine deployment target' : 'Deployment target', widget: 'text' as const, required: id !== deploymentActionIds.DEPLOYMENT_LOGS_READ_ACTION_ID_V1 },
        { path: 'machineId', title: 'Selected Machine', widget: 'text' as const, required: id !== deploymentActionIds.DEPLOYMENT_LOGS_READ_ACTION_ID_V1 },
        { path: 'installationId', title: 'Machine installation', widget: 'text' as const, required: id !== deploymentActionIds.DEPLOYMENT_LOGS_READ_ACTION_ID_V1 },
        { path: 'service', title: 'Stable service identity', widget: 'json' as const, required: id !== deploymentActionIds.DEPLOYMENT_LOGS_READ_ACTION_ID_V1 },
        ...(id === deploymentActionIds.DEPLOYMENT_RESTART_ACTION_ID_V1 ? [{ path: 'expectedGeneration', title: 'Service generation', widget: 'text' as const, required: true }] : []),
        ...(id === deploymentActionIds.DEPLOYMENT_DRIFT_READ_ACTION_ID_V1 ? [{ path: 'expectedRevision', title: 'Environment revision', widget: 'number' as const, required: true }] : []),
        ...(id === deploymentActionIds.DEPLOYMENT_LOGS_READ_ACTION_ID_V1 ? [{ path: 'kind', title: 'Build or runtime logs', widget: 'text' as const, required: true },
          { path: 'ref', title: 'Receipt step log reference', widget: 'text' as const },
          { path: 'tail', title: 'Latest masked log window', widget: 'boolean' as const },
          { path: 'cursor', title: 'Native log cursor', widget: 'json' as const }] : []),
      ] : []),
      ...(id === deploymentActionIds.DEPLOYMENT_RECEIPT_GET_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_RECEIPT_OBSERVE_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_ROLLBACK_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_CANCEL_ACTION_ID_V1
        ? [{ path: 'deploymentId', title: 'Deployment receipt', widget: 'text' as const, required: true }] : []),
      ...(id === deploymentActionIds.DEPLOYMENT_CANCEL_ACTION_ID_V1
        ? [{ path: 'expectedReceiptRevision', title: 'Receipt revision', widget: 'number' as const, required: true }] : []),
      ...(isDeploymentPromoteActionIdV1(id) ? [
        { path: 'sourceEnvironmentId', title: 'Source Environment', widget: 'text' as const, required: true },
        { path: 'sourceDeploymentId', title: 'Source deployment receipt', widget: 'text' as const, required: true },
        { path: 'artifact', title: 'Recorded image or explicit rebuild', widget: 'text' as const, required: true },
        { path: 'requestKey', title: 'Request identity', widget: 'text' as const },
      ] : []),
      ...(id === deploymentActionIds.DEPLOYMENT_ENVIRONMENTS_CONTROLLER_SET_ACTION_ID_V1
        ? [{ path: 'expectedRevision', title: 'Environment revision', widget: 'number' as const, required: true },
          { path: 'controllerMachineId', title: 'Controller Machine', widget: 'text' as const, required: true }] : []),
      ...(id === deploymentActionIds.DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1
        ? [{ path: 'patch.buildMachineId', title: 'Build Machine', widget: 'text' as const, required: false },
          { path: 'patch.protection', title: 'Protection', widget: 'text' as const, required: false }] : []),
      ...(id === deploymentActionIds.DEPLOYMENT_TARGET_UNLINK_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_ENVIRONMENT_DELETE_ACTION_ID_V1 ? [
        { path: 'expectedRevision', title: 'Environment revision', widget: 'number' as const, required: true },
        { path: 'requestKey', title: 'Request identity', widget: 'text' as const, required: true },
        { path: 'detachKeepRunning', title: 'Detach and keep running', widget: 'boolean' as const },
        ...(id === deploymentActionIds.DEPLOYMENT_TARGET_UNLINK_ACTION_ID_V1 ? [
          { path: 'targetLinkId', title: 'Deployment target', widget: 'text' as const, required: true },
          { path: 'expectedTargetLinkRevision', title: 'Target revision', widget: 'number' as const, required: true },
          { path: 'teardownDeploymentId', title: 'Settled teardown receipt', widget: 'text' as const },
        ] : [{ path: 'teardownDeploymentIds', title: 'Settled teardown receipts', widget: 'json' as const }]),
      ] : []),
      ...(id === deploymentActionIds.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1
        ? [{ path: 'mode', title: 'Preview or apply authored creation', widget: 'text' as const },
          { path: 'name', title: 'New Environment name', widget: 'text' as const },
          { path: 'newProject', title: 'New repository-free Project and owner', widget: 'json' as const },
          { path: 'definition', title: 'Repository, catalog App, Compose or image intent', widget: 'json' as const },
          { path: 'bindings', title: 'Catalog variable bindings', widget: 'json' as const },
          { path: 'generatedSecretAudience', title: 'Generated catalog credential audience', widget: 'json' as const },
          { path: 'domainBindings', title: 'Catalog domain bindings', widget: 'json' as const },
          { path: 'controllerMachineId', title: 'Explicit controller choice', widget: 'text' as const },
          { path: 'buildMachineId', title: 'Explicit builder choice', widget: 'text' as const },
          { path: 'retainPreviousDeployments', title: 'Explicit retained-release count', widget: 'number' as const },
          { path: 'firstTargetLink', title: 'First own-server target and prepared content', widget: 'json' as const }] : []),
      ...(id === deploymentActionIds.DEPLOYMENT_DEPLOY_ACTION_ID_V1 ? [{ path: 'targetLinkId', title: 'Deployment target', widget: 'text' as const, required: true }] : []),
      ...(id === deploymentActionIds.DEPLOYMENT_DOMAIN_ADD_ACTION_ID_V1 ? [
        { path: 'content', title: 'Authored Domain routing', widget: 'json' as const },
      ] : []),
      ...(read || id === deploymentActionIds.DEPLOYMENT_DEPLOY_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_RESTART_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_CANCEL_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_ENVIRONMENTS_CONTROLLER_SET_ACTION_ID_V1
        || id === deploymentActionIds.DEPLOYMENT_TARGET_UNLINK_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_ENVIRONMENT_DELETE_ACTION_ID_V1 || isDeploymentDomainRemoveActionIdV1(id) ? [] : [
        { path: 'contentArtifactId', title: 'Prepared content', widget: 'text' as const, required: preparedContentRequired },
        { path: 'contentHeaderVersion', title: 'Content header revision', widget: 'number' as const, required: preparedContentRequired },
        { path: 'contentBodyVersion', title: 'Content body revision', widget: 'number' as const, required: preparedContentRequired },
      ]),
    ] } as const;
  return {
    id, title, safety: read ? 'safe' : 'danger', sideEffectClass: read ? 'read' : 'write',
    description: description ?? ('description' in inputHints ? inputHints.description : undefined),
    ...(previewForInput ? { safetyForInput: (input: unknown): 'safe' | 'danger' => previewForInput(input) ? 'safe' : 'danger' } : {}),
    ...(id === deploymentActionIds.DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1 ? { permissionChangingForInput: (input: unknown): boolean => {
      const parsed = DeploymentActionInputSchemasV1[deploymentActionIds.DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1].safeParse(input);
      const patch = parsed.success ? parsed.data.patch : undefined;
      // Who may deploy or edit the Environment's databases, and how far agents may go, are all authority changes.
      return patch !== undefined && [patch.deployerMode, patch.deployerPrincipals, patch.dataEditorMode, patch.dataEditors,
        patch.dataAgentAccess].some(value => value !== undefined);
    } } : {}),
    approval: { result: 'required' }, approvalPolicy: { uiConfirmation: irreversible || rollout ? 'policy' : 'direct',
      ...(id === deploymentActionIds.DEPLOYMENT_TEARDOWN_ACTION_ID_V1 && previewForInput
        ? { uiConfirmationForInput: (input: unknown): boolean => !previewForInput(input) } : {}) },
    ...(irreversible ? { irreversible: true as const } : {}),
    ...(id === deploymentActionIds.DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1
      ? { automationPrimarySubject: null }
      : backup || backupConfigure || id === deploymentActionIds.DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1
        ? { automationPrimarySubject: { kind: 'backup' as const, field: 'environmentId' } } : {}),
    ...(id === deploymentActionIds.DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1 ? { approvalNarrowing: deploymentBindingSelectionNarrowing } : {}),
    ...(id !== deploymentActionIds.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1 && id !== deploymentActionIds.DEPLOYMENT_ENVIRONMENT_LIST_ACTION_ID_V1 && id !== deploymentActionIds.DEPLOYMENT_PUBLISH_PREPARE_ACTION_ID_V1 && !accountPage
      ? { approvalScope: id === deploymentActionIds.DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1
        ? { subjectKinds: ['environment', 'backup', 'database'] as const, project: (input: unknown) => {
          const target = DeploymentActionInputSchemasV1[deploymentActionIds.DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1].parse(input);
          return { scope: 'environment' as const, subjects: [
            { kind: 'backup' as const, serverId: target.serverId, environmentId: target.environmentId },
            ...('destination' in target && target.destination?.kind === 'database' ? [{
              kind: 'database' as const, serverId: target.serverId,
              target: { kind: 'environment' as const, environmentId: target.environmentId,
                service: target.destination.service, database: target.destination.database },
            }] : []),
          ] };
        } }
        : backup || backupConfigure
        ? { subjectKinds: ['environment', 'backup'] as const, project: (input: unknown) => {
          const target = DeploymentActionInputSchemasV1[id].parse(input);
          return { scope: 'environment' as const, subjects: 'serverId' in target && typeof target.serverId === 'string'
            && 'environmentId' in target && typeof target.environmentId === 'string'
            ? [{ kind: 'backup' as const, serverId: target.serverId, environmentId: target.environmentId }] : [] };
        } }
        : 'environment' } : {}),
    executionPlacement: isDeploymentTargetLinkActionIdV1(id) || rollout || dataSize || backup || backupConfigure || telemetrySet || deploymentActionIds.isDeploymentDomainDnsActionIdV1(id) || isDeploymentDomainChildActionIdV1(id) || id === deploymentActionIds.DEPLOYMENT_PREPARE_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_PUBLISH_PREPARE_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_RESTART_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_RECEIPT_OBSERVE_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_OBSERVATION_GET_ACTION_ID_V1 ? 'machine' : 'account', requiredAuthority: 'account_automation', placements: [],
    ...(id === deploymentActionIds.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1 ? {
      approvalScope: { subjectKinds: ['environment'] as const },
      executionPlacements: ['account', 'machine'],
      executionPlacementForInput: (input: unknown): 'account' | 'machine' => {
        const intent = readRecord(input);
        return intent.copyFrom !== undefined || intent.preview !== undefined || intent.contentArtifactId === undefined ? 'machine' : 'account';
      },
      machineRuntimeDemandForInput: (input: unknown) => {
        const parsed = DeploymentActionInputSchemasV1[deploymentActionIds.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1].safeParse(input);
        return parsed.success && 'contentArtifactId' in parsed.data && parsed.data.preview
          ? { target: { kind: 'machine' as const, machineId: parsed.data.controllerMachineId }, serverId: parsed.data.serverId }
          : null;
      },
    } : {}),
    ...(id === deploymentActionIds.DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1 && previewForInput ? {
      executionPlacements: ['account', 'machine'],
      executionPlacementForInput: (input: unknown): 'account' | 'machine' => previewForInput(input) ? 'machine' : 'account',
    } : {}),
    ...(id === deploymentActionIds.DEPLOYMENT_TEARDOWN_ACTION_ID_V1 ? { executionPlacements: ['account', 'machine'],
      executionPlacementForInput: (input: unknown): 'account' | 'machine' =>
        readRecord(input).detachKeepRunning === true ? 'account' : 'machine' } : {}),
    ...(id === deploymentActionIds.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_RECEIPT_OBSERVE_ACTION_ID_V1 || deploymentActionIds.isDeploymentDomainDnsActionIdV1(id) || isDeploymentDomainChildActionIdV1(id)
      ? { originalExecution: { daemonIngressSurfaces: ['cli'] as const } } : deploymentActionIds.isDeploymentMembershipActionIdV1(id) || backup || backupConfigure || telemetrySet || id === deploymentActionIds.DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1
        ? { originalExecution: { daemonIngressSurfaces: ['ui'] as const } } : {}),
    // Machine placement uses the original Action dispatcher, not a standalone RPC method.
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice, rpc: false },
    bindings: {
      mcpToolName: toolName,
      ...(voice ? { voiceClientToolName: toolName } : {}),
      ...(id === deploymentActionIds.DEPLOYMENT_PUBLISH_PREPARE_ACTION_ID_V1 ? { sdkMethod: deploymentActionIds.DEPLOYMENT_PREPARE_PUBLISH_CATALOG_ACTION_ID_V1 } : {}),
    },
    cli: { acceptsServerId: true, commands: [{ path: id === deploymentActionIds.DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1
      ? ['deployments', 'environments', 'move-to-repository'] : id.split('.'), visibility: 'canonical' }] },
    ...(path === undefined ? {} : { serverTransport: { method: read ? 'GET' : id === deploymentActionIds.DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1 ? 'PATCH' : 'POST', path, preservePathFieldsInBody: true } }),
    inputSchema: DeploymentActionInputSchemasV1[id], outputSchema: DeploymentActionOutputSchemasV1[id],
    deploymentPreparationScope: declareDeploymentPreparationScopeV1('root'),
    deploymentReadScope: createDeploymentReadScopeV1(),
    invocationServerIdForInput: actionInputServerId(DeploymentActionInputSchemasV1[id], (input) => {
      const serverId = readRecord(input).serverId;
      return typeof serverId === 'string' ? serverId : undefined;
    }),
    ...(id === deploymentActionIds.DEPLOYMENT_DEPLOY_ACTION_ID_V1 ? { completion: deploymentDeployActionCompletionV1 } : {}),
    // The retry key, target link and prepared-content pins say which request and bytes, not what it does; the
    // request's summary and the host's deploy review say that. Approval reads them under Technical details.
    ...(rollout ? { approvalPresentation: { summary: () => null,
      technicalInputPaths: ['requestKey', 'targetLinkId', 'contentArtifactId', 'contentHeaderVersion', 'contentBodyVersion',
        ...(id === deploymentActionIds.DEPLOYMENT_ROLLBACK_ACTION_ID_V1 ? ['deploymentId', 'restoreBackupId'] : []),
        ...(id === deploymentActionIds.DEPLOYMENT_PROMOTE_ACTION_ID_V1 ? ['destinationContent'] : [])] } } : {}),
    ...(id === deploymentActionIds.DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1 ? { approvalPresentation: {
      summary: (input: unknown) => {
        const parsed = DeploymentActionInputSchemasV1[deploymentActionIds.DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1].safeParse(input);
        const preview = parsed.success ? parsed.data.patch?.previewTemplate : undefined;
        return parsed.success && parsed.data.mode !== 'preview' && preview?.enabled && preview.repository.kind === 'github'
          ? 'When GitHub can reach this Home, Happier also receives pull request events from this repository if previews are enabled.'
          : null;
      },
    } } : {}),
    // A link names its Home; the Environment, target declaration, provider operands and pinned content only route
    // the request. A create reads through the host's review, an association through its summary.
    ...(isDeploymentTargetLinkActionIdV1(id) ? { approvalPresentation: {
      technicalInputPaths: ['environmentId', 'expectedRevision', 'requestKey', 'targetId', 'role', 'source', 'targetKind',
        'machines', 'contentArtifactId', 'contentHeaderVersion', 'contentBodyVersion'] } } : {}),
    // A restore is approved by its consequence; every id only correlates the request with the Environment, the
    // capture receipt and the prepared operation, so they read under Technical details. The Machine stays named.
    ...(id === deploymentActionIds.DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1 ? { approvalPresentation: {
      summary: (input: unknown) => {
        const parsed = DeploymentActionInputSchemasV1[deploymentActionIds.DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1].safeParse(input);
        return parsed.success ? summarizeDeploymentRestoreReviewV1(parsed.data) : null;
      },
      technicalInputPaths: ['mode', 'serverId', 'environmentId', 'installationId', 'targetLinkId', 'deploymentId',
        'source', 'destination', 'snapshot', 'snapshotReview', 'expectedRevision', 'prepareOperationId', 'operationId'] } } : {}),
    // A person approves where backups go by its consequence; the destination's plugin, ids and stored
    // configuration only correlate the request and read under Technical details.
    ...(backupConfigure ? { approvalPresentation: {
      summary: (input: unknown) => {
        const intent = readRecord(input).intent;
        return intent === 'test' ? 'Checks that the backup destination can be reached. Nothing is saved.'
          : intent === 'initializeAndSave' ? 'Creates a backup repository at the destination and saves this Environment’s backup setup.'
          : intent === 'rekeyAndSave' ? 'Re-keys this Environment’s backups and saves the new setup.'
          : intent === 'markNotNeeded' ? 'Records that this Environment has nothing to back up.'
          : 'Saves where this Environment’s backups go.';
      },
      // The press's own title says which setup action it is; the chosen defaults and credential bindings are the
      // configuration's plumbing (plugin ids, roles, saved-secret refs), never the decision (R15-D3).
      technicalInputPaths: ['serverId', 'environmentId', 'expectedRevision', 'intent', 'configuration', 'explicit',
        'backupBindings', 'destinationSetup'] } } : {}),
    inputHints,
    ...(isDeploymentTargetLinkActionIdV1(id) || backupConfigure || backup && !isDeploymentBackupReadActionIdV1(id) || id === deploymentActionIds.DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_DOMAIN_ADD_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_DOMAINS_REMOVE_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_DEPLOY_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_ROLLBACK_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_RESTART_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_PROMOTE_ACTION_ID_V1 || id === deploymentActionIds.DEPLOYMENT_TEARDOWN_ACTION_ID_V1 ? {
      operation: { version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' } },
    } : {}),
    // Review describes the stored ref string; the interactive picker selects a ref/revision pair.
    ...(secretPath ? { approvalPresentation: {
      referenceForField: (path: string, value: unknown) => path === secretPath
        ? readApprovalSavedSecretReference('', undefined, value, { hostType: 'savedSecretReference' }) : undefined,
    } } : {}),
  } as const satisfies DeploymentActionSpec<TId>;
}

type DeploymentTargetCheckActionSpec = ActionSpecProjectionMetadata & Readonly<{
  id: typeof deploymentActionIds.DEPLOYMENT_TARGET_CHECK_ACTION_ID_V1;
  inputSchema: typeof DeploymentTargetCheckInputV1Schema;
  outputSchema: typeof DeploymentTargetCheckResultV1Schema;
  approval: { result: 'none' };
}>;

// Name the per-id schema union so declaration emission does not serialize the
// factory's entire inferred array of spread Action metadata and schemas.
export type DeploymentActionSpecsV1 = ReadonlyArray<
  { [TId in DeploymentActionIdV1]: DeploymentActionSpec<TId> }[DeploymentActionIdV1]
  | DeploymentTargetCheckActionSpec
>;

/** Storage declarations and real daemon effects share this single Action front door. */
function createDeploymentActionSpecsV1(): DeploymentActionSpecsV1 {
  return [
  { ...deploymentSpec(deploymentActionIds.DEPLOYMENT_DOMAIN_ADD_ACTION_ID_V1, 'Add or update deployment domain', '/v1/deployments/environments/:environmentId/domains', 'Add or update the route for an Environment hostname. Choose the intended service and ingress; the reviewed operation can configure provider routing and own-server ingress.'),
    deploymentReadScope: createDeploymentReadScopeV1({ childMayMaterializeDomainUse: true,
      childMetadataReads: DEPLOYMENT_DOMAIN_DISCOVERY_CHILD_METADATA_READS_V1 }),
    requesterAccountContentDemandForInput: () => true,
    approvalPresentation: {
      summary: () => 'Configure this Domain. For own-server ingress, this may replace an unchanged Happier Caddy startup seed with the selected public or private configuration. When Tunnel ingress needs Caddy setup, it uses a private seed and may recreate a failed, never-started Happier Caddy container. Custom seed files require reconciliation; live routes and certificate state are retained.',
    } },
  { ...deploymentSpec(deploymentActionIds.DEPLOYMENT_DOMAINS_REMOVE_ACTION_ID_V1, 'Remove deployment domain', '/v1/deployments/environments/:environmentId/domains/:domainId/remove', 'Remove a retained Domain using its Environment and Domain revisions. Review the ingress and provider resources affected before applying.'),
    deploymentReadScope: createDeploymentReadScopeV1({ childMetadataReads: DEPLOYMENT_DOMAIN_DISCOVERY_CHILD_METADATA_READS_V1 }), requesterAccountContentDemandForInput: () => true },
  { ...deploymentSpec(deploymentActionIds.DEPLOYMENT_DOMAIN_DNS_CREATE_ACTION_ID_V1, 'Create required DNS records', undefined, 'Create the missing DNS records required by a retained Domain in the selected account and zone. Preserve existing records and report conflicts.'), deploymentPreparationScope: declareDeploymentPreparationScopeV1('membership'), requesterAccountContentDemandForInput: () => true,
    approvalPresentation: { summary: () => 'Create the records required by this Domain using the selected DNS account, hosted zone and TTL. Existing records are preserved.' } },
  { ...deploymentSpec(deploymentActionIds.DEPLOYMENT_DOMAIN_DNS_VERIFY_ACTION_ID_V1, 'Verify required DNS record configuration', undefined, 'Compare the retained Domain’s required records with the selected DNS zone. This read does not prove propagation or application health.', true), deploymentPreparationScope: declareDeploymentPreparationScopeV1('membership'), requesterAccountContentDemandForInput: () => true },
  { ...deploymentSpec(deploymentActionIds.DEPLOYMENT_DOMAIN_VERIFY_ACTION_ID_V1, 'Verify deployment domain', undefined, 'Check the selected Environment Domain against its configured routing and return the observed state.', true),
    deploymentReadScope: createDeploymentReadScopeV1({ childMetadataReads: DEPLOYMENT_DOMAIN_DNS_CHILD_METADATA_READS_V1 }), requesterAccountContentDemandForInput: () => true },
  deploymentSpec(deploymentActionIds.DEPLOYMENT_DOMAIN_GET_ACTION_ID_V1, 'Read deployment domain', '/v1/deployments/environments/:environmentId/domains/:domainId', 'Read one saved Domain record by Environment and Domain id, including its routing state and revision.', true),
  deploymentSpec(deploymentActionIds.DEPLOYMENT_DOMAIN_LIST_ACTION_ID_V1, 'List deployment domains', '/v1/deployments/environments/:environmentId/domains', 'List saved Domain records for one Environment. Follow the returned cursor to continue.', true),
  deploymentSpec(deploymentActionIds.DEPLOYMENT_DOMAIN_PAGE_ACTION_ID_V1, 'List accessible domains', '/v1/deployments/domains', 'Page through Domains visible to the caller across Environments on the selected Home.', true),
  deploymentSpec(deploymentActionIds.DEPLOYMENT_DATA_PAGE_ACTION_ID_V1, 'List accessible data services', '/v1/deployments/data-services', 'Page through data services visible to the caller on the selected Home, including linked managed services.', true),
  { ...deploymentSpec(deploymentActionIds.DEPLOYMENT_PUBLISH_PREPARE_ACTION_ID_V1, 'Prepare catalog app publishing', undefined, 'Prepare the captured Environment as a catalog App and return the material needed for the separate publication step.', true), requesterAccountContentDemandForInput: () => true },
  { ...deploymentSpec(deploymentActionIds.DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1, 'Install Store app', undefined, undefined), deploymentPreparationScope: declareDeploymentPreparationScopeV1('template'), requesterAccountContentDemandForInput: () => true },
  { ...deploymentSpec(deploymentActionIds.DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1, 'Move Environment to a repository', undefined, undefined), deploymentPreparationScope: declareDeploymentPreparationScopeV1('move'), requesterAccountContentDemandForInput: () => true },
  deploymentSpec(deploymentActionIds.DEPLOYMENT_PREPARE_ACTION_ID_V1, 'Ask an agent to prepare deployment', undefined, 'Ask an agent in the chosen Project checkout to prepare a deployment definition for the person to review.'),
  { ...deploymentSpec(deploymentActionIds.DEPLOYMENT_HEALTH_READ_ACTION_ID_V1, 'Read deployed service health', undefined, 'Read health evidence for the selected deployed service under the recorded runtime target.', true), requesterAccountContentDemandForInput: () => true },
  { ...deploymentSpec(deploymentActionIds.DEPLOYMENT_HEALTH_CURRENT_ACTION_ID_V1, 'Read current Environment edge health', undefined, 'Read the current edge health for the selected Environment. This read does not run or configure a saved Check.', true),
    deploymentReadScope: createDeploymentReadScopeV1({ target: 'current_health' }) },
  { ...deploymentSpec(deploymentActionIds.DEPLOYMENT_DRIFT_READ_ACTION_ID_V1, 'Read deployed service drift', undefined, 'Compare the retained expected deployment with the observed runtime for the selected Environment and report drift.', true),
    deploymentReadScope: createDeploymentReadScopeV1({ requireEnvironmentRevision: true }), requesterAccountContentDemandForInput: () => true },
  { ...deploymentSpec(deploymentActionIds.DEPLOYMENT_LOGS_READ_ACTION_ID_V1, 'Read deployment logs', undefined, undefined, true),
    deploymentReadScope: createDeploymentReadScopeV1({ target: 'historical_receipt' }), requesterAccountContentDemandForInput: (input: unknown) => readRecord(input).kind === 'build' },
  { ...deploymentSpec(deploymentActionIds.DEPLOYMENT_DATA_SIZE_ACTION_ID_V1, 'Read deployment database size', undefined, 'Read the size of the selected Environment database through its linked target.', true),
    deploymentReadScope: createDeploymentReadScopeV1({ requireEnvironmentRevision: true }), requesterAccountContentDemandForInput: () => true },
  { ...deploymentSpec(deploymentActionIds.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, 'Create deployment environment', '/v1/deployments/environments', 'Review or save a new Environment. Supply its Project and definition, use copyFrom to duplicate a saved Environment, or select an enrolled Preview template and branch.'),
    operation: { version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' } },
    deploymentPreparationScope: declareDeploymentPreparationScopeV1('create'), requesterAccountContentDemandForInput: () => true },
  { ...deploymentSpec(deploymentActionIds.DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1, 'Update deployment environment', '/v1/deployments/environments/:environmentId', 'Update the saved Environment at its expected revision. Preview mode reviews selected configuration changes or defaults without saving them.'), deploymentPreparationScope: declareDeploymentPreparationScopeV1('update'), requesterAccountContentDemandForInput: () => true },
  { ...deploymentSpec(deploymentActionIds.DEPLOYMENT_ENVIRONMENT_TELEMETRY_SET_ACTION_ID_V1, 'Configure Environment telemetry', undefined, undefined), requesterAccountContentDemandForInput: () => true },
  deploymentSpec(deploymentActionIds.DEPLOYMENT_ENVIRONMENTS_CONTROLLER_SET_ACTION_ID_V1, 'Change environment controller', '/v1/deployments/environments/:environmentId/controller', 'Move coordination of Environment jobs and checks to the selected controller Machine. The running workload stays on its existing target.'),
  { ...deploymentSpec(deploymentActionIds.DEPLOYMENT_TARGET_LINK_ACTION_ID_V1, 'Link deployment target', '/v1/deployments/environments/:environmentId/targets', 'Link a reviewed runtime or data target to an Environment at its expected revision. Use the target catalog to obtain the target’s supported placement and operands.'),
    deploymentPreparationScope: declareDeploymentPreparationScopeV1('link'),
    requesterAccountContentDemandForInput: (input: unknown) => {
      const link = readRecord(input);
      return !('contentArtifactId' in link) || link.role === 'runtime' && readRecord(link.source).kind === 'plugin';
    } },
  deploymentSpec(deploymentActionIds.DEPLOYMENT_TARGET_UNLINK_ACTION_ID_V1, 'Unlink deployment target', '/v1/deployments/environments/:environmentId/targets/:targetLinkId/unlink', 'Remove the specified target association from the Environment. Deleting provider resources is a separate reviewed operation.'),
  deploymentSpec(deploymentActionIds.DEPLOYMENT_ENVIRONMENT_DELETE_ACTION_ID_V1, 'Delete deployment environment', '/v1/deployments/environments/:environmentId/delete', 'Remove the saved Environment record after its dependencies permit deletion. Use teardown when deployed resources also need to be removed.'),
  { ...deploymentSpec(deploymentActionIds.DEPLOYMENT_DEPLOY_ACTION_ID_V1, 'Deploy environment', '/v1/deployments/environments/:environmentId/deploy', undefined), deploymentPreparationScope: declareDeploymentPreparationScopeV1('membership'), requesterAccountContentDemandForInput: () => true },
  { ...deploymentSpec(deploymentActionIds.DEPLOYMENT_ROLLBACK_ACTION_ID_V1, 'Roll back deployment', '/v1/deployments/environments/:environmentId/rollback', undefined), deploymentPreparationScope: declareDeploymentPreparationScopeV1('membership'), requesterAccountContentDemandForInput: () => true },
  deploymentSpec(deploymentActionIds.DEPLOYMENT_RESTART_ACTION_ID_V1, 'Restart deployed service', undefined, 'Restart the deployed service through its current runtime target and record the outcome for the Environment.'),
  { ...deploymentSpec(deploymentActionIds.DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1, 'Restore deployment backup', undefined, 'Review or apply restoration of a selected backup snapshot into the specified destination. Review includes destination placement and effects on existing data.'),
    projectObservationInput: redactObservationInputPaths('dataCheck'),
    projectObservationOutput: redactObservationInputPaths('evidence.dataCheck', 'evidence.input.dataCheck'),
    deploymentReadScope: createDeploymentReadScopeV1({ target: 'restore_receipt', requireEnvironmentRevision: true }), requesterAccountContentDemandForInput: () => true },
  { ...deploymentSpec(deploymentActionIds.DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1, 'Configure deployment backups', undefined, undefined), requesterAccountContentDemandForInput: () => true },
  { ...deploymentSpec(deploymentActionIds.DEPLOYMENT_BACKUP_TEST_ACTION_ID_V1, 'Test backup destination', undefined, 'Test the configured backup repository with a probe that writes, reads and removes its own test snapshot.'),
    deploymentReadScope: createDeploymentReadScopeV1({ requireEnvironmentRevision: true }), requesterAccountContentDemandForInput: () => true },
  { ...deploymentSpec(deploymentActionIds.DEPLOYMENT_BACKUP_HISTORY_ACTION_ID_V1, 'Read backup history', undefined, 'Read the retained capture, verification and cleanup history for the Environment’s backup policy.', true),
    deploymentReadScope: createDeploymentReadScopeV1({ requireEnvironmentRevision: true }), requesterAccountContentDemandForInput: () => true },
  { ...deploymentSpec(deploymentActionIds.DEPLOYMENT_BACKUP_INVENTORY_ACTION_ID_V1, 'List deployment backups', undefined, 'List restorable snapshots at the selected Environment backup destination.', true),
    deploymentReadScope: createDeploymentReadScopeV1({ requireEnvironmentRevision: true }), requesterAccountContentDemandForInput: () => true },
  { ...deploymentSpec(deploymentActionIds.DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1, 'Back up deployment', undefined, 'Capture an on-demand backup using the saved destination and source policy for this Environment.'),
    deploymentReadScope: createDeploymentReadScopeV1({ requireEnvironmentRevision: true }), requesterAccountContentDemandForInput: () => true },
  { ...deploymentSpec(deploymentActionIds.DEPLOYMENT_BACKUP_VERIFY_ACTION_ID_V1, 'Verify deployment backup', undefined, 'Verify a retained backup snapshot through its configured repository and return the verification result.', true),
    deploymentReadScope: createDeploymentReadScopeV1({ requireEnvironmentRevision: true }), requesterAccountContentDemandForInput: () => true },
  { ...deploymentSpec(deploymentActionIds.DEPLOYMENT_BACKUP_PRUNE_ACTION_ID_V1, 'Apply backup retention', undefined, 'Apply the saved backup retention policy to eligible snapshots in the Environment’s configured repository.'),
    deploymentReadScope: createDeploymentReadScopeV1({ requireEnvironmentRevision: true }), requesterAccountContentDemandForInput: () => true },
  { ...deploymentSpec(deploymentActionIds.DEPLOYMENT_CANCEL_ACTION_ID_V1, 'Cancel deployment', '/v1/deployments/environments/:environmentId/deployments/:deploymentId/transitions', 'Ask the owner of the specified in-progress deployment to stop it and retain the cancellation result.'),
    executionPlacement: 'machine', executionPlacements: ['machine', 'account'],
    originalExecution: { daemonIngressSurfaces: ['cli'] }, requesterAccountContentDemandForInput: () => true },
  { ...deploymentSpec(deploymentActionIds.DEPLOYMENT_PROMOTE_ACTION_ID_V1, 'Promote deployment', '/v1/deployments/environments/:environmentId/promote', 'Take a successful Preview receipt to the selected destination Environment after reviewing target and binding differences.'), deploymentPreparationScope: declareDeploymentPreparationScopeV1('membership'), requesterAccountContentDemandForInput: () => true },
  { ...deploymentSpec(deploymentActionIds.DEPLOYMENT_TEARDOWN_ACTION_ID_V1, 'Tear down deployment resources', '/v1/deployments/environments/:environmentId/teardown', undefined), deploymentPreparationScope: declareDeploymentPreparationScopeV1('membership'),
    deploymentReadScope: createDeploymentReadScopeV1({ childReadOnly: true }), operationReentry: deploymentTeardownOperationReentryV1, requesterAccountContentDemandForInput: (input: unknown) => !('detachKeepRunning' in readRecord(input)) },
  { ...deploymentSpec(deploymentActionIds.DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1, 'Read deployment environment', '/v1/deployments/environments/:environmentId', 'Read one accessible Environment by id, including its current revision and linked targets.', true),
    originalExecution: { daemonIngressSurfaces: [] } },
  {
    id: deploymentActionIds.DEPLOYMENT_TARGET_CHECK_ACTION_ID_V1, title: 'Check deployment target',
    description: 'Check a chosen provider target and report a saved Environment already linked to the same provider scope. Fields are the target Inspect Action’s product operands. No resource is attached.',
    executionPlacement: 'account', originalExecution: { accountRoot: 'allowed' },
    approval: { result: 'none' }, safety: 'safe', sideEffectClass: 'read', placements: [],
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    deploymentPreparationScope: declareDeploymentPreparationScopeV1('targetCheck'),
    inputSchema: DeploymentTargetCheckInputV1Schema, outputSchema: DeploymentTargetCheckResultV1Schema,
    bindings: { mcpToolName: 'deployments_targets_check' },
    cli: { acceptsServerId: true, commands: [{ path: ['deployments', 'targets', 'check'], visibility: 'canonical' }] },
  },
  deploymentSpec(deploymentActionIds.DEPLOYMENT_RECEIPT_GET_ACTION_ID_V1, 'Read deployment receipt', '/v1/deployments/receipts/:deploymentId', 'Read a deployment Receipt by id for the requested Home.', true),
  { ...deploymentSpec(deploymentActionIds.DEPLOYMENT_RECEIPT_OBSERVE_ACTION_ID_V1, 'Observe provider deployment receipt', undefined, 'Ask the assigned provider observer to refresh status for a retained deployment Receipt.', true), requesterAccountContentDemandForInput: () => true },
  { ...deploymentSpec(deploymentActionIds.DEPLOYMENT_OBSERVATION_GET_ACTION_ID_V1, 'Read recorded deployment observation', undefined, 'Read a recorded deployment observation, using the saved Receipt and observation reference.', true), requesterAccountContentDemandForInput: () => true },
  { ...deploymentSpec(deploymentActionIds.DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1, 'Set environment bindings', '/v1/deployments/environments/:environmentId/bindings', 'Set or remove selected Environment bindings at an expected revision. Bind Saved Secrets by reference and revision; delivery stays with the reviewed target.'),
    deploymentReadScope: createDeploymentReadScopeV1({ childMetadataReads: DEPLOYMENT_DATA_ROLE_CHILD_METADATA_READS_V1 }), requesterAccountContentDemandForInput: () => true },
  deploymentSpec(deploymentActionIds.DEPLOYMENT_ENVIRONMENT_LIST_ACTION_ID_V1, 'List deployment environments', '/v1/deployments/environments', 'Find Environments visible on the selected Home. Filter by Project or Machine and pass the returned cursor to continue.', true),
  deploymentSpec(deploymentActionIds.DEPLOYMENT_RECEIPT_LIST_ACTION_ID_V1, 'List deployment receipts', '/v1/deployments/environments/:environmentId/deployments', 'Page through retained deployment history for one Environment, including ids used to select a rollback or promotion source.', true),
] as const satisfies readonly PreNormalizedActionSpec[];
}

export const DEPLOYMENT_ACTION_SPECS_V1: ReturnType<typeof createDeploymentActionSpecsV1> = lazyActionSpecArray(createDeploymentActionSpecsV1);
