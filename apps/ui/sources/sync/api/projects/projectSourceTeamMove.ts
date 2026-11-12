import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { ActionApprovalRequestCreatedResultSchema, isActionOutcomeUnknownErrorCodeV1,
    type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { ProjectSourcesUpdateOutputV1Schema,
    type ProjectSourcesMoveToTeamOutputV1, type ProjectSourceV1, type ProjectSourceMoveResourceEffectsV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { DeploymentBindingsSetResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { MachineAccessMutationResultV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { ArtifactAccessGrantMutationResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { AccountApiTokensUpdateActionOutputV1Schema } from '@happier-dev/protocol/auth/accountApiTokens';
import { WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { copyUsedSavedSecretResourcesToTeam } from '@/sync/ops/settings/savedSecretResourceTeamCopy';
import type { SavedSecretAdmittedMutationExecute } from '@/sync/ops/settings/savedSecretResourceOperations';
import { classifyHomeActionOutcome } from '@/sync/ops/home/homeActionOutcome';
import { createProjectSourceActionDeps } from './projectSourceActions';
import { moveFailure, ProjectSourceTeamMoveReadFailure, createProjectSourceTeamMovePreparation, type ProjectSourceTeamMoveReadPorts } from './projectSourceTeamMovePreparation';

class MoveStopped extends Error {
    readonly code: string;
    constructor(readonly kind: 'held' | 'outcome_unknown' | 'failed', readonly failure?: ActionExecuteFailure) {
        super('project_source_move_stopped');
        this.code = failure?.errorCode ?? (kind === 'outcome_unknown' ? 'outcome_unknown' : 'deployment_content_unavailable');
    }
}
type MoveDeps = Pick<ActionExecutorDeps, 'prepareHostReviewedChildren' | 'projectSourcesMoveToTeam'> & Readonly<{
    buildApprovalPreview(raw: unknown, context: ActionExecutorContext, defaultPreview: unknown): Promise<unknown>;
}>;

/** The existing Action invocation owns this preparation and releases it with its captured Account. */
export function createProjectSourceTeamMoveDeps(account: LazyActionAccountContext, ports: ProjectSourceTeamMoveReadPorts): MoveDeps {
    const { prepare, prepareFailure, prepareHostReviewedChildren, buildApprovalPreview } = createProjectSourceTeamMovePreparation(account, ports);
    const role = (kind: string, id: string) => `${kind}:${id}`;
    const teamPrincipal = (teamId: string) => ({ kind: 'team' as const, teamId });
    return { prepareHostReviewedChildren, buildApprovalPreview,
        projectSourcesMoveToTeam: async (input, context): Promise<ProjectSourcesMoveToTeamOutputV1 | ActionExecuteFailure> => {
            let source: ProjectSourceV1 | undefined;
            let changed = false;
            const childOperations: Extract<ProjectSourcesMoveToTeamOutputV1, { kind: 'completed' }>['childOperations'] = [];
            const resourceEffects: ProjectSourceMoveResourceEffectsV1 = {
                machineGrants: [], secretCopies: [], artifacts: [], bindingArtifacts: [], bindings: [], renewedTokenIds: [], renewedTriggers: [],
            };
            const runChild = async (action: ActionId, childRole: string, raw: unknown) => {
                context.signal?.throwIfAborted();
                if (!context.hostReviewedChild) throw new MoveStopped('held');
                return context.hostReviewedChild.invoke({ action, role: childRole, input: StrictJsonValueSchema.parse(raw) });
            };
            const invoke = async (action: ActionId, childRole: string, raw: unknown) => {
                const result = await runChild(action, childRole, raw);
                if (!result.ok) throw new MoveStopped(isActionOutcomeUnknownErrorCodeV1(result.errorCode) ? 'outcome_unknown' : 'failed', result);
                if (ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success) throw new MoveStopped('held');
                return result.result;
            };
            try {
                const inventory = await prepare(input, context);
                const current = await createProjectSourceActionDeps(account).projectSourcesRead({ serverId: input.serverId, sourceId: input.sourceId }, context);
                if (!current.ok) return current;
                source = current.source;
                if (!current.canManage || source.owner?.kind !== 'account' || source.owner.accountId !== account.accountId) return { ok: false, error: 'source_access_denied' };
                if (source.revision !== input.expectedRevision) return { ok: false, error: 'source_conflict', current: source };
                for (const machine of inventory.machines) {
                    const result = MachineAccessMutationResultV1Schema.parse(await invoke('machines.access.grant.set', role('machine', machine.machineId), {
                        serverId: input.serverId, machineId: machine.machineId, principal: teamPrincipal(input.teamId), level: 'admin',
                    }));
                    if (result.kind !== 'saved') throw new MoveStopped('failed', moveFailure(result.kind === 'refused' ? result.code : 'invalid_action_output'));
                    resourceEffects.machineGrants.push({ ...result.grant, readiness: result.readiness });
                    changed = true;
                    if (result.readiness !== 'ready') throw new MoveStopped('held');
                }
                let copiedIndex = 0;
                let copyFailure: MoveStopped | undefined;
                const executeAdmittedMutation: SavedSecretAdmittedMutationExecute = async params => {
                    try {
                        const result = await runChild(params.actionId, role('secret', String(copiedIndex++)), params.input);
                        const outcome = classifyHomeActionOutcome(result, params.actionId);
                        if (outcome.kind === 'failed') {
                            copyFailure = new MoveStopped(outcome.failure.kind === 'outcome_unknown' ? 'outcome_unknown' : 'failed', result.ok ? undefined : result);
                            // Preserve the create owner's exact-id reconciliation after an
                            // unknown ACK; it must receive its normal failure result.
                            return outcome;
                        }
                        if (outcome.kind === 'approval_pending') throw new MoveStopped('held');
                        const value = params.parse(outcome.result);
                        changed = true;
                        return { kind: 'succeeded', value };
                    }
                    catch (error) { if (error instanceof MoveStopped) copyFailure = error; throw error; }
                };
                const copied = await copyUsedSavedSecretResourcesToTeam({ scope: account.accountLifetime.scope, teamId: input.teamId,
                    references: inventory.usedSecrets, executeAdmittedMutation, signal: context.signal });
                resourceEffects.secretCopies.push(...copied.copies);
                changed ||= copied.copies.length > 0;
                if (!copied.ok) throw copyFailure ?? new MoveStopped(copied.reason === 'outcome_unknown' ? 'outcome_unknown' : 'held');
                const withdrawArtifacts: string[] = [];
                const share = async (artifactId: string, childRole: string) => {
                    const result = ArtifactAccessGrantMutationResponseV1Schema.parse(await invoke('artifact.access.grants.set', childRole,
                        { artifactId, principal: teamPrincipal(input.teamId), accessLevel: 'admin' }));
                    resourceEffects.artifacts.push({ artifactId: result.artifactId,
                        ...(result.preparation ? { preparation: result.preparation } : {}) });
                    changed ||= result.changed;
                    if (result.preparation?.status === 'pending') throw new MoveStopped('held');
                    if (result.grants.some(grant => grant.principal.kind === 'account' && grant.principal.accountId === account.accountId)) withdrawArtifacts.push(artifactId);
                };
                for (const artifactId of inventory.artifacts) await share(artifactId, role('artifact', artifactId));
                for (const detail of inventory.environments) {
                    if (detail.environment.deletedAtMs !== undefined) continue;
                    const bindings = detail.content.bindings.filter(binding => binding.source.kind === 'secret').map(binding => {
                        const source = binding.source;
                        if (source.kind !== 'secret') return binding;
                        const copy = copied.copies.find(copy => copy.sourceRef === source.ref && copy.sourceRevision === source.resourceRevision);
                        if (!copy) throw new MoveStopped('held');
                        return { ...binding, source: { kind: 'secret' as const, ref: copy.ref, resourceRevision: copy.resourceRevision } };
                    });
                    if (!bindings.length) continue;
                    const written = DeploymentBindingsSetResultV1Schema.parse(await invoke('deployments.bindings.set', role('bindings', detail.environment.id), {
                        serverId: input.serverId, environmentId: detail.environment.id, expectedRevision: detail.environment.revision,
                        set: bindings, remove: [],
                    }));
                    if (!written.ok) throw new MoveStopped('held');
                    resourceEffects.bindings.push({ environmentId: written.environmentId, revision: written.revision });
                    changed = true;
                    if (!written.preparedArtifact) throw new MoveStopped('held');
                    resourceEffects.bindingArtifacts.push({ environmentId: written.environmentId, ...written.preparedArtifact });
                    await share(written.preparedArtifact.contentArtifactId, role('binding-artifact', detail.environment.id));
                }
                const owner = ProjectSourcesUpdateOutputV1Schema.parse(await invoke('projects.sources.update', 'source-owner', {
                    serverId: input.serverId, sourceId: input.sourceId, expectedRevision: input.expectedRevision, patch: { owner: teamPrincipal(input.teamId) },
                }));
                if (!owner.ok) return changed ? { kind: 'partial', source: owner.current ?? source, childOperations, resourceEffects } : owner;
                changed = true;
                source = owner.source;
                for (const token of inventory.ciTokens) {
                    const renewed = AccountApiTokensUpdateActionOutputV1Schema.parse(await invoke('account.apiTokens.update', role('token', token.tokenId), {
                        tokenId: token.tokenId, authorizeUnattendedTeamAccess: true,
                    })).apiToken;
                    if (renewed.tokenId !== token.tokenId || !renewed.hasUnattendedTeamAccess || !sameStrictJsonValue(renewed.grant, token.grant)) throw new MoveStopped('held');
                    resourceEffects.renewedTokenIds.push(renewed.tokenId);
                }
                const revisions = new Map<string, number>();
                for (const trigger of inventory.triggers) {
                    const written = WorkflowTriggerWriteResultV1Schema.parse(await invoke('workflow.trigger.update', role('trigger', `${trigger.automationId}/${trigger.triggerId}`), {
                        automationId: trigger.automationId, triggerId: trigger.triggerId,
                        expectedRevision: revisions.get(trigger.automationId) ?? trigger.revision, patch: { actionApproval: 'automatic' },
                    }));
                    if (!written.set.context?.actionApprovals?.some(approval => approval.triggerId === trigger.triggerId)) throw new MoveStopped('held');
                    resourceEffects.renewedTriggers.push({ automationId: written.set.automationId, triggerId: trigger.triggerId, revision: written.set.revision });
                    revisions.set(trigger.automationId, written.set.revision);
                }
                for (const artifactId of withdrawArtifacts) {
                    // Newly-created binding Artifacts have no explicit old grant; their creator
                    // attribution is intrinsic and is not a removable workload authority.
                    if (!inventory.artifacts.includes(artifactId)) continue;
                    const removed = ArtifactAccessGrantMutationResponseV1Schema.parse(await invoke('artifact.access.grants.remove', role('withdraw-artifact', artifactId),
                        { artifactId, principal: { kind: 'account', accountId: account.accountId } }));
                    if (removed.preparation?.status === 'pending') throw new MoveStopped('held');
                }
                for (const machine of inventory.machines) if (machine.withdrawDirectGrant) {
                    const removed = MachineAccessMutationResultV1Schema.parse(await invoke('machines.access.grant.remove', role('withdraw-machine', machine.machineId), {
                        serverId: input.serverId, machineId: machine.machineId, principal: { kind: 'account', accountId: account.accountId },
                    }));
                    if (removed.kind !== 'removed') throw new MoveStopped('held');
                }
                if (source.audience.some(grant => grant.principal.kind === 'account' && grant.principal.accountId === account.accountId)) {
                    const removed = ProjectSourcesUpdateOutputV1Schema.parse(await invoke('projects.sources.update', 'withdraw-source-audience', {
                        serverId: input.serverId, sourceId: input.sourceId, expectedRevision: source.revision,
                        patch: { audience: source.audience.filter(grant => grant.principal.kind !== 'account' || grant.principal.accountId !== account.accountId) },
                    }));
                    if (!removed.ok) return { kind: 'partial', source: removed.current ?? source, childOperations, resourceEffects };
                    source = removed.source;
                }
                if (source.owner?.kind !== 'team' || source.owner.teamId !== input.teamId) throw new MoveStopped('held');
                return { kind: 'completed', source: { ...source, owner: source.owner }, childOperations, resourceEffects };
            } catch (error) {
                if (error instanceof ProjectSourceTeamMoveReadFailure) return error.result;
                if (error instanceof MoveStopped) {
                    if (!changed && error.kind === 'failed' && error.failure) return error.failure;
                    return { kind: error.kind === 'outcome_unknown' ? 'outcome_unknown' : changed ? 'partial' : 'held',
                        ...(source ? { source } : {}), childOperations, resourceEffects };
                }
                if (changed) return { kind: 'partial', ...(source ? { source } : {}), childOperations, resourceEffects };
                return context.signal?.aborted ? moveFailure('cancelled') : prepareFailure(error);
            }
        },
    };
}
