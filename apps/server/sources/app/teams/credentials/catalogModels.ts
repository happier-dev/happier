import { z } from 'zod/mini';
import { TeamCredentialResourceReadInputV1Schema, TeamCredentialResourceEntitledPageV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { DaemonProviderModelProjectionResponseV1Schema, type TeamCredentialSourceModelProjectionFailureV1 } from '@happier-dev/protocol/rpc/providers';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { Fastify } from '@/app/api/types';
import type { TeamCredentialCatalogReadinessProjection } from './brokerReadiness';
import { projectTeamCredentialProviderModels, selectPoolBackedTeamCredentialProviderModels } from './providerModelProjection';
import { readManagedNativeCredentialQualification } from '@/app/machines/managed/credentialDeliveryAdmission';

export async function projectTeamCredentialCatalogModels(
    app: Pick<Fastify, 'forwardRpcForUser'>,
    result: TeamCredentialCatalogReadinessProjection,
    application: NonNullable<z.infer<typeof TeamCredentialResourceReadInputV1Schema>["application"]>,
) {
    const resourcesById = new Map(result.page.resources.map(resource => [resource.id, resource] as const));
    const { presenceByAccount, poolSnapshots } = result.brokerReadiness;
    const projectionRpcByKey = new Map<string, ReturnType<typeof app.forwardRpcForUser>>();
    const nativeQualificationByManagedId = new Map<string, Promise<boolean>>();
    type ProjectionFailureReason = TeamCredentialSourceModelProjectionFailureV1['reason'] | 'catalog_empty';
    const projectionFailuresByResourceId = new Map<string, ProjectionFailureReason[]>();
    await Promise.all(result.projectionRequests.map(async projectionRequest => {
        const resource = resourcesById.get(projectionRequest.resourceId);
        if (!resource) return;
        if (projectionRequest.deliveryMode === 'vendor-native') {
            const target = projectionRequest.nativeTarget;
            if (!target) {
                resource.deliveryUnavailableReason = 'provider_credential_transport_unavailable';
                resource.recoveryAction = 'choose_another_resource';
                return;
            }
            let qualified = nativeQualificationByManagedId.get(target.machine.id);
            if (!qualified) {
                qualified = readManagedNativeCredentialQualification(app, target);
                nativeQualificationByManagedId.set(target.machine.id, qualified);
            }
            if (!await qualified) {
                resource.deliveryUnavailableReason = 'provider_credential_transport_unavailable';
                resource.recoveryAction = 'choose_another_resource';
                return;
            }
        }
        const poolSnapshot = projectionRequest.deliveryMode === 'brokered' && projectionRequest.brokerPoolId
            ? await (async () => {
                const snapshot = poolSnapshots.get(`${projectionRequest.custodianAccountId}\u0000${projectionRequest.brokerPoolId}`);
                return snapshot ? { ok: true as const, value: snapshot } : null;
            })()
            : null;
        const machineIds = projectionRequest.deliveryMode === 'vendor-native'
            ? [projectionRequest.nativeTarget!.controller.machineId]
            : projectionRequest.deliveryMode === 'direct'
            ? await (async () => {
                const presence = await presenceByAccount.get(projectionRequest.custodianAccountId)!;
                return presence.state !== 'unavailable' ? [...presence.machineIds] : [];
            })()
            : projectionRequest.brokerMachineId
                ? [projectionRequest.brokerMachineId]
                : poolSnapshot?.ok
                    ? poolSnapshot.value.members.flatMap(member => (
                        member.enabled && poolSnapshot.value.availableMachineIds.has(member.machineId)
                            ? [member.machineId]
                            : []
                    ))
                    : [];
        const projections = await Promise.all(machineIds.map(async machineId => {
            const rpcKey = JSON.stringify([projectionRequest.custodianAccountId, machineId,
                projectionRequest.source, application,
                projectionRequest.deliveryMode,
                projectionRequest.deliveryMode === 'vendor-native' ? [projectionRequest.resourceId, projectionRequest.resourceRevision] : null]);
            let rpc = projectionRpcByKey.get(rpcKey);
            if (!rpc) {
                rpc = app.forwardRpcForUser({
                userId: projectionRequest.custodianAccountId,
                method: `${machineId}:${RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION}`,
                params: {
                machineId,
                agentTargetKey: application!.agentTargetKey,
                application: application,
                sourceCatalog: true,
                ...(projectionRequest.deliveryMode === 'vendor-native'
                    ? { nativeSource: { resourceId: projectionRequest.resourceId,
                        expectedResourceRevision: projectionRequest.resourceRevision }, refreshPolicy: 'current_only' as const } : {}),
                ...(poolSnapshot?.ok ? { refreshPolicy: "current_only" as const } : {}),
                ...(projectionRequest.deliveryMode === 'direct'
                    ? { includeDirectMaterialization: true as const }
                    : {}),
                ...(projectionRequest.source.kind === 'provider_connection'
                    ? { providerConnection: {
                        connectionId: projectionRequest.source.connectionId,
                        expectedConnectionSecurityFingerprint: projectionRequest.source.connectionSecurityFingerprint,
                    } }
                    : { connectedAccountTarget: projectionRequest.source.target }),
                },
                });
                projectionRpcByKey.set(rpcKey, rpc);
            }
            const rpcResult = await rpc.catch(() => ({ ok: false as const, error: 'projection_unavailable' }));
            if (!rpcResult.ok) return { machineId, models: [], response: null, failure: 'projection_unavailable' as const };
            const projection = projectTeamCredentialProviderModels({
                response: rpcResult.result,
                resourceId: projectionRequest.resourceId,
                teamId: projectionRequest.teamId,
                resourceRevision: projectionRequest.resourceRevision,
                agentTargetKey: application!.agentTargetKey,
                application: application!,
                allowedModelIds: projectionRequest.allowedModelIds,
                source: projectionRequest.source,
                deliveryMode: projectionRequest.deliveryMode,
                directMaterialReferences: projectionRequest.directMaterialReferences,
            });
            return {
                machineId,
                models: [...projection.models],
                failure: projection.status === 'unavailable' ? projection.reason : null,
                response: rpcResult.result,
            };
        }));
        const projectedModels = poolSnapshot?.ok
            ? selectPoolBackedTeamCredentialProviderModels({
                members: poolSnapshot.value.members,
                availableMachineIds: poolSnapshot.value.availableMachineIds,
                candidates: projections.flatMap(({ machineId, models }) => models.map(model => ({ machineId, model }))),
                requestKey: `credential-catalog\u0000${projectionRequest.resourceId}\u0000${projectionRequest.resourceRevision}`,
            })
            : projections.flatMap(projection => projection.models);
        const models = new Map<string, (typeof resource.providerModels)[number]>();
        for (const model of [...resource.providerModels, ...projectedModels]) {
            const key = [model.selection.modelId, model.sourceRevision,
                model.selection.deliveryMode,
                model.application.agentTargetKey, model.application.implementationIdentity.pluginId,
                model.application.implementationIdentity.localId, model.application.endpointTemplateId,
                model.application.protocol].join('\u0000');
            models.set(key, model);
        }
        resource.providerModels = [...models.values()];
        if (projectedModels.length === 0) {
            const reasons: ProjectionFailureReason[] = projections.length === 0
                ? ['projection_unavailable']
                : projections.map(projection => projection.failure ?? 'catalog_empty');
            const current = projectionFailuresByResourceId.get(resource.id) ?? [];
            projectionFailuresByResourceId.set(resource.id, [...current, ...reasons]);
        }
        if (projectionRequest.source.kind === 'provider_connection') {
            const providerConnectionSource = projectionRequest.source;
            const sourceAuthority = projections.flatMap(({ response }) => {
                const projection = DaemonProviderModelProjectionResponseV1Schema.safeParse(response);
                if (!projection.success || projection.data.status !== 'success') return [];
                const authority = projection.data.groups.find(group => (
                    group.connectionId === providerConnectionSource.connectionId
                    && group.sourceAuthority?.connectionSecurityFingerprint
                        === providerConnectionSource.connectionSecurityFingerprint
                ))?.sourceAuthority;
                return authority ? [authority] : [];
            })[0];
            if (!sourceAuthority || resource.providerModels.length === 0) return;
            resource.sourcePresentation = {
                kind: 'provider',
                provider: sourceAuthority.provider,
            };
        }
    }));
    for (const resource of resourcesById.values()) {
        // Live catalog observations never clear a configured allowance or
        // an independently observed structural source/entitlement refusal.
        if (resource.readiness.kind !== 'available'
            && resource.readiness.kind !== 'broker_unavailable'
            && !(resource.readiness.kind === 'source_unavailable'
                && result.projectionRequests.some(request => request.resourceId === resource.id
                    && request.source.kind === 'provider_connection'))) continue;
        const reasons = projectionFailuresByResourceId.get(resource.id);
        if (reasons?.includes('connected_service_credential_reconnect_required')) {
            resource.providerModels = [];
            resource.readiness = { kind: 'source_unavailable', reason: 'connected_service_credential_reconnect_required' };
            resource.recoveryAction = 'source_owner_action';
            continue;
        }
        if (resource.providerModels.some(model => model.availability === 'available')
            || (resource.mayReceiveDirect && resource.directMaterialState === 'current')) {
            resource.readiness = { kind: 'available' };
            resource.recoveryAction = null;
            delete resource.deliveryUnavailableReason;
        } else if (resource.providerModels.length === 0) {
            if (!reasons?.length) continue;
            const brokerReasons = reasons.filter(reason => reason !== 'connected_service_credential_reconnect_required');
            const reason = brokerReasons.every(candidate => candidate === brokerReasons[0]) ? brokerReasons[0]! : 'projection_unavailable';
            resource.readiness = { kind: 'broker_unavailable', reason };
            resource.recoveryAction = reason === 'not_granted' || reason === 'incompatible'
                ? 'source_owner_action' : 'retry';
        }
    }
    return TeamCredentialResourceEntitledPageV1Schema.parse({
        resources: [...resourcesById.values()],
        nextCursor: result.page.nextCursor,
    });
}
