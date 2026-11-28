import { GITHUB_MANAGED_PREVIEW_EVENT_LOCAL_ID_V1, readGithubRepositoryIdFromEventSourceV1, readManagedGithubRepositoryEventV1 } from '@happier-dev/protocol/automations/event-setup-result';
import type { ManagedPluginWebhookRequestV1 } from '@happier-dev/protocol/plugins/webhooks/managedRepositoryWebhookRpcV1';

import type { ForwardManagedPluginWebhookOperation } from '@/app/api/socket/managedPluginWebhookDispatcher';
import { readAutomationTriggerDefinitionBinding, validateAutomationTriggerDefinitionEnvelopeOuterForMode } from '@/app/automations/automationStoredContentRead';
import type { AutomationTriggerItem } from '@/app/automations/automationTypes';
import { db } from '@/storage/db';

import { isManagedGithubEndpointKey, revokePluginWebhookEndpointV1 } from './endpointStore';

export type DeletedManagedWebhookConsumer = Pick<AutomationTriggerItem,
    'id' | 'automationId' | 'revision' | 'kind' | 'eventPluginId' | 'eventLocalId'
    | 'sourceSelectorId' | 'definitionEnvelope' | 'webhookEndpointId'>;

export type ManagedWebhookCleanupResult = Readonly<{ kind: 'retained' | 'removed' }>
    | Readonly<{ kind: 'unavailable'; code: string }>;

const unavailable = (code: string): ManagedWebhookCleanupResult => ({ kind: 'unavailable', code });

/** The endpoint owns both remote removal and route retirement, after the consumer has committed deletion. */
export async function removeUnusedManagedRepositoryWebhook(params: Readonly<{
    accountId: string;
    consumer: DeletedManagedWebhookConsumer;
    forward: ForwardManagedPluginWebhookOperation;
}>): Promise<ManagedWebhookCleanupResult> {
    const { consumer, accountId } = params;
    if (!consumer.webhookEndpointId) return { kind: 'retained' };
    try {
        const endpoint = await db.pluginWebhookEndpoint.findFirst({
            where: { id: consumer.webhookEndpointId, accountId, enabled: true, revokedAt: null },
            select: {
                id: true, revision: true, ensureIdempotencyKey: true, sourceInstanceId: true,
                providerRepositoryHookId: true, targetMachineId: true, targetMachineInstallationId: true,
                targetMaterializationId: true, account: { select: { encryptionMode: true } },
            },
        });
        if (!endpoint || !isManagedGithubEndpointKey(endpoint.ensureIdempotencyKey)) return { kind: 'retained' };
        const remaining = { webhookEndpointId: endpoint.id, deletedAt: null,
            automation: { accountId, deletedAt: null, OR: [
                { deploymentEnvironmentId: null }, { deploymentEnvironment: { deletedAt: null } },
            ] } };
        const otherConsumer = await db.automationTrigger.findFirst({ where: remaining, select: { id: true } });
        const event = consumer.eventPluginId && consumer.eventLocalId
            ? readManagedGithubRepositoryEventV1({ pluginId: consumer.eventPluginId, localId: consumer.eventLocalId }) : null;
        if (otherConsumer && (event !== 'pull_request' || await db.automationTrigger.findFirst({
            where: { ...remaining, eventPluginId: consumer.eventPluginId, eventLocalId: GITHUB_MANAGED_PREVIEW_EVENT_LOCAL_ID_V1,
                enabled: true, automation: { ...remaining.automation, enabled: true, deploymentPreviewRole: 'preview_admission' } },
            select: { id: true },
        }))) return { kind: 'retained' };
        const kind = otherConsumer ? 'unsubscribePullRequests' : 'remove';
        const operationId = `${endpoint.id}:${kind}:${endpoint.revision}`;
        const removeRemoteSubscription = async () => {
            if (endpoint.providerRepositoryHookId === null) return undefined;
            const repositoryId = endpoint.sourceInstanceId && readGithubRepositoryIdFromEventSourceV1(endpoint.sourceInstanceId);
            const binding = readAutomationTriggerDefinitionBinding({
                automationId: consumer.automationId, triggerId: consumer.id, triggerRevision: consumer.revision,
                triggerKind: consumer.kind, triggerEventPluginId: consumer.eventPluginId,
                triggerEventLocalId: consumer.eventLocalId, triggerSourceSelectorId: consumer.sourceSelectorId,
            });
            if (!repositoryId || !binding || !consumer.definitionEnvelope || !endpoint.account || !endpoint.targetMachineId
                || !endpoint.targetMachineInstallationId || !endpoint.targetMaterializationId) return 'endpoint_unavailable';
            const envelope = validateAutomationTriggerDefinitionEnvelopeOuterForMode({
                raw: consumer.definitionEnvelope, mode: endpoint.account.encryptionMode, binding,
            });
            if (envelope.kind !== 'available') return 'endpoint_unavailable';
            const operation: Extract<ManagedPluginWebhookRequestV1, { kind: typeof kind }> = {
                kind, endpointId: endpoint.id, repositoryId, hookId: endpoint.providerRepositoryHookId,
                operationId, materializationId: endpoint.targetMaterializationId, binding, storedDefinitionEnvelope: envelope.envelope,
            };
            const result = await params.forward({ target: {
                accountId, machineId: endpoint.targetMachineId, installationId: endpoint.targetMachineInstallationId,
            }, operation });
            if (kind === 'remove' && result.kind === 'removed'
                || kind === 'unsubscribePullRequests' && result.kind === 'registered'
                    && result.hookId === endpoint.providerRepositoryHookId) return undefined;
            return result.kind === 'unavailable' ? result.code : 'github_webhook_result_invalid';
        };
        const removalError = await removeRemoteSubscription().catch(() => 'github_webhook_removal_unconfirmed');
        if (otherConsumer) return removalError ? unavailable(removalError) : { kind: 'retained' };
        // A failed provider write can leave a visible hook in GitHub. Home still
        // retires the route once its last consumer is gone.
        await revokePluginWebhookEndpointV1({
            accountId, webhookEndpointId: endpoint.id, expectedRevision: endpoint.revision,
            idempotencyKey: operationId,
        });
        return removalError ? unavailable(removalError) : { kind: 'removed' };
    } catch {
        return unavailable('github_webhook_removal_unconfirmed');
    }
}
