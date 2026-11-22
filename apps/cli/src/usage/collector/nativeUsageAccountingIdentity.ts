import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { DeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import type { NativeUsageCaptureAuthority } from './nativeUsageCaptureState';

type NativeUsageAccountingIdentityScope = Readonly<{
    authority: NativeUsageCaptureAuthority;
    storage: DeviceLocalSecretStorage;
    agent: PluginContributionIdentityV1;
}>;

export type NativeUsageAccountingIdentityInput = NativeUsageAccountingIdentityScope & Readonly<{
    sourceKey: string;
    nativeSessionId?: string;
    inferenceId?: string;
}>;

function accountingIdentityScope(input: NativeUsageAccountingIdentityScope) {
    return [input.authority.serverId, input.authority.accountId, input.authority.machineId,
        input.agent.pluginId, input.agent.localId];
}

function deriveAccountingKey(storage: DeviceLocalSecretStorage, parts: readonly string[]): string {
    return storage.deriveOpaqueIdentity({ purpose: 'usage_accounting_identity', value: JSON.stringify(parts) });
}

export function deriveNativeUsageOverlapIdentity(input: NativeUsageAccountingIdentityScope & {
    nativeSessionId: string; inferenceId?: string; observationId?: string; publication?: 'observation';
}): { nativeSessionKey: string; responseKey?: string; publicationKey?: string } {
    const scope = [...accountingIdentityScope(input), input.nativeSessionId];
    const responseKey = input.inferenceId ? deriveAccountingKey(input.storage, ['overlap-response', ...scope, input.inferenceId]) : undefined;
    return {
        nativeSessionKey: deriveAccountingKey(input.storage, ['overlap-session', ...scope]),
        ...(responseKey ? { responseKey } : {}),
        ...(input.observationId ? { publicationKey: (input.publication === 'observation' ? undefined : responseKey)
            ?? deriveAccountingKey(input.storage, ['overlap-checkpoint', ...scope, input.observationId]) } : {}),
    };
}

export function deriveNativeUsageAccountingIdentity(input: NativeUsageAccountingIdentityInput): {
    sourceRootKey: string; nativeSessionKey?: string; externalKey?: string;
} {
    const derive = (parts: readonly string[]) => deriveAccountingKey(input.storage, parts);
    const scope = [...accountingIdentityScope(input), input.sourceKey];
    const sourceRootKey = derive(['root', ...scope]);
    const nativeSessionKey = input.nativeSessionId ? derive(['session', ...scope, input.nativeSessionId]) : undefined;
    const externalKey = input.nativeSessionId && input.inferenceId
        ? derive(['inference', ...scope, input.nativeSessionId, input.inferenceId]) : undefined;
    return { sourceRootKey, ...(nativeSessionKey ? { nativeSessionKey } : {}), ...(externalKey ? { externalKey } : {}) };
}
