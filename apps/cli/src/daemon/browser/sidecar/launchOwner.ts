import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';

import type {
    BrowserProfileV1,
    BrowserSidecarErrorCodeV1,
} from '@happier-dev/protocol';

import type { SidecarBrowserBinaryResolution } from './binary';
import {
    createBrowserSidecarCdpControlAdapterFactory,
    type ConnectBrowserSidecarCdpTransport,
} from './controlAdapterFactory';
import type {
    BrowserSidecarControlAdapterFactory,
    BrowserSidecarControlAdapterFactoryResult,
} from './controlAdapter';
import {
    createSidecarProcessController,
    type SidecarProcessController,
    type SpawnSidecarProcess,
} from './process';
import {
    createSidecarLaunchPlan,
    type SidecarPrivateLaunchPlan,
} from './runtime';

export type BrowserSidecarLaunchOwnerControlAdapterFactoryInput = Readonly<{
    browserSessionId: string;
    sidecarId: string;
    featureEnabled: boolean;
    allowPersistentProfiles: boolean;
    profile: BrowserProfileV1;
    profileDirectory: string;
    binaryResolution: SidecarBrowserBinaryResolution;
    endpointTimeoutMs?: number;
    nowMs?: () => number;
    processController?: SidecarProcessController;
    spawnProcess?: SpawnSidecarProcess;
    connectTransport?: ConnectBrowserSidecarCdpTransport;
    cleanupProfileDirectory?: (profileDirectory: string) => Promise<void> | void;
}>;

function unavailable(
    errorCode: BrowserSidecarErrorCodeV1,
    disabledReason: string,
): Extract<BrowserSidecarControlAdapterFactoryResult, { ok: false }> {
    return {
        ok: false,
        errorCode,
        disabledReason,
    };
}

function defaultSpawnSidecarProcess(executablePath: string, args: readonly string[]) {
    return spawn(executablePath, [...args], {
        stdio: ['ignore', 'ignore', 'pipe'],
    });
}

async function defaultCleanupProfileDirectory(profileDirectory: string): Promise<void> {
    await rm(profileDirectory, { recursive: true, force: true });
}

async function cleanupPrivateProfile(
    input: BrowserSidecarLaunchOwnerControlAdapterFactoryInput,
    privateLaunch: SidecarPrivateLaunchPlan,
): Promise<void> {
    if (!privateLaunch.cleanupOnStop) return;
    const cleanup = input.cleanupProfileDirectory ?? defaultCleanupProfileDirectory;
    try {
        await cleanup(privateLaunch.profileDirectory);
    } catch {
        // Cleanup is best-effort during daemon shutdown/failure; never convert it into a public
        // Browser control capability or leak private profile paths through route registration.
    }
}

function createProcessController(input: BrowserSidecarLaunchOwnerControlAdapterFactoryInput): SidecarProcessController {
    if (input.processController) return input.processController;
    return createSidecarProcessController({
        nowMs: input.nowMs ?? Date.now,
        spawnProcess: input.spawnProcess ?? defaultSpawnSidecarProcess,
    });
}

export function createBrowserSidecarLaunchOwnerControlAdapterFactory(
    input: BrowserSidecarLaunchOwnerControlAdapterFactoryInput,
): BrowserSidecarControlAdapterFactory {
    const processController = createProcessController(input);

    return async (factoryInput) => {
        if (input.binaryResolution.ok && input.binaryResolution.source === 'systemChrome') {
            return unavailable(
                'system_browser_unavailable',
                'System browser launch is unavailable until a binary-safe Browser sidecar source owner is proven.',
            );
        }

        const launchPlan = createSidecarLaunchPlan({
            sidecarId: input.sidecarId,
            nowMs: input.nowMs?.() ?? Date.now(),
            featureEnabled: input.featureEnabled,
            allowPersistentProfiles: input.allowPersistentProfiles,
            profile: input.profile,
            profileDirectory: input.profileDirectory,
            binaryResolution: input.binaryResolution,
        });
        if (!launchPlan.privateLaunch) {
            const publicResult = launchPlan.publicResult;
            if (publicResult.accepted) {
                return unavailable('launch_failed', 'Browser sidecar launch plan is inconsistent.');
            }
            return unavailable(
                publicResult.errorCode,
                publicResult.disabledReason,
            );
        }

        const privateLaunch = launchPlan.privateLaunch;
        const processLaunch = processController.launch(privateLaunch);
        if (!processLaunch.ok) {
            await cleanupPrivateProfile(input, privateLaunch);
            return unavailable('launch_failed', 'Browser sidecar process could not be launched.');
        }

        const endpointSource = await processController.waitForDevToolsEndpointSource({
            sidecarId: privateLaunch.sidecarId,
            timeoutMs: input.endpointTimeoutMs,
        });
        if (!endpointSource.ok) {
            processController.stop();
            await cleanupPrivateProfile(input, privateLaunch);
            return unavailable('cdp_unavailable', 'Browser sidecar CDP endpoint is unavailable.');
        }

        const adapterFactory = createBrowserSidecarCdpControlAdapterFactory({
            browserSessionId: input.browserSessionId,
            sidecarId: privateLaunch.sidecarId,
            endpointSource: endpointSource.endpointSource,
            ...(input.connectTransport ? { connectTransport: input.connectTransport } : {}),
        });
        const adapterResult = await adapterFactory(factoryInput);
        if (!adapterResult.ok) {
            processController.stop();
            await cleanupPrivateProfile(input, privateLaunch);
            return adapterResult;
        }

        let disposed = false;
        return {
            ok: true,
            adapter: adapterResult.adapter,
            ...(adapterResult.contextCapture ? { contextCapture: adapterResult.contextCapture } : {}),
            dispose: async () => {
                if (disposed) return;
                disposed = true;
                try {
                    await adapterResult.dispose?.();
                } finally {
                    processController.stop();
                    await cleanupPrivateProfile(input, privateLaunch);
                }
            },
        };
    };
}
