import type { ManagedPluginWebhookRequestV1 } from '@happier-dev/protocol/plugins/webhooks/managedRepositoryWebhookRpcV1';
import {
    GITHUB_EVENT_SETUP_ACTIONS_V1, GITHUB_MANAGED_PUSH_EVENT_LOCAL_ID_V1,
    type ManagedGithubRepositoryHookSaveResultV1,
} from '@happier-dev/protocol/automations/event-setup-result';

import type { ForwardManagedPluginWebhookOperation } from '@/app/api/socket/managedPluginWebhookDispatcher';
import { ensureAutomationEventCatalogStateTx } from '@/app/automations/automationEnabledTransition';
import { readCurrentAutomationEventDurablePushWebhookContributionV1, resolveCurrentAutomationEventContributionTx } from '@/app/automations/automationEventCurrentness';
import { readAutomationTriggerDefinitionBinding, validateAutomationTriggerDefinitionEnvelopeOuterForMode } from '@/app/automations/automationStoredContentRead';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';

import { resolveCurrentPluginWebhookContributionTxV1 } from './currentContribution';
import { resolveCurrentPluginWebhookTargetTxV1 } from './currentTarget';
import { readPluginWebhookVerificationCredentialsV1 } from './credentialStore';
import { ensurePluginWebhookEndpointV1, managedGithubEndpointKey, PluginWebhookEndpointStoreError } from './endpointStore';

type Registration = Extract<ManagedPluginWebhookRequestV1, { kind: 'register' }>;
type RegistrationResult = ManagedGithubRepositoryHookSaveResultV1;

type ManagedRegistration = Readonly<{
    accountId: string;
    automationId: string;
    triggerId: string;
    triggerRevision: number;
    repositoryId: string;
    /** Supplied by the Home reachability owner. */
    publicBaseUrl: string;
    forward: ForwardManagedPluginWebhookOperation;
}>;

/**
 * The trigger was saved as polling. Admit its endpoint and record its durable
 * attachment together, then send the verifier in the private Machine call.
 */
