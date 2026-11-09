import { AgentLaunchEnvironmentV1Schema } from '@happier-dev/protocol/runtime/agentSessionV1';
import type { AgentLaunchEnvironment } from '@happier-dev/plugin-sdk/agents/runtime';

import { buildScopedProcessEnv, normalizeUnsetEnvKeys } from '@/utils/processEnv/buildScopedProcessEnv';
import { selectToolIdleTimeoutEnvironment } from '@/processes/toolIdleTimeouts';
import { isWindowsSystemEnvKey } from '@/utils/processEnv/environmentKeys';

/** Preserve command lookup, host TLS trust and captured tool policy without ambient credentials or controls. */
export function resolveNativeAgentLaunchEnvironment(input: Readonly<{
    processEnv: Readonly<NodeJS.ProcessEnv>;
    environmentVariables?: Readonly<Record<string, string>>;
    unsetEnvironmentVariables?: readonly string[];
    platform?: NodeJS.Platform;
}>): AgentLaunchEnvironment {
    const platform = input.platform ?? process.platform;
    const inheritedEnvironment = Object.fromEntries(Object.entries(input.processEnv).filter(([key]) => {
        const name = platform === 'win32' ? key.toUpperCase() : key;
        return name === 'PATH' || name === 'NODE_EXTRA_CA_CERTS' || isWindowsSystemEnvKey(key, platform);
    }));
    const unset = normalizeUnsetEnvKeys(input.unsetEnvironmentVariables, platform);
    return AgentLaunchEnvironmentV1Schema.parse({
        values: buildScopedProcessEnv({
            baseEnv: { ...inheritedEnvironment, ...selectToolIdleTimeoutEnvironment(input.processEnv, platform) },
            explicitEnv: input.environmentVariables,
            unsetEnvKeys: unset,
            platform,
        }),
        unset,
    });
}
