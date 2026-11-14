import type { ProviderRuntimeBindingBasisV1 } from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';
import type {
    AgentProviderBindingCredential,
    AgentProviderBindingResolvedFacts,
} from '@happier-dev/plugin-sdk/agents/runtime';

import {
    materializeCapturedAgentProviderBinding,
    type CapturedAgentProviderBindingAdapter,
} from '@/plugins/runtime/providerBindings/adapter';

function fail(): never {
    throw new PluginError({
        code:
            'plugin_services_managed_provider_materialization_authority_changed',
        message:
            'Agent or managed Provider authority changed during pre-open materialization',
    });
}

export async function materializeRunnerManagedProviderAgentBinding(
    input: Readonly<{
        capturedAgentBinding: CapturedAgentProviderBindingAdapter;
        runtimeBindingBasis: ProviderRuntimeBindingBasisV1;
        model: AgentProviderBindingResolvedFacts['selection']['model'];
        endpointUrl: string;
        compatibilityFingerprint: string;
        credential: AgentProviderBindingCredential;
        isCapturedAgentRegistrationCurrent(): boolean;
        isManagedProviderCurrent(): boolean | Promise<boolean>;
        cleanup(): void | Promise<void>;
    }>,
) {
    let cleaned = false;
    const cleanupOnce = async () => {
        if (cleaned) return;
        cleaned = true;
        await input.cleanup();
    };
    const cleanupAfterFailure = async () => {
        try {
            await cleanupOnce();
        } catch {
            // Preserve the deciding materialization/authority failure.
        }
    };
    const isAuthorityCurrent = async () => {
        try {
            return input.isCapturedAgentRegistrationCurrent()
                && await input.isManagedProviderCurrent();
        } catch {
            return false;
        }
    };
    if (!await isAuthorityCurrent()) {
        await cleanupAfterFailure();
        return fail();
    }
    let materialization;
    try {
        materialization = await materializeCapturedAgentProviderBinding({
            resolved: input.capturedAgentBinding,
            binding: {
                v: 1,
                agentTargetKey: input.runtimeBindingBasis.agentTargetKey,
                selection: { connectionId: input.runtimeBindingBasis.connectionId, model: input.model },
                contributionKey: input.runtimeBindingBasis.contributionKey,
                endpoint: { ...input.runtimeBindingBasis.endpoint, normalizedUrl: input.endpointUrl },
                runtimeCredentialTransport: input.runtimeBindingBasis.runtimeCredentialTransport,
                ...(input.runtimeBindingBasis.roleModels !== undefined ? { roleModels: input.runtimeBindingBasis.roleModels } : {}),
                compatibilityFingerprint: input.compatibilityFingerprint,
            },
            prepared: input.runtimeBindingBasis.prepared,
            credential: input.credential,
        });
    } catch (error) {
        await cleanupAfterFailure();
        throw error;
    }
    if (!await isAuthorityCurrent()) {
        await cleanupAfterFailure();
        return fail();
    }
    return materialization;
}