export async function registerManagedPluginWebhookForEndpoint(
    input: ManagedRegistration,
): Promise<RegistrationResult> {
    const polling = (code: string): RegistrationResult => ({ kind: 'polling', code });
    const pluginId = GITHUB_EVENT_SETUP_ACTIONS_V1.pluginId;
    const triggerWhere = {
        id: input.triggerId, automationId: input.automationId, revision: input.triggerRevision,
        deletedAt: null, kind: 'pluginEvent' as const,
        eventPluginId: pluginId, eventLocalId: GITHUB_MANAGED_PUSH_EVENT_LOCAL_ID_V1,
        automation: { accountId: input.accountId, deletedAt: null },
    };
    try {
        const serverIdentityId = await getOrCreateServerIdentityId(process.env);
        const admitted = await inTx(async (tx) => {
            const trigger = await tx.automationTrigger.findFirst({
                where: triggerWhere,
                include: { automation: { select: { account: { select: { encryptionMode: true } } } } },
            });
            if (!trigger) return { kind: 'result', result: polling('endpoint_unavailable') } as const;
            if (trigger.observationTransport === 'durablePush') {
                return { kind: 'result', result: { kind: 'webhook' } } as const;
            }
            if (trigger.observationTransport !== 'checkpointedPull'
                || !trigger.watcherMachineId || !trigger.watcherMaterializationId
                || !trigger.watcherMachineInstallationId || !trigger.definitionEnvelope) {
                return { kind: 'result', result: polling('endpoint_unavailable') } as const;
            }
            const binding = readAutomationTriggerDefinitionBinding({
                automationId: trigger.automationId, triggerId: trigger.id, triggerRevision: trigger.revision,
                triggerKind: trigger.kind, triggerEventPluginId: trigger.eventPluginId,
                triggerEventLocalId: trigger.eventLocalId, triggerSourceSelectorId: trigger.sourceSelectorId,
            });
            if (!binding) return { kind: 'result', result: polling('endpoint_unavailable') } as const;
            const envelope = validateAutomationTriggerDefinitionEnvelopeOuterForMode({
                raw: trigger.definitionEnvelope, mode: trigger.automation.account.encryptionMode, binding,
            });
            if (envelope.kind !== 'available') return { kind: 'result', result: polling('endpoint_unavailable') } as const;
            const target = await resolveCurrentPluginWebhookTargetTxV1({
                tx, serverIdentityId, accountId: input.accountId,
                target: { pluginId, machineId: trigger.watcherMachineId, materializationId: trigger.watcherMaterializationId },
            });
            if (!target || target.machineInstallationId !== trigger.watcherMachineInstallationId) {
                return { kind: 'result', result: polling('target_unavailable') } as const;
            }
            const event = await resolveCurrentAutomationEventContributionTx({
                tx, accountId: input.accountId, pluginId, eventLocalId: GITHUB_MANAGED_PUSH_EVENT_LOCAL_ID_V1,
                version: target.pluginVersion, machineId: target.materialization.machineId,
                machineInstallationId: target.machineInstallationId,
            });
            const webhookContribution = readCurrentAutomationEventDurablePushWebhookContributionV1(event);
            if (!webhookContribution) return { kind: 'result', result: polling('endpoint_unavailable') } as const;
            const contribution = await resolveCurrentPluginWebhookContributionTxV1({
                tx, accountId: input.accountId, target, contribution: webhookContribution,
            });
            if (!contribution || contribution.routingKind !== 'accountEndpoint' || contribution.verifierKind !== 'github_hmac_sha256_v1') {
                return { kind: 'result', result: polling('endpoint_unavailable') } as const;
            }
            const sourceInstanceId = `github:repository:${input.repositoryId}`;
            const ensured = await ensurePluginWebhookEndpointV1({
                tx, accountId: input.accountId, contribution, target, publicBaseUrl: input.publicBaseUrl, managed: true,
                input: { webhookContribution, targetMaterialization: target.materialization, sourceInstanceId,
                    setup: { kind: 'accountEndpointV1' }, idempotencyKey: managedGithubEndpointKey(input.repositoryId) },
            });
            const endpoint = await tx.pluginWebhookEndpoint.findUniqueOrThrow({
                where: { id: ensured.webhookEndpointId },
                select: { id: true, revision: true, routeId: true, providerRepositoryHookId: true, providerConfirmedAt: true },
            });
            const linked = await tx.automationTrigger.updateMany({
                where: { ...triggerWhere, observationTransport: 'checkpointedPull',
                    OR: [{ webhookEndpointId: null }, { webhookEndpointId: endpoint.id }] },
                data: endpoint.providerRepositoryHookId !== null && endpoint.providerConfirmedAt !== null
                    ? { webhookEndpointId: endpoint.id, observationTransport: 'durablePush', observationStartsAt: new Date(),
                        watcherMachineId: null, watcherMachineInstallationId: null, watcherMaterializationId: null, watcherPluginId: null }
                    : { webhookEndpointId: endpoint.id },
            });
            if (linked.count !== 1) throw new PluginWebhookEndpointStoreError('endpoint_unavailable');
            if (endpoint.providerRepositoryHookId !== null) {
                if (!endpoint.providerConfirmedAt) return { kind: 'result', result: { kind: 'pendingVerification' } } as const;
                await ensureAutomationEventCatalogStateTx({ tx, accountId: input.accountId, projectionChanged: true });
                return { kind: 'result', result: { kind: 'webhook' } } as const;
            }
            return { kind: 'register', endpoint, target, binding, storedDefinitionEnvelope: envelope.envelope,
                publicUrl: ensured.publicUrl } as const;
        }, { isolationLevel: 'Serializable' });
        if (admitted.kind === 'result') return admitted.result;

        // Read from the endpoint's credential owner only after it and the attachment commit.
        const [credential] = await readPluginWebhookVerificationCredentialsV1({ routeId: admitted.endpoint.routeId });
        if (!credential) return polling('endpoint_unavailable');
        const operation: Registration = {
            kind: 'register', endpointId: admitted.endpoint.id, repositoryId: input.repositoryId,
            operationId: `${admitted.endpoint.id}:register:${input.triggerId}:${input.triggerRevision}`,
            materializationId: admitted.target.materialization.materializationId,
            binding: admitted.binding, storedDefinitionEnvelope: admitted.storedDefinitionEnvelope,
            publicUrl: admitted.publicUrl, signingSecret: credential.secret,
        };
        const result = await input.forward({
            target: { accountId: input.accountId, machineId: admitted.target.materialization.machineId,
                installationId: admitted.target.machineInstallationId },
            operation,
        });
        if (result.kind === 'unavailable') return polling(result.code);
        if (result.kind !== 'registered') return polling('github_webhook_result_invalid');
        const recorded = await db.pluginWebhookEndpoint.updateMany({
            where: { id: admitted.endpoint.id, accountId: input.accountId, revision: admitted.endpoint.revision,
                enabled: true, revokedAt: null, providerRepositoryHookId: null },
            data: { providerRepositoryHookId: result.hookId },
        });
        return recorded.count === 1 ? { kind: 'pendingVerification' } : polling('github_webhook_registration_unconfirmed');
    } catch (error) {
        if (error instanceof PluginWebhookEndpointStoreError) return polling(error.code);
        // The accepted trigger survives an unavailable or inconclusive provider effect.
        return polling('github_webhook_registration_unconfirmed');
    }
}
