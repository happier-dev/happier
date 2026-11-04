import { spawn } from 'node:child_process';
import { observeProcessLaunch } from '@/processes/launchNotification';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { withProcessOwnerEnvironment } from '@/processes/ownerTag';
import { buildCgroupProcessLaunchSpec, prepareCgroupProcessLaunchScope, type LinuxProcessLaunchScope } from '../../platform/linux/buildCgroupSelfMigratingHappyCliLaunchSpec';
import { createHappierLinuxScopeName } from '../../platform/linux/systemdUserResourceGovernor';
import { BROWSER_SANDBOX_NEXT_ACTION, isAppArmorUserNamespaceRestriction } from './sandbox';
import { readProcessCensus } from '@/processes/census/processCensus';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';

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
    BrowserSidecarResourceTarget,
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
    profile: BrowserProfileV1;
    profileDirectory: string;
    extensionDirectories?: readonly string[];
    binaryResolution: SidecarBrowserBinaryResolution;
    deadlineMs?: number;
    signal?: AbortSignal;
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

function defaultSpawnSidecarProcess(executablePath: string, args: readonly string[], scope: LinuxProcessLaunchScope | null) {
    const environment = withProcessOwnerEnvironment(process.env, { kind: 'browser_sidecar' });
    const launchSpec = { filePath: executablePath, args: [...args],
        env: Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) };
    const launch = scope ? buildCgroupProcessLaunchSpec({ launchSpec, scope,
        unit: createHappierLinuxScopeName(environment.HAPPIER_PROCESS_OWNER) }) : launchSpec;
    const child = spawn(launch.filePath, launch.args, {
        env: launch.env,
        // Chromium reads descriptor 3 and writes descriptor 4; Windows receives inherited CRT handles.
        stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    });
    observeProcessLaunch(child);
    return child;
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
    await cleanup(privateLaunch.profileDirectory);
}

function createProcessController(input: BrowserSidecarLaunchOwnerControlAdapterFactoryInput, scope: () => LinuxProcessLaunchScope | null): SidecarProcessController {
    if (input.processController) return input.processController;
    return createSidecarProcessController({
        nowMs: input.nowMs ?? Date.now,
        spawnProcess: input.spawnProcess ?? ((executablePath, args) => defaultSpawnSidecarProcess(executablePath, args, scope())),
    });
}

