import * as React from 'react';
import type { DeploymentEnvironmentTabV1 } from '@happier-dev/deployments';
import { readDeploymentPartialResult, deploymentPartialRecoveryTab, type DeploymentPartialResult } from '@/components/projects/deployments/deploymentActionOutcome';
import { DeploymentEnvironmentGetResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { type DeploymentPublishPrepareInputV1, type DeploymentPublishPrepareResultV1 } from '@happier-dev/protocol/deployments/deploymentPublishPreparationV1';
import { type DeploymentTemplateRefV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { ActionApprovalRequestCreatedResultSchema, type ActionApprovalRequestCreatedResult,
    type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { DeploymentTemplateInstantiationPartialV1Schema, DeploymentTemplateInstantiateResultV1Schema,
    type DeploymentTemplateInstantiateInputV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { RegistryItemV1, RegistryItemPayloadV1, DeploymentTemplateV1, RegistryAppMappingV1 } from '@happier-dev/protocol/registries';
import { useRegistryItem } from '@/registries/useRegistryItem';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useCatalogAppPreparation } from '@/components/projects/deployments/useCatalogAppPreparation';
import { buildCatalogAppTemplateBindings } from '@/sync/ops/actions/deploymentPublishActions';
import { buildDeploymentEnvironmentHref } from '@/components/projects/deployments/deploymentNavigation';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { randomUUID } from '@/platform/randomUUID';
import type { StoreDemand } from './catalog/storeKinds';
import { readDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { readStoreAppTemplateRef } from './presets/storePresetDoor';

function recoveryForPartial(progress: DeploymentPartialResult): DeploymentEnvironmentTabV1 | 'deploy' {
    return progress.phase === 'deploy'
        && readDeploymentFailureRecoveryV1(progress.errorCode, progress).nextAction.destination !== 'history'
        ? 'deploy' : deploymentPartialRecoveryTab(progress);
}

export type StoreAppListingSelection = Readonly<{ sourceId: string; itemId: string; version?: string }>;
/** Placement and Project intent come from the person; the selected Registry item supplies the pin. */
export type StoreAppPreparationInput = Omit<DeploymentPublishPrepareInputV1, 'serverId' | 'templateRef'>;
export type StoreAppPreparationOutcome = Awaited<ReturnType<ReturnType<typeof useCatalogAppPreparation>>>;
type StoreAppCreateEnvironment = Extract<DeploymentTemplateInstantiateInputV1['environment'], { kind: 'create' }>;
export type StoreAppCreateChoices = Readonly<Pick<StoreAppCreateEnvironment, 'name' | 'protection' | 'deployerMode'>
    & Partial<Pick<DeploymentTemplateInstantiateInputV1, 'bindings' | 'domainBindings' | 'volumeBindings' | 'companions'>>>;
export type StoreAppCreatedIdentity = Readonly<{ projectSourceId: string; environmentId: string; tab?: DeploymentEnvironmentTabV1 }>;
type StoreAppApplied = Extract<ReturnType<typeof DeploymentTemplateInstantiateResultV1Schema.parse>, { kind: 'applied' }>;
export type StoreAppCreateFailure = ActionExecuteFailure & Readonly<{ progress?: DeploymentPartialResult; recovery?: DeploymentEnvironmentTabV1 | 'deploy'; created?: StoreAppApplied }>;
export type StoreAppCreateOutcome = StoreAppCreatedIdentity | StoreAppCreateFailure | ActionApprovalRequestCreatedResult;
type NativeRead = ReturnType<typeof useRegistryItem>;
type ReadFacts = Pick<NativeRead, 'loading' | 'stale' | 'error' | 'status' | 'refresh'>;
type ReviewPayload = Extract<RegistryItemPayloadV1, { kind: 'app'; state: 'needs_review' }>;

export type StoreAppListingState = ReadFacts & (
    | Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'unavailable' }>
    | Readonly<{ kind: 'needs_review'; item: RegistryItemV1; diagnostics: ReviewPayload['diagnostics'];
        reviewSource?: RegistryAppMappingV1; correctMappings: (correction: RegistryAppMappingV1) => void }>
    | Readonly<{
        kind: 'ready'; item: RegistryItemV1; app: DeploymentTemplateV1; templateRef: DeploymentTemplateRefV1;
        appMappingCorrection?: RegistryAppMappingV1;
        prepare: (input: StoreAppPreparationInput, signal?: AbortSignal) => Promise<StoreAppPreparationOutcome>;
        create: (prepared: DeploymentPublishPrepareResultV1, choices: StoreAppCreateChoices, signal?: AbortSignal) => Promise<StoreAppCreateOutcome>;
        environmentHref: (input: StoreAppCreatedIdentity) => string;
    }>
);

/** Native selected read → exact pin → explicit preparation. The presenter supplies no template/default policy. */
export function useStoreAppListing(input: Readonly<{
    selection: StoreAppListingSelection;
    /** The active Registry Account's existing lifetime; the listing host supplies it. */
    lifetime: ServerAccountScopeLifetime;
    demand: StoreDemand;
    installMachineId?: string | null;
}>): StoreAppListingState {
    const selectionKey = JSON.stringify([input.lifetime.scope.serverId, input.lifetime.scope.accountId,
        input.selection.sourceId, input.selection.itemId, input.selection.version]);
    const [correction, setCorrection] = React.useState<{ selectionKey: string; value: RegistryAppMappingV1; version: string } | null>(null);
    const appMappingCorrection = correction?.selectionKey === selectionKey ? correction.value : undefined;
    const read = useRegistryItem({ kind: 'app', sourceId: input.selection.sourceId,
        itemId: input.selection.itemId, version: appMappingCorrection ? correction?.version : input.selection.version, ...(appMappingCorrection ? { appMappingCorrection } : {}) }, input.demand.presented, { installMachineId: input.installMachineId });
    const prepareCatalogApp = useCatalogAppPreparation(input.lifetime);
    // Equal choices on the same prepared review retry the latest attempt, including after a read refresh.
    // A new preparation or changed choices starts another attempt; nothing is persisted.
    const attempt = React.useRef<{ prepared: DeploymentPublishPrepareResultV1;
        input: DeploymentTemplateInstantiateInputV1 & { environment: StoreAppCreateEnvironment };
        partial?: ReturnType<typeof DeploymentTemplateInstantiationPartialV1Schema.parse>;
        applied?: StoreAppApplied } | undefined>(undefined);
    // The native reader marks an old selection stale while the next exact read is pending.
    const item = read.stale ? null : read.item;
    const version = item?.summary.version;
    const correctMappings = React.useCallback((value: RegistryAppMappingV1) => {
        if (version) setCorrection({ selectionKey, value, version });
    }, [selectionKey, version]);
    const entry = React.useMemo(() => {
        if (!item || item.payload.kind !== 'app') return null;
        if (item.payload.state === 'needs_review') return {
            kind: 'needs_review' as const, item, diagnostics: item.payload.diagnostics,
            reviewSource: item.payload.reviewSource, correctMappings,
        };
        const templateRef = readStoreAppTemplateRef(item)!;
        const execute = createFrontDoorActionExecute();
        return {
            kind: 'ready' as const, item, app: item.payload.app, templateRef, appMappingCorrection,
            prepare: (operand: StoreAppPreparationInput, signal?: AbortSignal) => prepareCatalogApp({
                ...operand, serverId: input.lifetime.scope.serverId, templateRef, ...(appMappingCorrection ? { appMappingCorrection } : {}),
            }, signal),
            create: async (prepared: DeploymentPublishPrepareResultV1, choices: StoreAppCreateChoices,
                signal?: AbortSignal): Promise<StoreAppCreateOutcome> => {
                if (!input.lifetime.isCurrent()) return {
                    ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed',
                };
                // Exactly the prepared Project: an existing Source, or the reviewed new Project the same create makes.
                const { projectSourceId, newProject } = prepared.project;
                const project = projectSourceId !== undefined ? { projectSourceId } : newProject ? { newProject } : null;
                if (!project) return { ok: false, errorCode: 'deployment_invalid', error: 'deployment_invalid' };
                const controllerMachineId = prepared.creationDefaults.values.controllerMachineId;
                if (!controllerMachineId) return { ok: false, errorCode: 'client_required', error: 'client_required' };
                let currentAttempt = attempt.current;
                if (!currentAttempt || currentAttempt.prepared !== prepared || currentAttempt.input.environment.name !== choices.name
                    || currentAttempt.input.environment.protection !== choices.protection || currentAttempt.input.environment.deployerMode !== choices.deployerMode
                    || !sameStrictJsonValue(currentAttempt.input.domainBindings, choices.domainBindings)
                    || !sameStrictJsonValue(currentAttempt.input.volumeBindings, choices.volumeBindings)
                    || !sameStrictJsonValue(currentAttempt.input.companions, choices.companions?.length ? choices.companions : undefined)
                    || !sameStrictJsonValue(currentAttempt.input.bindings, buildCatalogAppTemplateBindings(prepared.template, choices.bindings).bindings)) {
                    currentAttempt = { prepared, input: {
                        mode: 'apply', serverId: input.lifetime.scope.serverId, ...project, machineId: prepared.machine.machineId,
                        templateRef: prepared.templateRef, ...(appMappingCorrection ? { appMappingCorrection } : {}),
                        environment: { kind: 'create', requestKey: randomUUID(), name: choices.name,
                            protection: choices.protection, deployerMode: choices.deployerMode, purpose: 'standard',
                            ...prepared.creationDefaults.values, controllerMachineId },
                        deploy: { requestKey: randomUUID() },
                        ...(choices.domainBindings ? { domainBindings: choices.domainBindings } : {}),
                        ...(choices.volumeBindings ? { volumeBindings: choices.volumeBindings } : {}),
                        ...(choices.companions?.length ? { companions: choices.companions } : {}),
                        target: { kind: 'new', installationId: prepared.machine.installationId },
                        destination: { kind: 'stored' }, ...buildCatalogAppTemplateBindings(prepared.template, choices.bindings),
                    } };
                    attempt.current = currentAttempt;
                }
                const selectedAttempt = currentAttempt;
                const resolveCreated = async (created: StoreAppApplied): Promise<StoreAppCreateOutcome> => {
                    // Creation is already acknowledged. A failed Source lookup must never replay it.
                    const read = await execute('deployments.environments.get', {
                        serverId: input.lifetime.scope.serverId, environmentId: created.environmentId,
                    }, { surface: 'ui', serverId: input.lifetime.scope.serverId,
                        expectedAccountId: input.lifetime.scope.accountId, signal });
                    if (!input.lifetime.isCurrent()) return {
                        ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed',
                    };
                    if (!read.ok) return { ...read, created };
                    const detail = DeploymentEnvironmentGetResultV1Schema.safeParse(read.result).data;
                    if (!detail?.ok || detail.environment.id !== created.environmentId) return {
                        ok: false, errorCode: 'invalid_response', error: 'invalid_response', created,
                    };
                    return { projectSourceId: detail.environment.projectSourceId, environmentId: created.environmentId };
                };
                if (selectedAttempt.applied) return resolveCreated(selectedAttempt.applied);
                const retainFailure = (failure: ActionExecuteFailure): StoreAppCreateFailure => {
                    const progress = readDeploymentPartialResult(failure);
                    if (!progress) return failure;
                    selectedAttempt.partial = progress;
                    return { ...failure, progress, ...(progress.environmentId ? {
                        recovery: recoveryForPartial(progress),
                    } : {}) };
                };
                const partial = selectedAttempt.partial;
                let installInput: DeploymentTemplateInstantiateInputV1 = selectedAttempt.input;
                let installedProjectSourceId = projectSourceId;
                if (partial && recoveryForPartial(partial) !== 'deploy') {
                    const failure = { ok: false as const, errorCode: partial.errorCode, error: partial.errorCode, details: partial };
                    if (!partial.environmentId) return retainFailure(failure);
                    // The deployment owner named the failed step. Its existing editor owns recovery.
                    if (projectSourceId) return { projectSourceId, environmentId: partial.environmentId,
                        tab: deploymentPartialRecoveryTab(partial) };
                    const read = await execute('deployments.environments.get', {
                        serverId: input.lifetime.scope.serverId, environmentId: partial.environmentId,
                    }, { surface: 'ui', serverId: input.lifetime.scope.serverId,
                        expectedAccountId: input.lifetime.scope.accountId, signal });
                    if (!read.ok) return { ...read, progress: partial, recovery: deploymentPartialRecoveryTab(partial) };
                    const detail = DeploymentEnvironmentGetResultV1Schema.safeParse(read.result).data;
                    if (!detail?.ok || detail.environment.id !== partial.environmentId) return {
                        ok: false, errorCode: 'invalid_response', error: 'invalid_response', progress: partial,
                        recovery: deploymentPartialRecoveryTab(partial),
                    };
                    return { projectSourceId: detail.environment.projectSourceId, environmentId: partial.environmentId,
                        tab: deploymentPartialRecoveryTab(partial) };
                }
                if (partial) {
                    if (!partial.environmentId || !partial.targetLinkId || !partial.definition) return {
                        ok: false, errorCode: 'invalid_response', error: 'invalid_response', progress: partial,
                        recovery: recoveryForPartial(partial),
                    };
                    // Resume the existing template apply owner from its acknowledged Environment.
                    // Replaying create would materialize new Artifact references for the old create key.
                    const read = await execute('deployments.environments.get', {
                        serverId: input.lifetime.scope.serverId, environmentId: partial.environmentId,
                    }, { surface: 'ui', serverId: input.lifetime.scope.serverId,
                        expectedAccountId: input.lifetime.scope.accountId, signal });
                    if (!read.ok) return { ...read, progress: partial, recovery: recoveryForPartial(partial) };
                    const detail = DeploymentEnvironmentGetResultV1Schema.safeParse(read.result).data;
                    const target = detail?.ok ? detail.targetLinks.find(link => link.id === partial.targetLinkId) : undefined;
                    if (!detail?.ok || detail.environment.id !== partial.environmentId || !target) return {
                        ok: false, errorCode: 'invalid_response', error: 'invalid_response', progress: partial,
                        recovery: recoveryForPartial(partial),
                    };
                    installedProjectSourceId = detail.environment.projectSourceId;
                    installInput = {
                        mode: 'apply', serverId: input.lifetime.scope.serverId, machineId: prepared.machine.machineId,
                        projectSourceId: detail.environment.projectSourceId, templateRef: prepared.templateRef, ...(appMappingCorrection ? { appMappingCorrection } : {}),
                        environment: { kind: 'existing', environmentId: partial.environmentId, expectedRevision: detail.environment.revision },
                        target: { kind: 'existing', targetLinkId: target.id, expectedRevision: target.revision,
                            installationId: prepared.machine.installationId }, destination: partial.definition,
                        bindings: [], ...(choices.domainBindings ? { domainBindings: choices.domainBindings } : {}),
                        ...(choices.volumeBindings ? { volumeBindings: choices.volumeBindings } : {}),
                        ...(choices.companions?.length ? { companions: choices.companions } : {}),
                        deploy: { requestKey: randomUUID() },
                    };
                }
                const result = await execute.confirmed(DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1, installInput, {
                    surface: 'ui', serverId: input.lifetime.scope.serverId,
                    expectedAccountId: input.lifetime.scope.accountId, signal,
                });
                if (!result.ok) return retainFailure(result);
                const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
                if (approval.success) return approval.data;
                const applied = DeploymentTemplateInstantiateResultV1Schema.safeParse(result.result);
                if (!applied.success || applied.data.kind === 'preview') return {
                    ok: false, errorCode: 'invalid_response', error: 'invalid_response',
                };
                if (applied.data.kind === 'partial') return retainFailure({ ok: false,
                    errorCode: applied.data.errorCode, error: applied.data.errorCode, details: applied.data });
                if (installedProjectSourceId !== undefined) return { projectSourceId: installedProjectSourceId, environmentId: applied.data.environmentId };
                selectedAttempt.applied = applied.data;
                return resolveCreated(applied.data);
            },
            environmentHref: (identity: StoreAppCreatedIdentity) =>
                buildDeploymentEnvironmentHref({ ...identity, serverId: input.lifetime.scope.serverId }),
        };
    }, [item, prepareCatalogApp, input.lifetime, appMappingCorrection, correctMappings]);
    const facts: ReadFacts = { loading: read.loading, stale: read.stale, error: read.error, status: read.status, refresh: read.refresh };
    return entry ? { ...facts, ...entry } : { ...facts, kind: read.loading ? 'loading' : 'unavailable' };
}
