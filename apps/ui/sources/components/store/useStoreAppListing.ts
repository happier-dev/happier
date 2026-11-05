import * as React from 'react';
import { DeploymentEnvironmentCreateResultV1Schema, DeploymentEnvironmentGetResultV1Schema, type DeploymentEnvironmentCreateIntentInputV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { type DeploymentPublishPrepareInputV1, type DeploymentPublishPrepareResultV1 } from '@happier-dev/protocol/deployments/deploymentPublishPreparationV1';
import { type DeploymentTemplateRefV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { ActionApprovalRequestCreatedResultSchema, type ActionApprovalRequestCreatedResult,
    type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { DeploymentTemplateInstantiationPartialV1Schema, DeploymentTemplateInstantiateResultV1Schema,
    type DeploymentTemplateInstantiateInputV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { RegistryItemV1, RegistryItemPayloadV1, DeploymentTemplateV1 } from '@happier-dev/protocol/registries';
import { useRegistryItem } from '@/registries/useRegistryItem';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useCatalogAppPreparation } from '@/components/projects/deployments/useCatalogAppPreparation';
import { buildDeploymentEnvironmentHref } from '@/components/projects/deployments/deploymentNavigation';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { randomUUID } from '@/platform/randomUUID';
import type { StoreDemand } from './catalog/storeKinds';

export type StoreAppListingSelection = Readonly<{ sourceId: string; itemId: string; version?: string }>;
/** Placement and Project intent come from the person; the selected Registry item supplies the pin. */
export type StoreAppPreparationInput = Omit<DeploymentPublishPrepareInputV1, 'serverId' | 'templateRef'>;
export type StoreAppPreparationOutcome = Awaited<ReturnType<ReturnType<typeof useCatalogAppPreparation>>>;
export type StoreAppCreateChoices = Readonly<Pick<DeploymentEnvironmentCreateIntentInputV1, 'name' | 'protection' | 'deployerMode' | 'domainBindings'>>;
export type StoreAppCreatedIdentity = Readonly<{ projectSourceId: string; environmentId: string }>;
export type StoreAppCreateOutcome = StoreAppCreatedIdentity | ActionExecuteFailure | ActionApprovalRequestCreatedResult;
type NativeRead = ReturnType<typeof useRegistryItem>;
type ReadFacts = Pick<NativeRead, 'loading' | 'stale' | 'error' | 'status' | 'refresh'>;
type ReviewPayload = Extract<RegistryItemPayloadV1, { kind: 'app'; state: 'needs_review' }>;

export type StoreAppListingState = ReadFacts & (
    | Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'unavailable' }>
    | Readonly<{ kind: 'needs_review'; item: RegistryItemV1; diagnostics: ReviewPayload['diagnostics'] }>
    | Readonly<{
        kind: 'ready'; item: RegistryItemV1; app: DeploymentTemplateV1; templateRef: DeploymentTemplateRefV1;
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
}>): StoreAppListingState {
    const read = useRegistryItem({ kind: 'app', ...input.selection }, input.demand.presented);
    const prepareCatalogApp = useCatalogAppPreparation(input.lifetime);
    // Equal choices on the same prepared review retry the latest attempt, including after a read refresh.
    // A new preparation or changed choices starts another attempt; nothing is persisted.
    const attempt = React.useRef<{ prepared: DeploymentPublishPrepareResultV1;
        input: DeploymentEnvironmentCreateIntentInputV1;
        partial?: ReturnType<typeof DeploymentTemplateInstantiationPartialV1Schema.parse> } | undefined>(undefined);
    // The native reader marks an old selection stale while the next exact read is pending.
    const item = read.stale ? null : read.item;
    const entry = React.useMemo(() => {
        if (!item || item.payload.kind !== 'app') return null;
        if (item.payload.state === 'needs_review') return {
            kind: 'needs_review' as const, item, diagnostics: item.payload.diagnostics,
        };
        const templateRef: DeploymentTemplateRefV1 = {
            sourceId: item.summary.sourceId, itemId: item.summary.itemId,
            // RegistryItemV1 admission requires every App summary version to identify its payload ref.
            version: item.summary.version!, ref: item.payload.ref,
        };
        const execute = createFrontDoorActionExecute();
        return {
            kind: 'ready' as const, item, app: item.payload.app, templateRef,
            prepare: (operand: StoreAppPreparationInput, signal?: AbortSignal) => prepareCatalogApp({
                ...operand, serverId: input.lifetime.scope.serverId, templateRef,
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
                let currentAttempt = attempt.current;
                if (!currentAttempt || currentAttempt.prepared !== prepared || currentAttempt.input.name !== choices.name
                    || currentAttempt.input.protection !== choices.protection || currentAttempt.input.deployerMode !== choices.deployerMode
                    || !sameStrictJsonValue(currentAttempt.input.domainBindings, choices.domainBindings)) {
                    currentAttempt = { prepared, input: {
                        serverId: input.lifetime.scope.serverId, ...project, requestKey: randomUUID(),
                        name: choices.name, protection: choices.protection, deployerMode: choices.deployerMode,
                        ...(choices.domainBindings ? { domainBindings: choices.domainBindings } : {}),
                        purpose: 'standard', definition: { from: 'catalogApp', templateRef: prepared.templateRef },
                        firstTargetLink: { machines: [prepared.machine] }, ...prepared.creationDefaults.values,
                    } };
                    attempt.current = currentAttempt;
                }
                const selectedAttempt = currentAttempt;
                const retainFailure = (failure: ActionExecuteFailure): ActionExecuteFailure => {
                    const partial = DeploymentTemplateInstantiationPartialV1Schema.safeParse(failure.details);
                    if (partial.success && partial.data.phase === 'deploy') selectedAttempt.partial = partial.data;
                    return failure;
                };
                const partial = selectedAttempt.partial;
                if (partial) {
                    if (!partial.environmentId || !partial.targetLinkId || !partial.definition) return {
                        ok: false, errorCode: 'invalid_response', error: 'invalid_response',
                    };
                    // Resume the existing template apply owner from its acknowledged Environment.
                    // Replaying create would materialize new Artifact references for the old create key.
                    const read = await execute('deployments.environments.get', {
                        serverId: input.lifetime.scope.serverId, environmentId: partial.environmentId,
                    }, { surface: 'ui', serverId: input.lifetime.scope.serverId,
                        expectedAccountId: input.lifetime.scope.accountId, signal });
                    if (!read.ok) return read;
                    const detail = DeploymentEnvironmentGetResultV1Schema.safeParse(read.result).data;
                    const target = detail?.ok ? detail.targetLinks.find(link => link.id === partial.targetLinkId) : undefined;
                    if (!detail?.ok || !target) return { ok: false, errorCode: 'invalid_response', error: 'invalid_response' };
                    const retry: DeploymentTemplateInstantiateInputV1 = {
                        mode: 'apply', serverId: input.lifetime.scope.serverId, machineId: prepared.machine.machineId,
                        projectSourceId: detail.environment.projectSourceId, templateRef: prepared.templateRef,
                        environment: { kind: 'existing', environmentId: partial.environmentId, expectedRevision: detail.environment.revision },
                        target: { kind: 'existing', targetLinkId: target.id, expectedRevision: target.revision,
                            installationId: prepared.machine.installationId }, destination: partial.definition,
                        bindings: [], ...(choices.domainBindings ? { domainBindings: choices.domainBindings } : {}),
                        deploy: { requestKey: randomUUID() },
                    };
                    const result = await execute('deployments.templates.instantiate', retry, {
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
                    return { projectSourceId: detail.environment.projectSourceId, environmentId: applied.data.environmentId };
                }
                const result = await execute('deployments.environments.create', currentAttempt.input, {
                    surface: 'ui', serverId: input.lifetime.scope.serverId,
                    expectedAccountId: input.lifetime.scope.accountId, signal,
                });
                if (!result.ok) return retainFailure(result);
                const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
                if (approval.success) return approval.data;
                // The Action executor already settles domain refusals as ActionExecuteFailure.
                const created = DeploymentEnvironmentCreateResultV1Schema.def.options[0].parse(result.result);
                if (projectSourceId !== undefined) return { projectSourceId, environmentId: created.environmentId };
                // The create result names only the Environment; its new Source is read back from the Environment.
                const read = await execute('deployments.environments.get', {
                    serverId: input.lifetime.scope.serverId, environmentId: created.environmentId,
                }, { surface: 'ui', serverId: input.lifetime.scope.serverId,
                    expectedAccountId: input.lifetime.scope.accountId, signal });
                if (!read.ok) return read;
                const detail = DeploymentEnvironmentGetResultV1Schema.safeParse(read.result).data;
                if (!detail?.ok || detail.environment.id !== created.environmentId) return {
                    ok: false, errorCode: 'invalid_response', error: 'invalid_response',
                };
                return { projectSourceId: detail.environment.projectSourceId, environmentId: created.environmentId };
            },
            environmentHref: (identity: StoreAppCreatedIdentity) =>
                buildDeploymentEnvironmentHref({ ...identity, serverId: input.lifetime.scope.serverId }),
        };
    }, [item, prepareCatalogApp, input.lifetime]);
    const facts: ReadFacts = { loading: read.loading, stale: read.stale, error: read.error, status: read.status, refresh: read.refresh };
    return entry ? { ...facts, ...entry } : { ...facts, kind: read.loading ? 'loading' : 'unavailable' };
}
