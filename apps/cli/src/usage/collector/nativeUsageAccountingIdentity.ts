import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { DeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import type { NativeUsageCaptureAuthority } from './nativeUsageCaptureState';

export type NativeUsageAccountingIdentityInput = Readonly<{
    authority: NativeUsageCaptureAuthority;
    storage: DeviceLocalSecretStorage;
    agent: PluginContributionIdentityV1;
    sourceKey: string;
    nativeSessionId?: string;
    inferenceId?: string;
}>;

export function deriveNativeUsageAccountingIdentity(input: NativeUsageAccountingIdentityInput): {
    sourceRootKey: string; nativeSessionKey?: string; externalKey?: string;
} {
    const derive = (parts: readonly string[]) => input.storage.deriveOpaqueIdentity({
        purpose: 'usage_accounting_identity', value: JSON.stringify(parts),
    });
    const scope = [input.authority.serverId, input.authority.accountId, input.authority.machineId,
        input.agent.pluginId, input.agent.localId, input.sourceKey];
    const sourceRootKey = derive(['root', ...scope]);
    const nativeSessionKey = input.nativeSessionId ? derive(['session', ...scope, input.nativeSessionId]) : undefined;
    const externalKey = input.nativeSessionId && input.inferenceId
        ? derive(['inference', ...scope, input.nativeSessionId, input.inferenceId]) : undefined;
    return { sourceRootKey, ...(nativeSessionKey ? { nativeSessionKey } : {}), ...(externalKey ? { externalKey } : {}) };
}
