import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { DaemonPluginStructuredMessageActionExecuteResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createTargetActionHostBindingResolver } from '@/plugins/runtime/hostAccess/resolve';
import { createManagedPluginSourceCustody } from '@/plugins/runtime/lifecycle/contributions/runtimeIdentity.testkit';
import { createUnavailablePluginServicesFactory } from '@/plugins/runtime/invocation/services/factory';
import { createTargetActionInvocationRegistry, type TargetActionInvocationRegistration } from '@/plugins/runtime/invocation/targetActionRegistry';
import type { PluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';

/** Machine RPC endpoint for Account-host tests that compose the real Session admission and target registry. */
export function createSessionReadSetMachineFixture(input: Readonly<{
    manifest: unknown;
    localId: string;
    occurrenceId: string;
    serverId: string;
    resolveSessionReference: NonNullable<ActionExecutorDeps['resolveSessionReference']>;
    handler: TargetActionInvocationRegistration['handler'];
}>) {
    const manifest = normalizePluginManifestV2(input.manifest);
    const definition = manifest.contributes.actions.find(action => action.id === input.localId);
    if (!definition) throw new Error('Expected a declared Machine Action');
    const occurrenceId = input.occurrenceId as PluginRuntimeOccurrenceId;
    const executor = createActionExecutor({
        ...createUnavailableActionTransportDeps(),
        resolveSessionReference: input.resolveSessionReference,
    });
    const registry = createTargetActionInvocationRegistry({
        readMachineLocalDatabaseAgentLevel: async () => undefined,
        actions: [{ pluginId: manifest.id, pluginVersion: manifest.version, localId: definition.id, occurrenceId,
            sourceCustody: createManagedPluginSourceCustody('read-set-generation'), definition, handler: input.handler }],
        admitContributedSessionReadSet: executor.admitContributedSessionReadSet,
        createServices: createUnavailablePluginServicesFactory(),
        resolveHostBinding: createTargetActionHostBindingResolver(),
        readCurrentPluginOccurrenceId: () => occurrenceId,
        resolveAuthorizationFacts: action => ({ generation: { targetGeneration: action.occurrenceId,
            desiredGeneration: action.occurrenceId, appliedGeneration: action.occurrenceId },
            resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [] }),
    });
    return async (value: unknown) => {
        const result = await registry.invoke({ pluginId: manifest.id, localId: definition.id,
            surface: 'plugin', input: value,
            approvalContext: { serverId: input.serverId, authority: 'account_automation' } });
        if (result.status !== 'executed') throw new Error(`Session read-set Machine fixture settled as ${result.status}`);
        return DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({ ok: true, result: result.value });
    };
}
