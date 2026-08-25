import { getBrowserChromiumArchiveDownloadInstallableAdapter } from '@/packagedRuntime/installables/sourceAdapters/browserChromium';
import type { BrowserAutomationRuntimeProvisionOutcome } from '../actions/runtimeActionExecutor';
import { resolveManagedBrowserSidecarCandidate } from './source';
import type { InstallManagedBrowserChromiumFn } from './productSource';

/**
 * Dispatch-time provisioning for the managed browser runtime (user ruling, 2026-08-23).
 *
 * The managed Chrome-for-Testing artifact is a ~150MB third-party download, and it is the only way
 * the daemon can ever serve `browser.automation.*`. Where that download is triggered is a product
 * decision, not an implementation detail:
 *
 * - NOT at daemon startup. `browser.sidecar` is default-ALLOW and the startup route refresh runs on
 *   every daemon, so a startup fetch would be a silent cost on machines that never touch a browser.
 *   The startup gate therefore passes `autoInstallWhenMissing: false`.
 * - NOT never. That would leave the daemon automation path permanently dark, since
 *   `getArchiveDownloadInstallableAdapter` has no other caller — there is no user-initiated install.
 * - On the first automation dispatch. The download becomes a legible consequence of an agent asking
 *   for automation.
 *
 * This owner is deliberately thin: one single-flight guard and one memo. It is NOT a retry budget,
 * backoff, or circuit breaker — nothing here ever retries on its own. A failed install is reported
 * to the caller once; a later dispatch is a fresh human/agent request, and that request is the only
 * thing that starts another attempt.
 */
export type BrowserAutomationRuntimeProvisioner = Readonly<{
    provision: () => Promise<BrowserAutomationRuntimeProvisionOutcome>;
}>;

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
    let inFlight: Promise<void> | null = null;
    // The outcome the run that owns the slot decided, so joiners get that exact answer rather than
    // an optimistic guess.
    let pendingDecision: Promise<BrowserAutomationRuntimeProvisionOutcome> | null = null;
    // One-shot report of a terminal failure, so a download that failed surfaces as a distinguishable
    // reason instead of silently starting again. Reading it clears it: the next dispatch after the
    // caller has been told is a fresh request, not an automatic retry.
    let unreportedFailure = false;

    return {
        async provision() {
            if (inFlight && pendingDecision) return await pendingDecision;
            if (unreportedFailure) {
                unreportedFailure = false;
                return 'failed';
            }

            let settle: (outcome: BrowserAutomationRuntimeProvisionOutcome) => void = () => {};
            pendingDecision = new Promise<BrowserAutomationRuntimeProvisionOutcome>((resolve) => {
                settle = resolve;
            });

            inFlight = (async () => {
                let candidate: Awaited<ReturnType<typeof resolveCandidate>>;
                try {
                    candidate = await resolveCandidate({ platform, arch });
                } catch (error) {
                    input.onError?.(error);
                    settle('unavailable');
                    return;
                }
                // `null` = unsupported platform or an asset with no verifiable digest — nothing to
                // provision, ever. `available: true` = the artifact is already on disk, so a missing
                // route is a launch problem, not a provisioning problem. Both keep the pre-existing
                // honest answer rather than promising an install that will not help.
                if (!candidate || candidate.available !== false) {
                    settle('unavailable');
                    return;
                }

                // Past this point a download is genuinely running, so callers are told so and the
                // dispatch returns immediately rather than blocking on ~150MB.
                settle('provisioning');
                try {
                    const result = await install({ platform, arch });
                    if (!result.ok) {
                        unreportedFailure = true;
                        // The install adapter reports a refusal as a RESULT, not a throw (bad digest,
                        // HTTP failure, a rejected archive entry). Without this the only trace of a
                        // ~150MB download that failed was a later dispatch answering 'failed' with no
                        // cause anywhere — the reason never reached the daemon log.
                        input.onError?.(new Error(
                            `[browser] managed Chromium provisioning failed: ${result.errorMessage}`,
                        ));
                        return;
                    }
                    // The artifact is on disk now; rebuild the route owners so the NEXT dispatch
                    // finds a live automation route. Route owners are resolved per dispatch, so no
                    // daemon restart is needed.
                    await input.refreshRouteOwners();
                } catch (error) {
                    unreportedFailure = true;
                    input.onError?.(error);
                }
            })().finally(() => {
                inFlight = null;
                pendingDecision = null;
            });

            return await pendingDecision;
        },
    };
}
