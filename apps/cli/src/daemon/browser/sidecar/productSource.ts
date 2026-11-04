import { createHash } from 'node:crypto';

import type {
    BrowserCommandV1,
    BrowserEventV1,
    BrowserSidecarErrorCodeV1,
} from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { invalidateProcessLaunchDiscovery } from '@/processes/launchNotification';
import type { MachineResourcesPolicyReader } from '@/processes/toolIdleTimeouts';
import { browserCommandDispatchFailure } from '../control/types';
import { createBrowserProfileStore, type BrowserProfileStore } from '../profiles/store';
import { createBrowserStoragePartitionOwner } from '../storage/partitions';
import { resolveProductBrowserSidecarBinary } from './binary';
import type {
    BrowserSidecarControlAdapterFactory,
    BrowserSidecarControlAdapterFactoryResult,
    BrowserSidecarCdpEventSubscriber,
    BrowserSidecarViewLifecycleSubscriber,
    BrowserSidecarCdpPageHandle,
    BrowserSidecarCdpCommandScope,
} from './controlAdapter';
import {
    createBrowserSidecarLaunchOwnerControlAdapterFactory,
    type BrowserSidecarLaunchOwnerControlAdapterFactoryInput,
} from './launchOwner';
import { resolveManagedBrowserSidecarCandidate } from './source';
import {
    getBrowserChromiumArchiveDownloadInstallableAdapter,
    type ArchiveDownloadInstallResult,
} from '@/packagedRuntime/installables/sourceAdapters/browserChromium';

const PRODUCT_SOURCE_MISSING_REASON = 'No source-backed managed or packaged Browser sidecar executable is registered.';

type CreateLaunchOwnerFactory = (
    input: BrowserSidecarLaunchOwnerControlAdapterFactoryInput,
) => BrowserSidecarControlAdapterFactory;

/**
 * Lazy-install trigger seam (MCH-2). The managed browser-chromium source is a per-platform archive
 * fetched on first demand. When `resolveManagedBrowserSidecarCandidate` reports a supported,
 * digest-pinned platform whose artifact is not yet on disk (`available:false`), we run the
 * archive-download adapter once, then let the caller re-resolve. Injectable so the gate stays
 * unit-testable without touching the network.
 */
export type InstallManagedBrowserChromiumFn = (params: Readonly<{
    platform?: NodeJS.Platform | string;
    arch?: string;
}>) => Promise<ArchiveDownloadInstallResult>;

function defaultInstallManagedBrowserChromium(): InstallManagedBrowserChromiumFn {
    const adapter = getBrowserChromiumArchiveDownloadInstallableAdapter();
    return (params) => adapter.installOrUpgrade(params);
}

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

/**
 * The product browser-source gate (BRW-7 / FP-BRW-SOURCE-1). It flips OPEN only for a managed,
 * provenance-verified Chrome-for-Testing candidate resolved by `source.ts`, then delegates to the
 * real launch-owner chain on first open for each Happier session. Each session's isolated
 * profile is registered with the daemon's storage owner before its process starts.
 */
