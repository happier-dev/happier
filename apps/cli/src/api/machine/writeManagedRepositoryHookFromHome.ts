import { SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS } from '@happier-dev/protocol/rpc';
import { AutomationEventTriggerDefinitionStoredPayloadV1Schema } from '@happier-dev/protocol/automations/automationEventV1';
import { openAutomationTriggerDefinitionStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import {
    MANAGED_PLUGIN_WEBHOOK_DAEMON_RPC_METHOD_V1,
    type ManagedPluginWebhookRequestV1,
    type ManagedPluginWebhookResultV1,
} from '@happier-dev/protocol/plugins/webhooks/managedRepositoryWebhookRpcV1';
import { GITHUB_EVENT_SETUP_ACTIONS_V1 } from '@happier-dev/protocol/automations/event-setup-result';
import {
    GITHUB_AUTOMATION_EVENT_LOCAL_IDS,
    readGithubManagedRepositoryHookSource,
} from '@happier-dev/plugins-scm-github';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import {
    isAvailableE2eeAutomationAccountEncryptionV1,
    resolveAutomationWorkerAccountEncryption,
} from '@/plugins/runtime/automations/automationAccountCurrentness';
import { acquireExecutableAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type { StoredCredentials } from '@/persistence';

const unavailable = { kind: 'unavailable', code: 'target_unavailable' } as const;

/** Only the admitted Home socket can reach this handler, including on an E2EE Account. */
export function registerManagedRepositoryHookFromHome(input: Readonly<{
    rpc: RpcHandlerRegistrar;
    readCredentials(): Promise<StoredCredentials | null>;
}>) {
    input.rpc.registerHandler<ManagedPluginWebhookRequestV1, ManagedPluginWebhookResultV1>(
        MANAGED_PLUGIN_WEBHOOK_DAEMON_RPC_METHOD_V1,
        async (request, context) => {
            if (context?.authorization?.kind !== SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.MANAGED_PLUGIN_WEBHOOK_SERVER_ORIGIN) return unavailable;
            const { signal } = context;
            const { binding, storedDefinitionEnvelope } = request;
            if (binding.triggerKind !== 'pluginEvent'
                || binding.eventRef.pluginId !== GITHUB_EVENT_SETUP_ACTIONS_V1.pluginId
                || binding.eventRef.localId !== GITHUB_AUTOMATION_EVENT_LOCAL_IDS.push) return unavailable;
            try {
                const credentials = await input.readCredentials();
                if (!credentials) return unavailable;
                const encryption = await resolveAutomationWorkerAccountEncryption({ token: credentials.token, credentials, signal });
                if (encryption.kind !== 'available') return unavailable;
                const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({
                    mode: encryption.witness.mode,
                    binding,
                    envelope: storedDefinitionEnvelope,
                    ...(isAvailableE2eeAutomationAccountEncryptionV1(encryption)
                        ? { material: encryption.material.material } : {}),
                });
                if (opened.kind !== 'available') return unavailable;
                const definition = createStoredReadSchema(AutomationEventTriggerDefinitionStoredPayloadV1Schema).safeParse(opened.definition);
                if (!definition.success) return unavailable;
                const source = readGithubManagedRepositoryHookSource(definition.data.sourceInstanceId, definition.data.sourceConfig);
                if (!source || source.repositoryId !== request.repositoryId) return unavailable;
                const lease = await acquireExecutableAuthoritativePluginRuntimeRegistryLease({ signal });
                try {
                    return await lease.registry.targetActionInvocations.writeManagedGithubRepositoryHook({
                        request, source, machineId: context.authorization.machineId, signal,
                    });
                } finally {
                    await lease.release();
                }
            } catch {
                // Errors from the writer may have seen verifier bytes. Only typed statuses return.
                return unavailable;
            }
        },
    );
}