export function createBrowserSidecarLaunchOwnerControlAdapterFactory(
    input: BrowserSidecarLaunchOwnerControlAdapterFactoryInput,
): BrowserSidecarControlAdapterFactory {
    let scope: LinuxProcessLaunchScope | null = null;
    const processController = createProcessController(input, () => scope);

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
            profile: input.profile,
            profileDirectory: input.profileDirectory,
            extensionDirectories: input.extensionDirectories,
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
        if (process.platform === 'linux' && !input.processController && !input.spawnProcess) {
            scope = await prepareCgroupProcessLaunchScope();
        }
        if (input.signal?.aborted) {
            await cleanupPrivateProfile(input, privateLaunch);
            return unavailable('launch_failed', 'Browser sidecar launch was cancelled.');
        }
        const processLaunch = processController.launch(privateLaunch);
        if (!processLaunch.ok) {
            await cleanupPrivateProfile(input, privateLaunch);
            return unavailable('launch_failed', 'Browser sidecar process could not be launched.');
        }

        const connection = processController.getCdpPipe({ sidecarId: privateLaunch.sidecarId });
        if (!connection.ok) {
            await processController.stopAndWait();
            await cleanupPrivateProfile(input, privateLaunch);
            return unavailable('cdp_unavailable', 'Browser sidecar inherited CDP pipe is unavailable on this platform.');
        }

        const adapterFactory = createBrowserSidecarCdpControlAdapterFactory({
            browserSessionId: input.browserSessionId,
            sidecarId: privateLaunch.sidecarId,
            pipe: connection.pipe,
            signal: input.signal,
            deadlineMs: input.deadlineMs,
            ...(input.connectTransport ? { connectTransport: input.connectTransport } : {}),
        });
        const adapterResult = await adapterFactory(factoryInput);
        if (!adapterResult.ok) {
            await processController.stopAndWait();
            await cleanupPrivateProfile(input, privateLaunch);
            const failure = processController.getCdpPipe({ sidecarId: privateLaunch.sidecarId });
            if (!failure.ok && failure.sandboxUnavailable && await isAppArmorUserNamespaceRestriction()) {
                return unavailable('sandbox_unavailable', `Managed Chromium sandbox is unavailable. ${BROWSER_SANDBOX_NEXT_ACTION}`);
            }
            return adapterResult;
        }

        const pid = processController.getPid?.();
        const native = pid ? await readProcessCensus({ freshness: 'shared', pids: [pid], fields: [] }) : null;
        const identity = native?.status === 'ok' ? native.rows.find(row => row.pid === pid)?.start : undefined;
        let disposal: Promise<void> | null = null;
        let activeCommands = 0;
        const ownerCreatedAtMs = input.nowMs?.() ?? Date.now();
        let lastUsedAt = ownerCreatedAtMs;
        let wayBack: BrowserSidecarResourceTarget['wayBack'];
        const runCommand = async <T>(dispatch: () => Promise<T>): Promise<T> => {
            activeCommands += 1;
            try {
                return await dispatch();
            } finally {
                activeCommands -= 1;
                lastUsedAt = input.nowMs?.() ?? Date.now();
            }
        };
        const extensions = adapterResult.extensions;
        const dispose = () => {
            disposal ??= (async () => {
                try {
                    await adapterResult.dispose?.();
                } finally {
                    await processController.stopAndWait();
                    await cleanupPrivateProfile(input, privateLaunch);
                }
            })();
            return disposal;
        };
        const readResourceTargets = (): readonly BrowserSidecarResourceTarget[] => {
            if (!pid || !identity || processController.getPid?.() !== pid || disposal) return [];
            const idle = factoryInput.readSessionIdle?.(input.browserSessionId);
            return [{ root: { owner: { kind: 'browser_sidecar' }, pid, start: identity,
                live: processController.getStatus().state === 'running', ownerCreatedAtMs, stop: dispose },
                ownerRef: input.browserSessionId,
                idle: activeCommands || processController.getStatus().state !== 'running' ? false : idle?.idle ?? null,
                settledAt: Math.max(lastUsedAt, idle?.settledAt ?? lastUsedAt), label: 'Browser',
                ...(wayBack ? { wayBack } : {}) }];
        };
        return {
            ok: true,
            isProcessAlive: () => processController.getPid ? processController.getPid() !== null : processController.getStatus().state === 'running',
            adapter: { ...adapterResult.adapter, async dispatchCommand(command, scope) {
                return runCommand(async () => {
                    const result = await adapterResult.adapter.dispatchCommand(command, scope);
                    if (command.kind === 'openView' && result.status === 'dispatched' && !wayBack) {
                        // Re-admit the original open Action with a fresh command receipt identity.
                        wayBack = [{ label: 'reopen', actionId: 'browser.view.open',
                            input: projectNativeJsonValueForTransport({ ...command, commandId: randomUUID() }) }];
                    }
                    return result;
                });
            } },
            ...(extensions ? { extensions: {
                openView: (...args: Parameters<typeof extensions.openView>) => runCommand(() => extensions.openView(...args)),
            } } : {}),
            readResourceTargets,
            readProcessRoots: () => readResourceTargets().map(target => target.root),
            ...(adapterResult.contextCapture ? { contextCapture: {
                ...adapterResult.contextCapture,
                // This exact transport uses the private inherited descriptors of
                // the process above. Only an actually headless launch proves native non-observability.
                resolveNativeObservation: (view) => !disposal && adapterResult.contextCapture?.resolvePageHandle(view)
                    ? 'not_observable' as const : undefined,
            } } : {}),
            dispose,
        };
    };
}
