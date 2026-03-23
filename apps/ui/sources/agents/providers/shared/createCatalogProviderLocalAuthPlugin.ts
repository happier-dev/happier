import type { AgentId } from '@/agents/catalog/catalog';
import { getAgentLocalCliConfig, getProviderCliInstallGuideUrl, getProviderCliRuntimeSpec } from '@happier-dev/agents';

import { createStaticProviderLocalAuthPlugin } from './createStaticProviderLocalAuthPlugin';
import type { ProviderLocalAuthPlugin } from './providerLocalAuthPlugin';
import { resolveProviderLocalAuthBaseCommand } from './resolveProviderLocalAuthBaseCommand';

function buildInitialCommand(params: Readonly<{
    providerId: AgentId;
    resolvedPath?: string | null;
    resolvedCommand?: string | null;
    platform?: NodeJS.Platform | string | null;
}>): string {
    const config = getAgentLocalCliConfig(params.providerId);
    const baseCommand = resolveProviderLocalAuthBaseCommand({
        resolvedPath: params.resolvedPath,
        resolvedCommand: params.resolvedCommand,
        fallbackCommand: config.loginLaunch?.command ?? getProviderCliRuntimeSpec(params.providerId).binaryName ?? config.detectKey,
        platform: params.platform,
    });
    const args = config.loginLaunch?.args ?? [];
    return args.length > 0 ? [baseCommand, ...args].join(' ') : baseCommand;
}

export function createCatalogProviderLocalAuthPlugin(providerId: AgentId): ProviderLocalAuthPlugin {
    const config = getAgentLocalCliConfig(providerId);
    return createStaticProviderLocalAuthPlugin({
        providerId,
        support: config.authSupport,
        docsUrl: getProviderCliInstallGuideUrl(providerId) ?? undefined,
        ...(config.loginLaunch
            ? {
                buildLoginLaunch: ({ resolvedPath, resolvedCommand, platform }) => ({
                    initialCommand: buildInitialCommand({ providerId, resolvedPath, resolvedCommand, platform }),
                    ...(config.loginLaunch?.initialInput ? { initialInput: config.loginLaunch.initialInput } : {}),
                }),
            }
            : {}),
    });
}
