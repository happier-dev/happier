import { DEPLOYMENT_TARGET_CHECK_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { DeploymentTargetCheckResultV1Schema, type DeploymentTargetCheckInputV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';

import { WorkflowDefinitionCreateResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { MachineServicesListResultV1Schema } from '@happier-dev/protocol/actions/specs/machine/services';
import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import { z } from 'zod/mini';
import type { DeploymentActionInputSchemasV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentDomainAttachedVerifyResultV1Schema, DeploymentActionOutputSchemasV1, DeploymentEnvironmentCreateResultV1Schema, DeploymentEnvironmentCreateActionResultV1Schema, type DeploymentEnvironmentCreateInputV1, type DeploymentEnvironmentCreateIntentInputV1, type DeploymentTargetLinkInputV1, type DeploymentTargetLinkIntentInputV1, type DeploymentTargetLinkProviderIntentInputV1, type DeploymentTargetLinkCreateIntentInputV1, type DeploymentEnvironmentHeaderV1, type DeploymentEnvironmentUpdateInputV1, type DeploymentDeployInputV1, type DeploymentRollbackInputV1, type DeploymentTargetUnlinkInputV1, type DeploymentEnvironmentDeleteInputV1, type DeploymentCancelInputV1, type DeploymentRestartInputV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { DeploymentBindingsPatchInputV1, DeploymentTeardownActionInputV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { type DeploymentDeployIntentInputV1 } from '@happier-dev/protocol/deployments/deploymentDeployIntentV1';
import type { DeploymentPromoteIntentInputV1 } from '@happier-dev/protocol/deployments/deploymentPromoteIntentV1';
import { DEPLOYMENT_DOMAIN_DNS_CREATE_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import type { DeploymentDomainDnsInputV1 } from '@happier-dev/protocol/deployments/deploymentDomainDnsV1';
import { type DeploymentLogsReadInputV1 } from '@happier-dev/protocol/deployments/deploymentReadsV1';
import { type DeploymentBackupRestoreInputV1 } from '@happier-dev/protocol/deployments/deploymentBackupRestoreV1';
import { WorkflowTriggerListResultV1Schema, WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { getWorkflowStarterExamplesV1 } from '@happier-dev/protocol/workflows/builtins/examples';
import { DeploymentTemplateInstantiateResultV1Schema, type DeploymentTemplateInstantiateInputV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { buildDeploymentBackupActionInputV1, deploymentBackupPolicyV1, DeploymentBackupActionResultSchemasV1,
    type DeploymentBackupConfigurationV1,
    type DeploymentBackupActionResultV1, type DeploymentBackupInventoryInputV1, type DeploymentBackupPruneInputV1, type DeploymentBackupVerifyInputV1 } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';
import { type DeploymentActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createFrontDoorActionExecute, createFrontDoorUiActionExecutor, requireActionSuccess, readActionApprovalRequestCreatedError,
    type UiActionOperation } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { applyEnvironmentSecretBindingsPatchV1 } from '@happier-dev/protocol/deployments/deploymentBindingPatchV1';
import { EnvironmentSecretBindingInputV1Schema } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { HappyError } from '@/utils/errors/errors';
import { randomUUID } from '@/platform/randomUUID';
import { DeploymentDomainContentV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { DeploymentDomainAddressOfferResultV1Schema, DeploymentDomainDnsPreviewResultV1Schema, type DeploymentDomainAddInputV1, type DeploymentDomainAttachedVerifyInputV1, type DeploymentDomainPreviewInputV1, type DeploymentDomainRemoveInputV1 } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import type { DeploymentEnvironmentContentV1 } from '@happier-dev/deployments/contracts/v1';
import type { DeploymentBackupConfigureInputV1 } from '@happier-dev/protocol/deployments/deploymentBackupConfigureV1';
import { isDeploymentTelemetrySetRefusalV1, type DeploymentEnvironmentTelemetrySetInputV1, type DeploymentEnvironmentTelemetrySetSuccessV1,
    type DeploymentTelemetrySetRefusalV1 } from '@happier-dev/protocol/deployments/deploymentTelemetryV1';
import { DeploymentMoveToRepositoryResultV1Schema, type DeploymentMoveToRepositoryInputV1 } from '@happier-dev/protocol/deployments/deploymentMoveToRepositoryV1';
import { DeploymentPrepareResultV1Schema, type DeploymentPrepareInputV1 } from '@happier-dev/protocol/deployments/deploymentPreparationV1';
import type { DeploymentCreationDefaultsV1 } from '@happier-dev/protocol/projects/deploymentCreationDefaultsV1';

type PreparedCreate = Omit<DeploymentEnvironmentCreateInputV1, 'serverId' | 'projectSourceId'>;
export type DeploymentUiCreateInput = Omit<DeploymentEnvironmentCreateIntentInputV1,
    'serverId' | 'requestKey' | 'mode'> & Readonly<{ requestKey?: string }>;
type PreparedLink = Omit<DeploymentTargetLinkInputV1, 'serverId'>;
/** The parent Action authors native or provider content through its canonical preparation owner. */
export type DeploymentUiLinkInput = (Omit<DeploymentTargetLinkIntentInputV1, 'serverId' | 'requestKey' | 'source'> & Readonly<{
    source?: Extract<NonNullable<DeploymentTargetLinkIntentInputV1['source']>, { kind: 'host' }>;
    requestKey?: string;
}>) | (Omit<DeploymentTargetLinkProviderIntentInputV1, 'serverId' | 'requestKey'> & Readonly<{ requestKey?: string }>)
    | (Omit<DeploymentTargetLinkCreateIntentInputV1, 'serverId' | 'requestKey'> & Readonly<{ requestKey?: string }>);
type PreparedRollback = Omit<DeploymentRollbackInputV1, 'serverId'>;
/** Only the controller authors teardown candidates, including native resource inventory. */
export type DeploymentUiTeardownInput = DeploymentTeardownActionInputV1 extends infer T
    ? T extends unknown ? Omit<T, 'serverId'> : never : never;
export type DeploymentUiRollbackInput = Pick<PreparedRollback, 'environmentId' | 'deploymentId' | 'restoreBackupId'> & Readonly<{ requestKey?: string }>;
/** A restore step's operands; the Action owner checks them against the retained capture receipt. */
export type DeploymentUiRestoreInput = DeploymentBackupRestoreInputV1 extends infer T ? T extends unknown ? Omit<T, 'serverId'> : never : never;
export type DeploymentUiBindingsInput = Omit<DeploymentBindingsPatchInputV1, 'serverId'>;
export type DeploymentUiBackupConfigureInput = DeploymentBackupConfigureInputV1 extends infer T
    ? T extends unknown ? Omit<T, 'serverId' | 'environmentId' | 'expectedRevision'> : never : never;

export type DeploymentUiDomainAddInput = DeploymentDomainAddInputV1 extends infer T
    ? T extends unknown ? Omit<T, 'serverId' | 'domainId' | 'requestKey'> & Readonly<{ domainId?: string; requestKey?: string }> : never : never;
export type DeploymentUiDomainInput = Omit<DeploymentDomainRemoveInputV1, 'serverId' | 'requestKey'> & Readonly<{ requestKey?: string }>;
export type DeploymentUiTelemetryInput = Pick<DeploymentEnvironmentTelemetrySetInputV1, 'collector' | 'capabilities' | 'confirmDelete' | 'rotate' | 'publicCollectorDomain'>;
/** The host Action's typed pre-write refusals, kept with their details so the sheet recovers in place. */
export type DeploymentUiTelemetryResult = DeploymentEnvironmentTelemetrySetSuccessV1
    | Readonly<{ ok: false; error: DeploymentTelemetrySetRefusalV1; details?: unknown; failureCause?: HappyError['failureCause'] }>
    | Extract<z.infer<typeof DeploymentActionOutputSchemasV1['deployments.environments.telemetry.set']>, { ok: false }>;

export type DeploymentUiDomainDnsPreviewInput = Omit<DeploymentDomainPreviewInputV1, 'serverId' | 'mode' | 'requestKey'>
    & Readonly<{ requestKey?: string }>;

type DeploymentStepConfirmation = NonNullable<NonNullable<Parameters<typeof createFrontDoorActionExecute>[1]>['presentUserActionConfirmation']>;

/** Prepared content is admitted by the Action owner under the captured Home/Account. */
export function createDeploymentActions(lifetime: ServerAccountScopeLifetime, projectSourceId?: string) {
    const execute = createFrontDoorUiActionExecutor(undefined, {
        serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId,
    });
    // Database facts and the Restore sheet share the same read while it is pending.
    const pendingBackupInventory = new Map<string, Promise<DeploymentBackupActionResultV1<'deployments.backups.inventory'>>>();
    function assertCurrent() {
        if (!lifetime.isCurrent()) throw Object.assign(new Error('action_account_scope_changed'), {
            code: 'action_account_scope_changed' as const,
        });
    }
    async function invoke(actionId: DeploymentActionIdV1, input: unknown, operation?: UiActionOperation) {
        try { return await execute(actionId, input, operation); }
        catch (error) {
            // The Action envelope retains acknowledged storage refusals in its
            // typed details. Keep their recovery fields for the owning surface.
            if (error instanceof HappyError) {
                const result = DeploymentActionOutputSchemasV1[actionId].safeParse(error.details);
                // Only a typed refusal variant carries `ok: false` and its code; previews and receipts do not.
                if (result.success && 'ok' in result.data && result.data.ok === false
                    && 'error' in result.data && result.data.error === error.code) return result.data;
            }
            throw error;
        }
    }
    async function updateEnvironment(environment: DeploymentEnvironmentHeaderV1,
        patch: NonNullable<DeploymentEnvironmentUpdateInputV1['patch']>, operation?: UiActionOperation,
        previewWatcher?: Exclude<DeploymentEnvironmentUpdateInputV1['previewWatcher'], 'options'>) {
        assertCurrent();
        return DeploymentActionOutputSchemasV1['deployments.environments.update'].parse(await invoke('deployments.environments.update', {
            serverId: lifetime.scope.serverId, environmentId: environment.id, expectedRevision: environment.revision,
            contentArtifactId: environment.contentArtifactId, contentHeaderVersion: environment.contentHeaderVersion,
            contentBodyVersion: environment.contentBodyVersion, patch, ...(previewWatcher === undefined ? {} : { previewWatcher }),
        }, operation));
    }
    async function readBackupScheduleSets(environmentId: string) {
        assertCurrent();
        const result = WorkflowTriggerListResultV1Schema.parse(await execute('workflow.trigger.list', {
            deploymentBackupEnvironment: { environmentId, serverId: lifetime.scope.serverId },
        }));
        return result.sets;
    }
    return {
        /** A Move review selects exact native writers; it never stops services from the page. */
        async readMoveServices(input: Readonly<{ machineId: string; environmentId: string }>) {
            assertCurrent();
            const result = MachineServicesListResultV1Schema.parse(await execute('machines.services.list',
                { ...input, serverId: lifetime.scope.serverId }));
            assertCurrent();
            return result;
        },
        /** This sheet's person gesture confirms only the normal Session handoff, on its chosen checkout Machine. */
        async prepare(input: DeploymentPrepareInputV1, workspaceMachineId: string) {
            assertCurrent();
            return DeploymentPrepareResultV1Schema.parse(await execute('deployments.prepare', input, {
                confirmed: true, externalActionTarget: { kind: 'machine', machineId: workspaceMachineId },
            }));
        },
        async moveToRepository(input: Omit<DeploymentMoveToRepositoryInputV1, 'serverId'>, operation?: UiActionOperation) {
            assertCurrent();
            return DeploymentMoveToRepositoryResultV1Schema.parse(await execute('deployments.environments.moveToRepository',
                { ...input, serverId: lifetime.scope.serverId }, operation));
        },
        /** Resolve only on setup intent; the editor keeps this review while defaults change elsewhere. */
        async prepareConfigurationDefaults(environment: DeploymentEnvironmentHeaderV1,
            defaultsFor: NonNullable<DeploymentEnvironmentUpdateInputV1['defaultsFor']>) {
            assertCurrent();
            const result = DeploymentActionOutputSchemasV1['deployments.environments.update'].parse(await invoke(
                'deployments.environments.update', { serverId: lifetime.scope.serverId, environmentId: environment.id,
                    expectedRevision: environment.revision, contentArtifactId: environment.contentArtifactId,
                    contentHeaderVersion: environment.contentHeaderVersion, contentBodyVersion: environment.contentBodyVersion,
                    mode: 'preview', defaultsFor }));
            assertCurrent();
            if (!result.ok) throw new HappyError(result.error, false, { details: result });
            if (!result.creationDefaults) throw new HappyError('invalid_action_output', false);
            return { ...result.creationDefaults,
                ...(result.backupSourceChoices !== undefined ? { backupSourceChoices: result.backupSourceChoices } : {}) };
        },
        async preparePreviewWatcher(environment: DeploymentEnvironmentHeaderV1,
            previewTemplate: NonNullable<DeploymentEnvironmentContentV1['previewTemplate']>) {
            assertCurrent();
            const result = DeploymentActionOutputSchemasV1['deployments.environments.update'].parse(await invoke(
                'deployments.environments.update', { serverId: lifetime.scope.serverId, environmentId: environment.id,
                    expectedRevision: environment.revision, contentArtifactId: environment.contentArtifactId,
                    contentHeaderVersion: environment.contentHeaderVersion, contentBodyVersion: environment.contentBodyVersion,
                    mode: 'preview', previewWatcher: 'options', patch: { previewTemplate } }));
            assertCurrent();
            if (!result.ok) throw new HappyError(result.error, false, { details: result });
            if (!result.previewWatcher) throw new HappyError('invalid_action_output', false);
            return result.previewWatcher;
        },
        /** Ask the existing update admission to evaluate the proposed fork policy without saving it. */
        async preparePreviewForkPolicy(environment: DeploymentEnvironmentHeaderV1,
            placement: Pick<NonNullable<DeploymentEnvironmentContentV1['previewTemplate']>, 'repository' | 'runtimeTargetLinkId'>,
            operation?: UiActionOperation) {
            assertCurrent();
            // This read proposes placement only; unfinished address, data and variable edits are saved separately.
            const result = DeploymentActionOutputSchemasV1['deployments.environments.update'].parse(await invoke(
                'deployments.environments.update', { serverId: lifetime.scope.serverId, environmentId: environment.id,
                    expectedRevision: environment.revision, contentArtifactId: environment.contentArtifactId,
                    contentHeaderVersion: environment.contentHeaderVersion, contentBodyVersion: environment.contentBodyVersion,
                    mode: 'preview', patch: { previewTemplate: { v: 1, enabled: true, forkPreviews: 'approveEachCommit',
                        repository: placement.repository, runtimeTargetLinkId: placement.runtimeTargetLinkId,
                        domain: null, bindingBlueprints: [], data: [] },
                        ...(environment.buildMachineId ? { buildMachineId: environment.buildMachineId } : {}) } }, operation));
            assertCurrent();
            if (!result.ok) throw new HappyError(result.error, false, { details: result });
            if (!result.forkEligibility) throw new HappyError('invalid_action_output', false);
            return result.forkEligibility;
        },
        async runBackup(input: Omit<DeploymentBackupInventoryInputV1, 'serverId'>) {
            assertCurrent();
            return DeploymentBackupActionResultSchemasV1['deployments.backups.run'].parse(await invoke(
                'deployments.backups.run', buildDeploymentBackupActionInputV1('deployments.backups.run', {
                    ...input, serverId: lifetime.scope.serverId,
                })));
        },
        async backupInventory(input: Omit<DeploymentBackupInventoryInputV1, 'serverId'>) {
            assertCurrent();
            const actionId = 'deployments.backups.inventory';
            const operands = buildDeploymentBackupActionInputV1(actionId, { ...input, serverId: lifetime.scope.serverId });
            const key = JSON.stringify(operands);
            const pending = pendingBackupInventory.get(key);
            if (pending) return pending;
            const read = invoke(actionId, operands).then(result => {
                assertCurrent();
                return DeploymentBackupActionResultSchemasV1[actionId].parse(result);
            }).finally(() => pendingBackupInventory.delete(key));
            pendingBackupInventory.set(key, read);
            return read;
        },
        /**
         * Add a catalog template to this existing Environment (P10): `preview` returns the review and capacity facts,
         * `apply` writes the definition and starts the deploy. Partial progress arrives as the typed refusal.
         */
        async instantiateTemplate(input: Omit<DeploymentTemplateInstantiateInputV1, 'serverId'>, operation?: UiActionOperation) {
            assertCurrent();
            return DeploymentTemplateInstantiateResultV1Schema.parse(await execute('deployments.templates.instantiate',
                { ...input, serverId: lifetime.scope.serverId }, operation));
        },
        /** Retained backup, check and cleanup receipts for the Database page; a read, never an effect. */
        async backupHistory(input: Omit<DeploymentBackupInventoryInputV1, 'serverId'>) {
            assertCurrent();
            return DeploymentBackupActionResultSchemasV1['deployments.backups.history'].parse(await invoke(
                'deployments.backups.history', buildDeploymentBackupActionInputV1('deployments.backups.history', {
                    ...input, serverId: lifetime.scope.serverId,
                })));
        },
        /**
         * Scheduled backups of this Environment that were due and didn't start. The trigger owner derives
         * them at read time; this addressed read is not an Account trigger list and publishes nothing into it.
         */
        async missedBackupSchedules(input: Readonly<{ environmentId: string }>) {
            return (await readBackupScheduleSets(input.environmentId)).flatMap((set) => set.missedSchedules ?? []);
        },
        async verifyBackup(input: Omit<DeploymentBackupVerifyInputV1, 'serverId'>) {
            assertCurrent();
            return DeploymentBackupActionResultSchemasV1['deployments.backups.verify'].parse(await invoke(
                'deployments.backups.verify', buildDeploymentBackupActionInputV1('deployments.backups.verify', {
                    ...input, serverId: lifetime.scope.serverId,
                })));
        },
        /** Tests the saved repository with one owned write/read/delete probe; initialization stays explicit. */
        async testBackupDestination(input: Omit<DeploymentBackupInventoryInputV1, 'serverId'>) {
            assertCurrent();
            return DeploymentBackupActionResultSchemasV1['deployments.backups.test'].parse(await invoke(
                'deployments.backups.test', buildDeploymentBackupActionInputV1('deployments.backups.test', {
                    ...input, serverId: lifetime.scope.serverId,
                })));
        },
        /** Enabled backup Workflows for this stable Environment, selected by the trigger owner. */
        async backupScheduleSets(input: Readonly<{ environmentId: string }>) {
            return readBackupScheduleSets(input.environmentId);
        },
        /**
         * Schedules the built-in Nightly backups Workflow for this Environment from the controller Machine: back up,
         * verify each new snapshot, then keep the saved counts. The same `workflow.trigger.add` an agent would send.
         */
        async addBackupSchedule(input: Readonly<{ environmentId: string; configuration: DeploymentBackupConfigurationV1;
            schedule: NonNullable<DeploymentCreationDefaultsV1['backupSchedule']>; controllerMachineId: string }>) {
            assertCurrent();
            // The starter owns its Workflow and default schedule; turning it on is the person's choice here.
            const starter = getWorkflowStarterExamplesV1().find((example) => example.key === 'nightly-backups');
            if (!starter || starter.triggerSeed?.kind !== 'schedule') throw new HappyError('workflow_starter_unavailable', false);
            return WorkflowTriggerWriteResultV1Schema.parse(await execute('workflow.trigger.add', {
                target: { kind: 'inline', definition: starter.definition },
                project: { machineId: input.controllerMachineId, directory: '~' },
                executionTarget: { kind: 'detached_run' },
                inputs: { backupEnvironment: { environmentId: input.environmentId, serverId: lifetime.scope.serverId },
                    backupPolicy: deploymentBackupPolicyV1(input.configuration), verificationLevel: 'manifestReadBack' },
                trigger: { kind: 'schedule', schedule: input.schedule, enabled: true },
                actionApproval: 'automatic',
            }));
        },
        /** Forgets the snapshots past the saved counts now, instead of after the next backup. */
        async pruneBackups(input: Omit<DeploymentBackupPruneInputV1, 'serverId'>) {
            assertCurrent();
            return DeploymentBackupActionResultSchemasV1['deployments.backups.prune'].parse(await invoke(
                'deployments.backups.prune', buildDeploymentBackupActionInputV1('deployments.backups.prune', {
                    ...input, serverId: lifetime.scope.serverId,
                })));
        },
        async teardown(input: DeploymentUiTeardownInput, operation?: UiActionOperation) {
            assertCurrent();
            return DeploymentActionOutputSchemasV1['deployments.teardown'].parse(await invoke(
                'deployments.teardown', { ...input, serverId: lifetime.scope.serverId }, operation));
        },
        /** The receipt's own cancellation; the server's receipt lifecycle decides whether it still can. */
        async cancel(input: Omit<DeploymentCancelInputV1, 'serverId'>, operation?: UiActionOperation) {
            assertCurrent();
            return DeploymentActionOutputSchemasV1['deployments.cancel'].parse(await invoke(
                'deployments.cancel', { ...input, serverId: lifetime.scope.serverId }, operation));
        },
        /**
         * One step's masked stage-log page (DEP-43): `tail` reads the latest window, a cursor the next finite page.
         * A missing or legacy step ref is refused by the reader; it never falls back to the whole operation log.
         */
        async readLogs(input: Omit<Extract<DeploymentLogsReadInputV1, { kind: 'build' }>, 'serverId'>, operation?: UiActionOperation) {
            assertCurrent();
            return DeploymentActionOutputSchemasV1['deployments.logs.read'].parse(await invoke(
                'deployments.logs.read', { ...input, serverId: lifetime.scope.serverId }, operation));
        },
        /**
         * The admitted Domain Action prepares private content and captures native placement
         * against the Environment and target revisions.
         */
        async addDomain(input: DeploymentUiDomainAddInput, operation?: UiActionOperation) {
            assertCurrent();
            const prepared = 'content' in input ? { ...input, content: DeploymentDomainContentV1Schema.parse(input.content) } : input;
            return DeploymentActionOutputSchemasV1['deployments.domains.add'].parse(await invoke('deployments.domains.add', {
                ...prepared, serverId: lifetime.scope.serverId,
                domainId: input.domainId ?? randomUUID(), requestKey: input.requestKey ?? randomUUID(),
            }, operation));
        },
        /** Remove one address; the Action's irreversible confirmation is the designed one. */
        async removeDomain(input: DeploymentUiDomainInput, operation?: UiActionOperation) {
            assertCurrent();
            return DeploymentActionOutputSchemasV1['deployments.domains.remove'].parse(await invoke('deployments.domains.remove', {
                ...input, requestKey: input.requestKey ?? randomUUID(), serverId: lifetime.scope.serverId }, operation));
        },
        /** Explicit open/manual demand inspects this draft without saving Domain content. */
        async previewDomainDns(input: DeploymentUiDomainDnsPreviewInput, operation?: UiActionOperation) {
            assertCurrent();
            const result = DeploymentActionOutputSchemasV1['deployments.domains.verify'].parse(await invoke(
                'deployments.domains.verify', { ...input, mode: 'preview', requestKey: input.requestKey ?? randomUUID(),
                    serverId: lifetime.scope.serverId }, operation));
            assertCurrent();
            if (!result.ok) throw new HappyError(result.error, false, { code: result.error, details: result });
            return DeploymentDomainDnsPreviewResultV1Schema.parse(result);
        },
        async offerDomainAddress(input: DeploymentUiDomainDnsPreviewInput, operation?: UiActionOperation) {
            assertCurrent();
            const result = DeploymentActionOutputSchemasV1['deployments.domains.verify'].parse(await invoke(
                'deployments.domains.verify', { ...input, mode: 'preview', requestKey: input.requestKey ?? randomUUID(),
                    serverId: lifetime.scope.serverId }, operation));
            assertCurrent();
            if (!result.ok) throw new HappyError(result.error, false, { code: result.error, details: result });
            return DeploymentDomainAddressOfferResultV1Schema.parse(result).addressOffer;
        },
        /** The controller re-observes the address or verifies the reviewed provider assignment. */
        async verifyDomain(input: Omit<DeploymentDomainAttachedVerifyInputV1, 'serverId' | 'requestKey'> & Readonly<{ requestKey?: string }>,
            operation?: UiActionOperation) {
            assertCurrent();
            const result = DeploymentDomainAttachedVerifyResultV1Schema.parse(await invoke('deployments.domains.verify', {
                ...input, requestKey: input.requestKey ?? randomUUID(), serverId: lifetime.scope.serverId }, operation));
            assertCurrent();
            return result;
        },
        /** The controller prepares record values from the retained provider observation. */
        async createDomainDns(input: Omit<DeploymentDomainDnsInputV1, 'serverId' | 'requestKey'> & Readonly<{ requestKey?: string }>, operation?: UiActionOperation) {
            assertCurrent();
            return DeploymentActionOutputSchemasV1[DEPLOYMENT_DOMAIN_DNS_CREATE_ACTION_ID_V1].parse(await invoke(
                DEPLOYMENT_DOMAIN_DNS_CREATE_ACTION_ID_V1, { ...input, requestKey: input.requestKey ?? randomUUID(),
                    serverId: lifetime.scope.serverId }, operation));
        },
        async unlink(input: Omit<DeploymentTargetUnlinkInputV1, 'serverId'>, operation?: UiActionOperation) {
            assertCurrent();
            return DeploymentActionOutputSchemasV1['deployments.targets.unlink'].parse(await invoke(
                'deployments.targets.unlink', { ...input, serverId: lifetime.scope.serverId }, operation));
        },
        async deleteEnvironment(input: Omit<DeploymentEnvironmentDeleteInputV1, 'serverId'>, operation?: UiActionOperation) {
            assertCurrent();
            return DeploymentActionOutputSchemasV1['deployments.environments.delete'].parse(await invoke(
                'deployments.environments.delete', { ...input, serverId: lifetime.scope.serverId }, operation));
        },
        /** Explicit provider metadata demand; ordinary Environment reads never issue this request. */
        async readObservation(input: Omit<z.infer<typeof DeploymentActionInputSchemasV1['deployments.observation.get']>, 'serverId'>, operation?: UiActionOperation) {
            assertCurrent();
            const result = DeploymentActionOutputSchemasV1['deployments.observation.get'].parse(await invoke(
                'deployments.observation.get', { ...input, serverId: lifetime.scope.serverId }, operation));
            assertCurrent();
            return result;
        },
        async saveWorkflow(definitionId: string, definition: WorkflowDefinitionV1, title: string) {
            assertCurrent();
            return WorkflowDefinitionCreateResultV1Schema.parse(await execute('workflow.definition.create', {
                definitionId, definition, metadata: { title },
            }));
        },
        async setBindings(input: DeploymentUiBindingsInput, operation?: UiActionOperation) {
            assertCurrent();
            return DeploymentActionOutputSchemasV1['deployments.bindings.set'].parse(await invoke('deployments.bindings.set', {
                ...input, serverId: lifetime.scope.serverId,
            }, operation));
        },
        /** Candidate testing and the reserved backup leaf share the controller's configure owner. */
        async configureBackup(environment: Pick<DeploymentEnvironmentHeaderV1, 'id' | 'revision'>,
            input: DeploymentUiBackupConfigureInput, operation?: UiActionOperation) {
            assertCurrent();
            return DeploymentActionOutputSchemasV1['deployments.backups.configure'].parse(await invoke(
                'deployments.backups.configure', { ...input, serverId: lifetime.scope.serverId,
                    environmentId: environment.id, expectedRevision: environment.revision }, operation));
        },
        /**
         * One manager-owned Environment setting (build Machine, who may deploy), admitted against the read revision and
         * content the row showed. The controller re-checks the patch; the row only names what changes.
         */
        updateEnvironment,
        async setPreviewBindings(environment: DeploymentEnvironmentHeaderV1,
            template: NonNullable<DeploymentEnvironmentContentV1['previewTemplate']>,
            input: DeploymentUiBindingsInput, operation?: UiActionOperation) {
            const set = z.array(EnvironmentSecretBindingInputV1Schema).parse(input.set);
            const bindingBlueprints = applyEnvironmentSecretBindingsPatchV1(template.bindingBlueprints, { set, remove: input.remove }, randomUUID)
                .filter(binding => binding.purpose === 'variable');
            return updateEnvironment(environment, { previewTemplate: { ...template, bindingBlueprints } }, operation);
        },
        /** Collector and capability choices through the host Action; it settles them on the bindings CAS at the next deploy. */
        async setTelemetry(environment: Pick<DeploymentEnvironmentHeaderV1, 'id' | 'revision'>, input: DeploymentUiTelemetryInput,
            operation?: UiActionOperation): Promise<DeploymentUiTelemetryResult> {
            assertCurrent();
            try {
                return DeploymentActionOutputSchemasV1['deployments.environments.telemetry.set'].parse(await invoke(
                    'deployments.environments.telemetry.set', { serverId: lifetime.scope.serverId, environmentId: environment.id,
                        expectedRevision: environment.revision, ...input }, operation));
            } catch (error) {
                if (error instanceof HappyError && isDeploymentTelemetrySetRefusalV1(error.code)) {
                    return { ok: false, error: error.code, details: error.details, failureCause: error.failureCause };
                }
                throw error;
            }
        },
        /** Move scheduled jobs, alerts and outside checks to another Machine; workload content does not change. */
        async setController(environment: Pick<DeploymentEnvironmentHeaderV1, 'id' | 'revision'>, controllerMachineId: string,
            operation?: UiActionOperation) {
            assertCurrent();
            return DeploymentActionOutputSchemasV1['deployments.environments.controller.set'].parse(await invoke(
                'deployments.environments.controller.set', { serverId: lifetime.scope.serverId, environmentId: environment.id,
                    expectedRevision: environment.revision, controllerMachineId }, operation));
        },
        /** The editor consumes admitted old/new facts; only Save crosses the Action front door. */
        prepareProtectionEdit(environment: DeploymentEnvironmentHeaderV1, protection: DeploymentEnvironmentHeaderV1['protection']) {
            assertCurrent();
            const input: DeploymentEnvironmentUpdateInputV1 = {
                serverId: lifetime.scope.serverId, environmentId: environment.id, expectedRevision: environment.revision,
                contentArtifactId: environment.contentArtifactId, contentHeaderVersion: environment.contentHeaderVersion,
                contentBodyVersion: environment.contentBodyVersion, patch: { protection },
            };
            return {
                previousProtection: environment.protection,
                protection,
                async save(operation?: UiActionOperation) {
                    assertCurrent();
                    return DeploymentActionOutputSchemasV1['deployments.environments.update'].parse(await invoke(
                        'deployments.environments.update', input, operation));
                },
            };
        },
        /**
         * Explicit authoring intent only; mounting a draft never calls this preparation. The review step is the
         * person's confirmation host: a controller that carries its review back presents it through `confirmation`.
         */
        async prepareCreate(input: DeploymentUiCreateInput, operation?: UiActionOperation, confirmation?: DeploymentStepConfirmation) {
            assertCurrent();
            const preview = DeploymentEnvironmentCreateActionResultV1Schema.parse(await invoke(
                'deployments.environments.create', { ...input, mode: 'preview', requestKey: input.requestKey ?? randomUUID(),
                    serverId: lifetime.scope.serverId, ...(projectSourceId ? { projectSourceId } : {}) }, operation));
            if ('ok' in preview) {
                const code = preview.ok ? 'invalid_action_output' : preview.error;
                throw new HappyError(code, false, { code, details: preview });
            }
            assertCurrent();
            const frontDoor = createFrontDoorActionExecute(undefined, confirmation ? { presentUserActionConfirmation: confirmation } : undefined);
            const prepared = await frontDoor.prepare('deployments.environments.create', preview.input, {
                surface: 'ui', serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId,
                ...operation,
            });
            assertCurrent();
            return {
                input: preview.input,
                review: preview.review,
                async run() {
                    assertCurrent();
                    const result = prepared.kind === 'ready' ? await prepared.invocation.run() : prepared.result;
                    requireActionSuccess(result);
                    return DeploymentEnvironmentCreateResultV1Schema.parse(result.result);
                },
            };
        },
        /** Already-prepared callers retain their exact refs; they never resolve defaults again. */
        async create(input: PreparedCreate, operation?: UiActionOperation) {
            assertCurrent();
            return DeploymentEnvironmentCreateResultV1Schema.parse(await invoke(
                'deployments.environments.create', { ...input, serverId: lifetime.scope.serverId, projectSourceId }, operation));
        },
        async checkPlatformTarget(input: Omit<DeploymentTargetCheckInputV1, 'serverId'>) {
            assertCurrent();
            return DeploymentTargetCheckResultV1Schema.parse(await execute(DEPLOYMENT_TARGET_CHECK_ACTION_ID_V1,
                { ...input, serverId: lifetime.scope.serverId }));
        },
        /**
         * A platform target's inspect Action (Connect / Check again), named by its plugin descriptor. It only reads the
         * provider, so a refusal comes back as its typed code for the sheet to explain, never as a throw.
         */
        async inspectPlatformTarget(actionId: string, input: Record<string, unknown>, operation?: UiActionOperation) {
            assertCurrent();
            try {
                const action = parseQualifiedPluginActionId(actionId);
                if (!action) return { ok: false as const, code: 'invalid_parameters' };
                // The host Action admits the plugin declaration's placement, schema and custody.
                return { ok: true as const, value: await execute('action.invoke', { action, input }, operation) };
            } catch (error) {
                const approval = readActionApprovalRequestCreatedError(error);
                const code = (error as { code?: unknown } | null)?.code;
                const details = error instanceof HappyError ? error.details : undefined;
                const failureCause = error instanceof HappyError ? error.failureCause : undefined;
                const requestId = error instanceof HappyError ? error.requestId : undefined;
                return { ok: false as const, code: typeof code === 'string' && code ? code : 'unknown_error',
                    ...(approval ? { approvalArtifactId: approval.artifactId } : {}),
                    ...(details !== undefined ? { details } : {}),
                    ...(requestId !== undefined ? { requestId } : {}),
                    ...(failureCause !== undefined ? { failureCause } : {}) };
            }
        },
        async link(input: PreparedLink | DeploymentUiLinkInput, operation?: UiActionOperation) {
            assertCurrent();
            return DeploymentActionOutputSchemasV1['deployments.targets.link'].parse(await invoke(
                'deployments.targets.link', { ...input, requestKey: input.requestKey ?? randomUUID(),
                    serverId: lifetime.scope.serverId }, operation));
        },
        async deploy(input: Omit<DeploymentDeployInputV1, 'serverId'>
            | Omit<DeploymentDeployIntentInputV1, 'serverId'>
            | Pick<DeploymentDeployInputV1, 'environmentId' | 'targetLinkId'>
            | Pick<DeploymentDeployIntentInputV1, 'environmentId' | 'targetLinkId' | 'sha' | 'whenBusy' | 'sourceMethod'>, operation?: UiActionOperation) {
            assertCurrent();
            return DeploymentActionOutputSchemasV1['deployments.deploy'].parse(await invoke(
                'deployments.deploy', { ...input, serverId: lifetime.scope.serverId }, operation));
        },
        /** Restart one serving service at the generation the page shows (P1 service row ⋯); no source operands. */
        async restart(input: Omit<DeploymentRestartInputV1, 'serverId'>, operation?: UiActionOperation) {
            assertCurrent();
            return DeploymentActionOutputSchemasV1['deployments.restart'].parse(await invoke(
                'deployments.restart', { ...input, serverId: lifetime.scope.serverId }, operation));
        },
        /** The selected receipt owns the source; the destination controller prepares the existing review. */
        async promote(input: Omit<DeploymentPromoteIntentInputV1, 'serverId'>, operation?: UiActionOperation) {
            assertCurrent();
            return DeploymentActionOutputSchemasV1['deployments.promote'].parse(await invoke(
                'deployments.promote', { ...input, serverId: lifetime.scope.serverId }, operation));
        },
        /**
         * One step of a backup restore: `prepare` checks the retained backup and takes the safety backup, `confirm`
         * replaces the data with exactly that preparation. The restore sheet is the designed confirmation of each.
         */
        async restore(input: DeploymentUiRestoreInput, operation?: UiActionOperation) {
            assertCurrent();
            return DeploymentActionOutputSchemasV1['deployments.backups.restore'].parse(await invoke(
                'deployments.backups.restore', { ...input, serverId: lifetime.scope.serverId }, { ...operation, confirmed: true }));
        },
        async rollback(input: PreparedRollback | DeploymentUiRollbackInput, operation?: UiActionOperation) {
            assertCurrent();
            // The controller owns retained content, current placement and candidate publication for every rollback.
            return DeploymentActionOutputSchemasV1['deployments.rollback'].parse(await invoke(
                'deployments.rollback', { ...input, serverId: lifetime.scope.serverId,
                    ...(operation?.actionRequestId && !input.requestKey ? { requestKey: operation.actionRequestId } : {}),
                }, operation));
        },
    };
}
