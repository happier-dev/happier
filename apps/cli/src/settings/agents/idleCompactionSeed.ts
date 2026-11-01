import {
    readAccountSettingValueForBackendTarget,
    resolveIdleCompactionPreference,
    type IdleCompactionPreference,
} from '@happier-dev/protocol/account/settings/accountSettings';
import type { BackendTargetRefV2Input } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { AgentSessionCompactionIdleCapability } from '@happier-dev/protocol/plugins/agents';
import type { AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';

/** Capture the existing startup snapshot once; running Sessions never watch Account preferences. */
export function resolveSessionIdleCompactionSeed(input: Readonly<{
    accountSettings: unknown;
    backendTarget: BackendTargetRefV2Input;
    idle?: AgentSessionCompactionIdleCapability | null;
}>): IdleCompactionPreference | undefined {
    if (!input.idle) return undefined;
    const enabled = readAccountSettingValueForBackendTarget(input.accountSettings, 'sessionIdleCompactionEnabledByTargetKey', input.backendTarget);
    const minContextTokens = readAccountSettingValueForBackendTarget(input.accountSettings, 'sessionIdleCompactionMinContextTokensByTargetKey', input.backendTarget);
    const cacheWindowOverrideMs = readAccountSettingValueForBackendTarget(input.accountSettings, 'sessionIdleCompactionCacheWindowOverrideMsByTargetKey', input.backendTarget);
    return Object.freeze(resolveIdleCompactionPreference({ idle: input.idle,
        ...(typeof enabled === 'boolean' ? { enabled } : {}),
        ...(typeof minContextTokens === 'number' ? { minContextTokens } : {}),
        ...(typeof cacheWindowOverrideMs === 'number' ? { cacheWindowOverrideMs } : {}),
    }));
}

export function nativeIdleCompactionOpenPreference(
    idle: AgentSessionCompactionIdleCapability | null | undefined,
    preference: IdleCompactionPreference | undefined,
): AgentSessionOpenRequest['idleCompaction'] {
    if (idle?.mode !== 'native' || !preference) return undefined;
    return Object.freeze({ enabled: preference.enabled,
        ...(idle.nativeHonorsMinimum && preference.minContextTokens !== undefined
            ? { minContextTokens: preference.minContextTokens } : {}),
    });
}
