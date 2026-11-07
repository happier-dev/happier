import { DeploymentActionOutputSchemasV1, DeploymentEnvironmentCreateResultV1Schema, DeploymentEnvironmentCreateActionResultV1Schema, type DeploymentEnvironmentCreateInputV1, type DeploymentEnvironmentCreateIntentInputV1, type DeploymentTargetLinkInputV1, type DeploymentTargetLinkIntentInputV1, type DeploymentTargetLinkProviderIntentInputV1, type DeploymentEnvironmentHeaderV1, type DeploymentEnvironmentUpdateInputV1, type DeploymentDeployInputV1, type DeploymentRollbackInputV1, type DeploymentTargetUnlinkInputV1, type DeploymentEnvironmentDeleteInputV1, type DeploymentCancelInputV1, type DeploymentRestartInputV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { DeploymentBindingsPatchInputV1, DeploymentTeardownActionInputV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { type DeploymentDeployIntentInputV1 } from '@happier-dev/protocol/deployments/deploymentDeployIntentV1';
import type { DeploymentPromoteIntentInputV1 } from '@happier-dev/protocol/deployments/deploymentPromoteIntentV1';
import { type DeploymentLogsReadInputV1 } from '@happier-dev/protocol/deployments/deploymentReadsV1';
import { type DeploymentBackupRestoreInputV1 } from '@happier-dev/protocol/deployments/deploymentBackupRestoreV1';
import { WorkflowTriggerListResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { buildDeploymentBackupActionInputV1, DeploymentBackupActionResultSchemasV1,
    type DeploymentBackupInventoryInputV1, type DeploymentBackupPruneInputV1, type DeploymentBackupVerifyInputV1 } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';
import { type DeploymentActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createFrontDoorActionExecute, createFrontDoorUiActionExecutor, requireActionSuccess,
    type UiActionOperation } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { HappyError } from '@/utils/errors/errors';
import { randomUUID } from '@/platform/randomUUID';
import { SessionAuthoringOpenResultV1Schema } from '@happier-dev/protocol/plugins/ui';
import { t } from '@/text';
import { DeploymentDomainContentV1Schema, type DeploymentDomainContentV1 } from '@happier-dev/deployment-protocol/v1';
import { type DeploymentDomainRemoveInputV1 } from '@happier-dev/protocol/deployments/deploymentDomainV1';

type PreparedCreate = Omit<DeploymentEnvironmentCreateInputV1, 'serverId' | 'projectSourceId'>;
export type DeploymentUiCreateInput = Omit<DeploymentEnvironmentCreateIntentInputV1,
    'serverId' | 'projectSourceId' | 'requestKey' | 'mode'> & Readonly<{ requestKey?: string }>;
type PreparedLink = Omit<DeploymentTargetLinkInputV1, 'serverId'>;
/** The parent Action authors native or provider content through its canonical preparation owner. */
export type DeploymentUiLinkInput = (Omit<DeploymentTargetLinkIntentInputV1, 'serverId' | 'requestKey' | 'source'> & Readonly<{
    source?: Extract<NonNullable<DeploymentTargetLinkIntentInputV1['source']>, { kind: 'host' }>;
    requestKey?: string;
}>) | (Omit<DeploymentTargetLinkProviderIntentInputV1, 'serverId' | 'requestKey'> & Readonly<{ requestKey?: string }>);
type PreparedRollback = Omit<DeploymentRollbackInputV1, 'serverId'>;
/** Only the controller authors teardown candidates, including native resource inventory. */
export type DeploymentUiTeardownInput = DeploymentTeardownActionInputV1 extends infer T
    ? T extends unknown ? Omit<T, 'serverId'> : never : never;
export type DeploymentUiRollbackInput = Pick<PreparedRollback, 'environmentId' | 'deploymentId' | 'restoreBackupId'> & Readonly<{ requestKey?: string }>;
/** A restore step's operands; the Action owner checks them against the retained capture receipt. */
export type DeploymentUiRestoreInput = DeploymentBackupRestoreInputV1 extends infer T ? T extends unknown ? Omit<T, 'serverId'> : never : never;
export type DeploymentUiBindingsInput = Omit<DeploymentBindingsPatchInputV1, 'serverId'>;

export type DeploymentUiDomainAddInput = Readonly<{
    environmentId: string; expectedRevision: number; targetLinkId: string; expectedTargetLinkRevision: number;
    content: DeploymentDomainContentV1; domainId?: string; requestKey?: string;
}>;
export type DeploymentUiDomainInput = Omit<DeploymentDomainRemoveInputV1, 'serverId' | 'requestKey'> & Readonly<{ requestKey?: string }>;

/** Prepared content is admitted by the Action owner under the captured Home/Account. */
export function createDeploymentActions(lifetime: ServerAccountScopeLifetime, projectSourceId: string) {
    const execute = createFrontDoorUiActionExecutor(undefined, {
        serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId,
    });
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
    return {
        /** Start owns this editable handoff; opening it neither spawns a Session nor deploys anything. */
        async openPreparation(input: Readonly<{ environmentId: string; name: string }>) {
            assertCurrent();
            const result = SessionAuthoringOpenResultV1Schema.parse(await execute('session.authoring.open', {
                seed: { prompt: t('projects.deployments.copy.preparePrompt', { ...input, sourceId: projectSourceId }) },
            }));
            if (result.kind !== 'opened') throw new HappyError(result.reason, false, { code: result.reason });
            return result;
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
            return DeploymentBackupActionResultSchemasV1['deployments.backups.inventory'].parse(await invoke(
                'deployments.backups.inventory', buildDeploymentBackupActionInputV1('deployments.backups.inventory', {
                    ...input, serverId: lifetime.scope.serverId,
                })));
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
         * Scheduled backups of this exact capture target that were due and didn't start. The trigger owner derives
         * them at read time; this addressed read is not an Account trigger list and publishes nothing into it.
         */
        async missedBackupSchedules(input: Omit<DeploymentBackupInventoryInputV1, 'serverId' | 'expectedRevision'>) {
            assertCurrent();
            const result = WorkflowTriggerListResultV1Schema.parse(await execute('workflow.trigger.list', {
                deploymentBackup: { ...input, serverId: lifetime.scope.serverId },
            }));
            return result.sets.flatMap((set) => set.missedSchedules ?? []);
        },
        async verifyBackup(input: Omit<DeploymentBackupVerifyInputV1, 'serverId'>) {
            assertCurrent();
            return DeploymentBackupActionResultSchemasV1['deployments.backups.verify'].parse(await invoke(
                'deployments.backups.verify', buildDeploymentBackupActionInputV1('deployments.backups.verify', {
                    ...input, serverId: lifetime.scope.serverId,
                })));
        },
        /** A read-only probe of the saved destination; it never initializes or writes the repository. */
        async testBackupDestination(input: Omit<DeploymentBackupInventoryInputV1, 'serverId'>) {
            assertCurrent();
            return DeploymentBackupActionResultSchemasV1['deployments.backups.test'].parse(await invoke(
                'deployments.backups.test', buildDeploymentBackupActionInputV1('deployments.backups.test', {
                    ...input, serverId: lifetime.scope.serverId,
                })));
        },
        /**
         * Opens the machine-services health check setup (HTTP, TCP, DNS, certificate, heartbeat; outside vantage and
         * alert threshold live in that form) for this Environment, run from its controller. An agent invokes the same Action.
         */
        async openHealthCheckSetup(input: Readonly<{ environmentId: string; monitoringMachineId: string }>) {
            assertCurrent();
            const result = await execute('action.invoke', {
                action: { pluginId: 'happier.machine.services', localId: 'health/open-setup' },
                input: { subject: { kind: 'environment', environmentId: input.environmentId },
                    monitoringMachineId: input.monitoringMachineId },
            });
            const opened = typeof result === 'object' && result !== null && Reflect.get(result, 'status') === 'opened';
            return opened ? 'opened' as const : 'unavailable' as const;
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
            const content = DeploymentDomainContentV1Schema.parse(input.content);
            return DeploymentActionOutputSchemasV1['deployments.domains.add'].parse(await invoke('deployments.domains.add', {
                serverId: lifetime.scope.serverId, environmentId: input.environmentId, expectedRevision: input.expectedRevision,
                targetLinkId: input.targetLinkId, expectedTargetLinkRevision: input.expectedTargetLinkRevision,
                domainId: input.domainId ?? randomUUID(), requestKey: input.requestKey ?? randomUUID(), content,
            }, operation));
        },
        /** Remove one address; the Action's irreversible confirmation is the designed one. */
        async removeDomain(input: DeploymentUiDomainInput, operation?: UiActionOperation) {
            assertCurrent();
            return DeploymentActionOutputSchemasV1['deployments.domains.remove'].parse(await invoke('deployments.domains.remove', {
                ...input, requestKey: input.requestKey ?? randomUUID(), serverId: lifetime.scope.serverId }, operation));
        },
        /** Check again: the controller re-observes the address; no content changes. */
        async verifyDomain(input: DeploymentUiDomainInput, operation?: UiActionOperation) {
            assertCurrent();
            return DeploymentActionOutputSchemasV1['deployments.domains.verify'].parse(await invoke('deployments.domains.verify', {
                ...input, requestKey: input.requestKey ?? randomUUID(), serverId: lifetime.scope.serverId }, operation));
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
        async setBindings(input: DeploymentUiBindingsInput, operation?: UiActionOperation) {
            assertCurrent();
            return DeploymentActionOutputSchemasV1['deployments.bindings.set'].parse(await invoke('deployments.bindings.set', {
                ...input, serverId: lifetime.scope.serverId,
            }, operation));
        },
        /**
         * One manager-owned Environment setting (build Machine, who may deploy), admitted against the read revision and
         * content the row showed. The controller re-checks the patch; the row only names what changes.
         */
        async updateEnvironment(environment: DeploymentEnvironmentHeaderV1,
            patch: NonNullable<DeploymentEnvironmentUpdateInputV1['patch']>, operation?: UiActionOperation) {
            assertCurrent();
            return DeploymentActionOutputSchemasV1['deployments.environments.update'].parse(await invoke('deployments.environments.update', {
                serverId: lifetime.scope.serverId, environmentId: environment.id, expectedRevision: environment.revision,
                contentArtifactId: environment.contentArtifactId, contentHeaderVersion: environment.contentHeaderVersion,
                contentBodyVersion: environment.contentBodyVersion, patch,
            }, operation));
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
        /** Explicit authoring intent only; mounting a draft never calls this preparation. */
        async prepareCreate(input: DeploymentUiCreateInput, operation?: UiActionOperation) {
            assertCurrent();
            const preview = DeploymentEnvironmentCreateActionResultV1Schema.parse(await invoke(
                'deployments.environments.create', { ...input, mode: 'preview', requestKey: input.requestKey ?? randomUUID(),
                    serverId: lifetime.scope.serverId, projectSourceId }, operation));
            if ('ok' in preview) {
                const code = preview.ok ? 'invalid_action_output' : preview.error;
                throw new HappyError(code, false, { code, details: preview });
            }
            assertCurrent();
            const frontDoor = createFrontDoorActionExecute();
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
                const code = (error as { code?: unknown } | null)?.code;
                return { ok: false as const, code: typeof code === 'string' && code ? code : 'unknown_error' };
            }
        },
        async link(input: PreparedLink | DeploymentUiLinkInput, operation?: UiActionOperation) {
            assertCurrent();
            return DeploymentActionOutputSchemasV1['deployments.targets.link'].parse(await invoke(
                'deployments.targets.link', { ...input, requestKey: input.requestKey ?? randomUUID(),
                    serverId: lifetime.scope.serverId }, operation));
        },
        async deploy(input: Omit<DeploymentDeployInputV1, 'serverId'>
            | Pick<DeploymentDeployInputV1, 'environmentId' | 'targetLinkId'>
            | Pick<DeploymentDeployIntentInputV1, 'environmentId' | 'targetLinkId' | 'sha' | 'whenBusy'>, operation?: UiActionOperation) {
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
                'deployments.rollback', { ...input, serverId: lifetime.scope.serverId }, operation));
        },
    };
}
