import type { PluginContributionClientPlatform } from '@happier-dev/protocol/plugins/contributions/catalog';

import {
    getPluginUiClientExecutableComposition,
} from '@/components/plugins/reactNative/clientExecutableContributions';
import {
    reconcileProjectedPluginUiClientExecutables,
    retainProjectedPluginUiClientExecutables,
    type PluginUiClientExecutableReconciliationAttempt,
} from '@/components/plugins/reactNative/clientExecutableActivation';
import {
    getInstalledPluginUiExecutableModuleHost,
    type PluginUiExecutableModuleHost,
} from '@/components/plugins/reactNative/executableModuleHost';
import type { PluginReactNativeLoaderBackend } from '@/components/plugins/reactNative/loader';
import type { PluginUiClientExecutableProjectionSource } from '@/components/plugins/reactNative/clientExecutableProjection';
import type { PluginSurfaceDestinationNavigationBinding } from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import type { PluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
    createProjectedExternalVoiceProviderDerivedScopeFactory,
    withdrawProjectedExternalVoiceProviders,
} from '@/voice/registry/projectedExternalVoiceProviderActivation';
import { createAppShellPluginUiInvocationHost } from './pluginUiInvocationHost';

type AppShellVoiceExecutableProjection = Readonly<{
    projection: PluginUiProjectionModel;
    machineId: string;
    serverId: string | null;
    providerIds: ReadonlySet<string>;
}>;

export function retainAppShellProjectedClientExecutables(input: Readonly<{
    projection: PluginUiProjectionModel | null;
    mountedActionProjections?: readonly PluginUiClientExecutableProjectionSource[];
    voice: AppShellVoiceExecutableProjection | null;
    platform: PluginContributionClientPlatform;
    accountLifetime?: ActiveServerAccountScopeLifetime | null;
}>): Promise<void> {
    return retainProjectedPluginUiClientExecutables({
        actionProjection: input.projection ? { projection: input.projection } : null,
        mountedActionProjections: input.mountedActionProjections,
        voiceProjection: input.voice ? { projection: input.voice.projection, directMachineAuthority: {
            machineId: input.voice.machineId, serverId: input.voice.serverId,
        } } : null,
        voiceProviderIds: input.voice?.providerIds,
        platform: input.platform, accountLifetime: input.accountLifetime,
    });
}

/**
 * AppShell publishes the complete admitted set before independent target
 * preparation. The existing composition fences superseded target adoption.
 */
export async function reconcileAppShellProjectedClientExecutables(input: Readonly<{
    projection: PluginUiProjectionModel | null;
    mountedActionProjections?: readonly PluginUiClientExecutableProjectionSource[];
    platform: PluginContributionClientPlatform;
    voice: AppShellVoiceExecutableProjection | null;
    /** Current daemon Voice catalog even when interaction/runtime activation is unavailable. */
    voiceProviderProjection?: PluginUiProjectionModel | null;
    reader?: PluginAccountAvailabilityReader | null;
    accountLifetime?: ActiveServerAccountScopeLifetime | null;
    /** The existing AppShell destination binding; it remains the navigation owner. */
    readNavigationBinding?: () => PluginSurfaceDestinationNavigationBinding | null | undefined;
    executableHost?: PluginUiExecutableModuleHost;
    loaderBackend?: PluginReactNativeLoaderBackend;
    isCurrent?: () => boolean;
}>): Promise<readonly PluginUiClientExecutableReconciliationAttempt[]> {
    const executableHost = input.executableHost ?? getInstalledPluginUiExecutableModuleHost();
    const createDerivedScope = createProjectedExternalVoiceProviderDerivedScopeFactory({
        projection: input.voiceProviderProjection ?? input.voice?.projection ?? null,
        hostPlatform: input.platform,
        executableHost,
        actionProjection: input.projection,
        readNavigationBinding: input.readNavigationBinding,
        isCurrent: input.isCurrent,
        createInvocationUi: createAppShellPluginUiInvocationHost,
    });
    return await reconcileProjectedPluginUiClientExecutables({
        mountedActionProjections: input.mountedActionProjections,
        actionProjection: input.projection
            ? Object.freeze({ projection: input.projection })
            : null,
        voiceProjection: input.voice
            ? Object.freeze({
                projection: input.voice.projection,
                directMachineAuthority: Object.freeze({
                    machineId: input.voice.machineId,
                    serverId: input.voice.serverId,
                }),
            })
            : null,
        voiceProviderIds: input.voice?.providerIds,
        platform: input.platform,
        executableHost,
        loaderBackend: input.loaderBackend,
        reader: input.reader,
        accountLifetime: input.accountLifetime,
        isCurrent: input.isCurrent,
        retainCommittedActivation: true,
        createDerivedScope,
    });
}

/** AppShell unmount/account handoff fences every exact-authority host leaf. */
export async function unloadAppShellProjectedClientExecutables(
    executableHost: PluginUiExecutableModuleHost = getInstalledPluginUiExecutableModuleHost(),
): Promise<void> {
    await Promise.all([
        withdrawProjectedExternalVoiceProviders(executableHost),
        getPluginUiClientExecutableComposition(executableHost).unload(),
    ]);
}
