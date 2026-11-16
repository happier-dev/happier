import type { PluginJsonSchemaV2 } from '@happier-dev/protocol/plugins/contributions/publicTypes';
import type { AutomationTriggerEventDeclarationsRequest, AutomationTriggerEventDeclarationsResponse } from '@happier-dev/protocol/automations/automationApiV3';
import { readAutomationEligibleEventContributionV1 } from '@happier-dev/protocol/plugins/contributions/events';

import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { currentPluginDeclarationKeyV1, resolveCurrentPluginDeclarationsTx } from '@/app/plugins/availability/currentDeclaration';

export type AutomationEventPayloadSchemaSource = Readonly<{
    triggerId: string;
    accountId: string;
    pluginId: string;
    eventLocalId: string;
    sourceContractVersion?: number;
    machineId: string;
    machineInstallationId?: string;
    materializationId: string;
}>;

/** Saved and intended sources share the current materialization and Event declaration owner. */
export async function loadAutomationEventPayloadSchemas(sources: readonly AutomationEventPayloadSchemaSource[]): Promise<ReadonlyMap<string, PluginJsonSchemaV2>> {
    if (sources.length === 0) return new Map();
    return inTx(async tx => {
        const materializations = (await Promise.all(portableQueryChunks({ values: sources, bindingsPerValue: 5 }).map(chunk =>
            tx.pluginMachineMaterialization.findMany({
                where: { OR: chunk.map(source => ({ accountId: source.accountId, pluginId: source.pluginId,
                    machineId: source.machineId, materializationId: source.materializationId,
                    ...(source.machineInstallationId === undefined ? {} : { machine: { installationId: source.machineInstallationId } }) })) },
                select: { accountId: true, pluginId: true, machineId: true, materializationId: true, version: true,
                    machine: { select: { installationId: true } } },
            })))).flat();
        const materializationKey = (value: Readonly<{ accountId: string; pluginId: string; machineId: string; materializationId: string }>) =>
            JSON.stringify([value.accountId, value.pluginId, value.machineId, value.materializationId]);
        const byMaterialization = new Map(materializations.map(value => [materializationKey(value), value]));
        const groups = new Map<string, Array<AutomationEventPayloadSchemaSource & { version: string; machineInstallationId: string }>>();
        for (const source of sources) {
            const materialization = byMaterialization.get(materializationKey(source));
            if (!materialization || materialization.machine.installationId === null
                || source.machineInstallationId !== undefined && source.machineInstallationId !== materialization.machine.installationId) continue;
            const group = groups.get(source.accountId) ?? [];
            group.push({ ...source, version: materialization.version, machineInstallationId: materialization.machine.installationId });
            groups.set(source.accountId, group);
        }
        const schemas = new Map<string, PluginJsonSchemaV2>();
        for (const [accountId, refs] of groups) {
            const declarations = await resolveCurrentPluginDeclarationsTx({ tx, accountId, refs });
            for (const source of refs) {
                const declaration = declarations.get(currentPluginDeclarationKeyV1(source.pluginId, source.version,
                    source.machineId, source.machineInstallationId));
                if (!declaration) continue;
                const contribution = readAutomationEligibleEventContributionV1({ events: declaration.manifest.contributes.events,
                    eventLocalId: source.eventLocalId, sourceContractVersion: source.sourceContractVersion });
                if (contribution) schemas.set(source.triggerId, contribution.payloadSchema);
            }
        }
        return schemas;
    });
}

/** Account query for pending source locators; authored payload schemas never cross this boundary. */
export async function readAutomationTriggerEventDeclarations(accountId: string,
    input: AutomationTriggerEventDeclarationsRequest): Promise<AutomationTriggerEventDeclarationsResponse> {
    const durableSources = input.triggerEventDeclarations.flatMap(trigger => trigger.observationTransport.kind === 'durablePush'
        ? [{ pluginId: trigger.eventRef.pluginId, webhookEndpointId: trigger.observationTransport.webhookEndpointId }] : []);
    const endpoints = (await Promise.all(portableQueryChunks({ values: durableSources, bindingsPerValue: 2, fixedBindings: 1 }).map(chunk =>
        db.pluginWebhookEndpoint.findMany({ where: { accountId, releasedAt: null,
            OR: chunk.map(source => ({ id: source.webhookEndpointId, pluginId: source.pluginId })) },
            select: { id: true, pluginId: true, targetMachineId: true, targetMachineInstallationId: true, targetMaterializationId: true } })))).flat();
    const byEndpoint = new Map(endpoints.map(endpoint => [endpoint.id, endpoint]));
    const sources = input.triggerEventDeclarations.flatMap((trigger, index): AutomationEventPayloadSchemaSource[] => {
        const transport = trigger.observationTransport;
        if (transport.kind !== 'durablePush') {
            const watcher = transport.watcherMaterializationRef;
            if (watcher.pluginId !== trigger.eventRef.pluginId) return [];
            return [{ triggerId: String(index), accountId, pluginId: trigger.eventRef.pluginId,
                eventLocalId: trigger.eventRef.localId, machineId: watcher.machineId, materializationId: watcher.materializationId }];
        }
        const endpoint = byEndpoint.get(transport.webhookEndpointId);
        if (!endpoint || endpoint.pluginId !== trigger.eventRef.pluginId || endpoint.targetMachineId === null
            || endpoint.targetMachineInstallationId === null || endpoint.targetMaterializationId === null) return [];
        return [{ triggerId: String(index), accountId, pluginId: trigger.eventRef.pluginId, eventLocalId: trigger.eventRef.localId,
            machineId: endpoint.targetMachineId, machineInstallationId: endpoint.targetMachineInstallationId,
            materializationId: endpoint.targetMaterializationId }];
    });
    const schemas = await loadAutomationEventPayloadSchemas(sources);
    return { triggerEvents: input.triggerEventDeclarations.map((trigger, index) => ({ event: trigger.eventRef,
        payloadSchema: schemas.get(String(index)) ?? null })) };
}