export function createProductBrowserSidecarControlAdapterFactory(params: Readonly<{
    platform?: NodeJS.Platform | string;
    arch?: string;
    // The resolved `browser.sidecar` server feature decision, threaded from the daemon startup
    // gate. The source rejects disabled sessions before constructing a launch owner.
    featureEnabled: boolean;
    resolveManagedCandidate?: typeof resolveManagedBrowserSidecarCandidate;
    createLaunchOwnerFactory?: CreateLaunchOwnerFactory;
    // Lazy-install trigger (MCH-2). When `false`, a missing artifact stays fail-closed instead of
    // fetching on demand (used to preserve the existing strict-resolution behavior in tests/QA).
    autoInstallWhenMissing?: boolean;
    installManagedBrowserChromium?: InstallManagedBrowserChromiumFn;
    profileStore?: BrowserProfileStore;
    readMachineResourcesPolicy?: MachineResourcesPolicyReader;
}>): BrowserSidecarControlAdapterFactory {
    const resolveCandidate = params.resolveManagedCandidate ?? resolveManagedBrowserSidecarCandidate;
    const createLaunchOwner = params.createLaunchOwnerFactory
        ?? createBrowserSidecarLaunchOwnerControlAdapterFactory;
    const autoInstallWhenMissing = params.autoInstallWhenMissing ?? true;
    const installManagedBrowserChromium = params.installManagedBrowserChromium
        ?? defaultInstallManagedBrowserChromium();
    const platform = params.platform ?? process.platform;
    const arch = params.arch ?? process.arch;

    return async (factoryInput) => {
        let candidate = await resolveCandidate({ platform, arch });

        // Lazy-install seam: a supported, digest-pinned platform whose artifact is not yet installed
        // surfaces as `available:false` (NOT null). Trigger the archive-download adapter once, then
        // re-resolve so the freshly-installed binary can promote to a real candidate.
        if (autoInstallWhenMissing && candidate && candidate.available === false) {
            const installResult = await installManagedBrowserChromium({ platform, arch });
            if (installResult.ok) {
                candidate = await resolveCandidate({ platform, arch });
            }
        }

        if (!candidate) {
            return unavailable('managed_package_missing', PRODUCT_SOURCE_MISSING_REASON);
        }

        const binaryResolution = resolveProductBrowserSidecarBinary({
            platform,
            candidates: [candidate],
        });
        if (!binaryResolution.ok) {
            return unavailable(binaryResolution.errorCode, binaryResolution.disabledReason);
        }

        if (!params.featureEnabled) return unavailable('feature_disabled', 'browser.sidecar feature disabled');
        const profileStore = params.profileStore ?? createBrowserProfileStore({
            storageRootDirectory: configuration.happyHomeDir,
            partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: configuration.happyHomeDir }),
        });
        type Launched = Extract<BrowserSidecarControlAdapterFactoryResult, { ok: true }>;
        type SessionLaunch = { promise: Promise<BrowserSidecarControlAdapterFactoryResult>; result?: Launched; closing: boolean; pendingCommands: number };
        const sessions = new Map<string, SessionLaunch>();
        const eventListeners = new Set<BrowserSidecarCdpEventSubscriber>();
        const viewListeners = new Set<BrowserSidecarViewLifecycleSubscriber>();
        const browserEventListeners = new Set<(event: BrowserEventV1) => void>();
        let disposal: Promise<void> | null = null;

        const profileIdForSession = (sessionId: string): string =>
            `browser_session_${createHash('sha256').update(sessionId).digest('hex')}`;
        function emit<T>(listeners: ReadonlySet<(event: T) => void>, event: T): void {
            for (const listener of listeners) {
                try { listener(event); } catch { /* Observers cannot break browser control. */ }
            }
        }
        // CDP ids are connection-local. Namespace handles/events while multiplexing, then unwrap
        // only at the matching connection. The sidecar adapter remains the sole view-binding owner.
        function handleForSession(sessionId: string, handle: BrowserSidecarCdpPageHandle): BrowserSidecarCdpPageHandle {
            return {
                targetId: JSON.stringify([sessionId, handle.targetId]),
                ...(handle.sessionId ? { sessionId: JSON.stringify([sessionId, handle.sessionId]) } : {}),
            };
        }
        function resolvePageHandle(view: Readonly<{ browserSessionId: string; viewId: string }>): BrowserSidecarCdpPageHandle | null {
            const session = sessions.get(view.browserSessionId);
            const handle = !session?.closing ? session?.result?.contextCapture?.resolvePageHandle(view) : null;
            return handle ? handleForSession(view.browserSessionId, handle) : null;
        }
        async function launchSession(sessionId: string, scope?: BrowserSidecarCdpCommandScope): Promise<BrowserSidecarControlAdapterFactoryResult> {
            const existing = sessions.get(sessionId);
            if (existing) return existing.promise;
            const profileId = profileIdForSession(sessionId);
            if (profileStore.getProfile(profileId)?.lifecycleState === 'unusable') {
                return unavailable('launch_failed', 'Browser session profile is unusable after a failed purge.');
            }
            let session: SessionLaunch;
            const cancellation = new AbortController();
            const cancelLaunch = () => cancellation.abort();
            if (scope?.signal?.aborted || (scope?.deadlineMs !== undefined && scope.deadlineMs <= Date.now())) cancelLaunch();
            else scope?.signal?.addEventListener('abort', cancelLaunch, { once: true });
            const profile = profileStore.register({
                profileId, storageMode: 'ephemeral', owner: { kind: 'session', id: sessionId },
                cleanupOnSessionClose: true,
                beforePurge: async () => {
                    session.closing = true;
                    cancellation.abort();
                    const result = await session.promise;
                    try {
                        if (result.ok) await result.dispose?.();
                    } catch (error) {
                        // A failed CDP cleanup keeps the profile unusable, but an
                        // observed child exit must still release its memory slot.
                        if (result.ok && result.isProcessAlive?.() === false) sessions.delete(sessionId);
                        throw error;
                    }
                    sessions.delete(sessionId);
                },
            });
            const promise = Promise.resolve().then(async () => {
                const remainingDeadlineMs = scope?.deadlineMs === undefined ? undefined : scope.deadlineMs - Date.now();
                if (remainingDeadlineMs !== undefined && remainingDeadlineMs <= 0) cancelLaunch();
                const result = await createLaunchOwner({
                    browserSessionId: sessionId,
                    sidecarId: profileId,
                    profile,
                    profileDirectory: profileStore.resolveProfileDirectory(profileId),
                    binaryResolution,
                    signal: cancellation.signal,
                    ...(scope?.deadlineMs !== undefined ? { deadlineMs: scope.deadlineMs } : {}),
                    // Registered profile lifecycle owns deletion, after dispose has settled CDP
                    // and the process. Never delete these same bytes through a second owner.
                    cleanupProfileDirectory: () => {},
                })(factoryInput);
                if (result.ok) {
                    session.result = result;
                    invalidateProcessLaunchDiscovery();
                    result.contextCapture?.subscribeCdpEvents?.((notification) => emit(eventListeners, {
                        ...notification,
                        ...(notification.sessionId ? { sessionId: JSON.stringify([sessionId, notification.sessionId]) } : {}),
                    }));
                    result.contextCapture?.subscribeViewLifecycle?.((event) => emit(viewListeners, event));
                    result.contextCapture?.subscribeBrowserEvents?.((event) => emit(browserEventListeners, event));
                }
                return result;
            }).finally(() => scope?.signal?.removeEventListener('abort', cancelLaunch));
            session = { promise, closing: false, pendingCommands: 0 };
            sessions.set(sessionId, session);
            return promise;
        }
        function failed(command: BrowserCommandV1, message: string, code: 'adapter_unavailable' | 'sandbox_unavailable' = 'adapter_unavailable') {
            return browserCommandDispatchFailure({ commandId: command.commandId, adapterKind: 'chromiumSidecar', code, message });
        }
        const readResourceTargets = () => [...sessions.entries()].flatMap(([sessionId, session]) => {
                if (session.closing || disposal) return [];
                return (session.result?.readResourceTargets?.() ?? []).map(target => ({ ...target,
                    root: { ...target.root, stop: async () => {
                        if (sessions.get(sessionId) !== session || session.closing) throw new Error('Browser session is no longer current.');
                        const outcome = await profileStore.purgeForRuntimeStopped({ profileIds: [profileIdForSession(sessionId)] });
                        if (outcome.failedProfileIds.length) throw new Error('Browser session profile purge failed.');
                    } },
                }));
            });
        return {
            ok: true,
            readResourceTargets,
            readProcessRoots: () => readResourceTargets().map(target => target.root),
            adapter: {
                adapterKind: 'chromiumSidecar',
                listViews: (browserSessionId) => {
                    const session = sessions.get(browserSessionId);
                    return !session?.closing ? session?.result?.adapter.listViews?.(browserSessionId) ?? [] : [];
                },
                supportsOpenView: (command) => !disposal && command.target.kind === 'externalUrl',
                ownsView: (view) => {
                    const session = sessions.get(view.browserSessionId);
                    return !session?.closing && Boolean(session?.result?.adapter.ownsView(view));
                },
                dispatchCommand: async (command, scope) => {
                    if (disposal) return failed(command, 'Browser runtime is closing.');
                    if (command.kind === 'openView') {
                        // Retire exited engines through their profile lifecycle, not a second
                        // counter. A starting or stopping engine still occupies its slot.
                        for (const [sessionId, current] of sessions) {
                            if (!current.closing && current.result?.isProcessAlive?.() === false) {
                                await profileStore.purgeForRuntimeStopped({ profileIds: [profileIdForSession(sessionId)] });
                            }
                        }
                        if (disposal) return failed(command, 'Browser runtime is closing.');
                        if (!sessions.has(command.browserSessionId)) {
                            const policy = params.readMachineResourcesPolicy?.();
                            if (policy && policy.status !== 'ready') {
                                return browserCommandDispatchFailure({ commandId: command.commandId, adapterKind: 'chromiumSidecar',
                                    code: 'policy_unavailable', message: 'Browser resource settings are unavailable.', completion: 'known', retryable: true });
                            }
                            // Live Linux observation, 2026-10-12T13:24:11Z: among eleven
                            // Chromium trees, peak main + descendants RSS was 2340.7 MiB
                            // (/proc stat RSS * getconf PAGESIZE). Round up to the next
                            // binary GiB budget, 4 GiB per engine. RSS can double-count
                            // shared pages; this is a sizing proxy, not a memory ceiling.
                            // R47 Auto admits 1 below 8 GiB, 2 at 8, 3 at 12, 4 at 16+;
                            // smaller hosts retain one usable engine. Users may override.
                            // The vitals owner reports effective memory, including Linux
                            // cgroup limits; physical host RAM would over-admit containers.
                            const memory = factoryInput.readMachineMemory?.();
                            const ram = memory?.reported ? memory.totalBytes : 0;
                            const automatic = Math.min(4, Math.max(1, Number.isFinite(ram) ? Math.floor(ram / (4 * 1024 ** 3)) : 1));
                            const limit = policy?.status === 'ready' ? policy.policy.processes.browserMaxConcurrent ?? automatic : automatic;
                            if (sessions.size >= limit) {
                                return browserCommandDispatchFailure({ commandId: command.commandId, adapterKind: 'chromiumSidecar',
                                    code: 'waiting_for_memory', completion: 'known', retryable: true,
                                    message: `Waiting for memory: ${sessions.size} of ${limit} browser sidecars are in use. Close a browser or raise the browser limit in resource settings, then retry.` });
                            }
                            // launchSession reserves synchronously before its first awaited
                            // launch, so concurrent opens cannot pass the same vacant slot.
                        }
                    }
                    const session = sessions.get(command.browserSessionId);
                    // Reserve command use before awaiting launch too: a failed first page
                    // must not retire the engine underneath a sibling still opening a view.
                    const pendingResult = command.kind === 'openView'
                        ? launchSession(command.browserSessionId, scope)
                        : session?.promise;
                    const commandSession = sessions.get(command.browserSessionId);
                    if (commandSession) commandSession.pendingCommands++;
                    try {
                        let result: BrowserSidecarControlAdapterFactoryResult | undefined;
                        try {
                            result = await pendingResult;
                        } catch {
                            await profileStore.purgeForRuntimeStopped({ profileIds: [profileIdForSession(command.browserSessionId)] });
                            return failed(command, 'Browser session launch failed.');
                        }
                        if (!result?.ok) {
                            if (result) await profileStore.purgeForRuntimeStopped({ profileIds: [profileIdForSession(command.browserSessionId)] });
                            return failed(command, result?.disabledReason ?? 'Browser session is unavailable.',
                                result?.errorCode === 'sandbox_unavailable' ? 'sandbox_unavailable' : 'adapter_unavailable');
                        }
                        if (sessions.get(command.browserSessionId)?.closing || disposal) return failed(command, 'Browser session is closing.');
                        const dispatched = await result.adapter.dispatchCommand(command, scope);
                        if (commandSession?.pendingCommands === 1
                            && result.adapter.listViews?.(command.browserSessionId).length === 0) {
                            // Also retire when the final in-flight command drains after
                            // another command closed the last view. No ghost slot remains.
                            await profileStore.purgeForRuntimeStopped({ profileIds: [profileIdForSession(command.browserSessionId)] });
                        }
                        return dispatched;
                    } finally {
                        if (commandSession) commandSession.pendingCommands--;
                    }
                },
            },
            contextCapture: {
                resolveViewportOwner: view => sessions.get(view.browserSessionId)?.result?.contextCapture?.resolveViewportOwner?.(view),
                resolvePageHandle,
                resolveNativeObservation: (view) => resolvePageHandle(view)
                    ? sessions.get(view.browserSessionId)?.result?.contextCapture?.resolveNativeObservation?.(view) : undefined,
                getNavigationState: (view) => {
                    const session = sessions.get(view.browserSessionId);
                    return !session?.closing ? session?.result?.contextCapture?.getNavigationState?.(view) ?? null : null;
                },
                subscribeBrowserEvents: (listener) => { browserEventListeners.add(listener); return () => { browserEventListeners.delete(listener); }; },
                resolveProfile: (view) => resolvePageHandle(view) ? profileStore.getProfile(profileIdForSession(view.browserSessionId)) : null,
                transport: {
                    dispatchPageCommand: async (command) => {
                        const targetParts: unknown = JSON.parse(command.targetId);
                        if (!Array.isArray(targetParts) || targetParts.length !== 2) throw new Error('Invalid Browser session handle.');
                        const [sessionId, targetId]: unknown[] = targetParts;
                        if (typeof sessionId !== 'string' || typeof targetId !== 'string') throw new Error('Invalid Browser session handle.');
                        const capture = sessions.get(sessionId)?.result?.contextCapture;
                        if (!capture || sessions.get(sessionId)?.closing) throw new Error('Browser session is unavailable.');
                        const sessionIdParts: unknown = command.sessionId ? JSON.parse(command.sessionId) : undefined;
                        const cdpSessionId = Array.isArray(sessionIdParts) && sessionIdParts[0] === sessionId && typeof sessionIdParts[1] === 'string' ? sessionIdParts[1] : undefined;
                        return capture.transport.dispatchPageCommand({
                            ...command, targetId, sessionId: cdpSessionId,
                        });
                    },
                },
                subscribeCdpEvents: (listener) => { eventListeners.add(listener); return () => { eventListeners.delete(listener); }; },
                subscribeViewLifecycle: (listener) => { viewListeners.add(listener); return () => { viewListeners.delete(listener); }; },
            },
            dispose: () => {
                disposal ??= (async () => {
                    const outcomes = await Promise.all([...sessions.keys()].map((sessionId) =>
                        profileStore.purgeForRuntimeStopped({ profileIds: [profileIdForSession(sessionId)] })));
                    eventListeners.clear();
                    viewListeners.clear();
                    browserEventListeners.clear();
                    if (outcomes.some((outcome) => outcome.failedProfileIds.length > 0)) throw new Error('Browser session profile purge failed.');
                })();
                return disposal;
            },
        };
    };
}
