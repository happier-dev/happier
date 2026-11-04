import { getBrowserChromiumArchiveDownloadInstallableAdapter, type ArchiveDownloadInstallResult } from '@/packagedRuntime/installables/sourceAdapters/browserChromium';
import type { BrowserAutomationRuntimeProvisionOutcome, ProvisionBrowserAutomationRuntime } from '../actions/runtimeActionExecutor';
import { resolveManagedBrowserSidecarCandidate } from './source';

/**
 * Dispatch-time provisioning for the managed browser runtime (user ruling, 2026-08-23).
 *
 * The managed Chrome-for-Testing artifact is a ~150MB third-party download, and it is the only way
 * the daemon can ever serve `browser.automation.*`. Where that download is triggered is a product
 * decision, not an implementation detail:
 *
 * - NOT at daemon startup. `browser.sidecar` is default-ALLOW and the startup route refresh runs on
 *   every daemon, so a startup fetch would be a silent cost on machines that never touch a browser.
 *   The startup factory only resolves already-installed artifacts.
 * - NOT never. That would leave the daemon automation path permanently dark, since
 *   `getArchiveDownloadInstallableAdapter` has no other caller — there is no user-initiated install.
 * - On the first explicit Browser open or daemon automation dispatch. The download
 *   becomes a consequence of the admitted Browser request.
 *
 * Concurrent dispatches share installation and route refresh. Each original
 * dispatch awaits their terminal outcome; only a fresh request can retry failure.
 */
export type BrowserAutomationRuntimeProvisioner = Readonly<{
    provision: ProvisionBrowserAutomationRuntime;
}>;

type InstallManagedBrowserChromiumFn = (params: Readonly<{
    platform?: NodeJS.Platform | string;
    arch?: string;
}>) => Promise<ArchiveDownloadInstallResult>;

export function createBrowserAutomationRuntimeProvisioner(input: Readonly<{
    /** Rebuild the daemon browser route owners once an install lands. */
    refreshRouteOwners: () => Promise<void>;
    platform?: NodeJS.Platform | string;
    arch?: string;
    resolveManagedCandidate?: typeof resolveManagedBrowserSidecarCandidate;
    installManagedBrowserChromium?: InstallManagedBrowserChromiumFn;
    onError?: (error: unknown) => void;
}>): BrowserAutomationRuntimeProvisioner {
    const resolveCandidate = input.resolveManagedCandidate ?? resolveManagedBrowserSidecarCandidate;
    const install = input.installManagedBrowserChromium
        ?? ((params) => getBrowserChromiumArchiveDownloadInstallableAdapter().installOrUpgrade(params));
    const platform = input.platform ?? process.platform;
    const arch = input.arch ?? process.arch;

    // Single-flight: concurrent dispatches join the in-flight install instead of starting a second
    // ~150MB download. The slot is claimed SYNCHRONOUSLY — assigning it after an `await` lets every
    // concurrent caller past the check and starts one download each, which a test caught.
    let inFlight: Readonly<{
        started: Promise<boolean>;
        completion: Promise<BrowserAutomationRuntimeProvisionOutcome>;
    }> | null = null;

    return {
        async provision(options) {
            if (!inFlight) {
                let started!: (running: boolean) => void;
                const starting = new Promise<boolean>(resolve => { started = resolve; });
                const completion = (async (): Promise<BrowserAutomationRuntimeProvisionOutcome> => {
                    let candidate: Awaited<ReturnType<typeof resolveCandidate>>;
                    try {
                        candidate = await resolveCandidate({ platform, arch });
                    } catch (error) {
                        input.onError?.(error);
                        started(false);
                        return 'unavailable';
                    }
                    // An installed artifact with no route is a launch problem; an
                    // unsupported/unpinned platform cannot be provisioned.
                    if (!candidate || candidate.available !== false) {
                        started(false);
                        return 'unavailable';
                    }
                    started(true);
                    try {
                        const result = await install({ platform, arch });
                        if (!result.ok) {
                            input.onError?.(new Error(
                                `[browser] managed Chromium provisioning failed: ${result.errorMessage}`,
                            ));
                            return 'failed';
                        }
                        // Refresh before releasing the original dispatch to re-read its route.
                        await input.refreshRouteOwners();
                        return 'ready';
                    } catch (error) {
                        input.onError?.(error);
                        return 'failed';
                    }
                })().finally(() => { inFlight = null; });
                inFlight = { started: starting, completion };
            }
            const flight = inFlight;
            if (await flight.started) options?.onProvisioning?.();
            return await flight.completion;
        },
    };
}
