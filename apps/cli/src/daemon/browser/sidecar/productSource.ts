import { createHash } from 'node:crypto';

import type {
    BrowserCommandV1,
    BrowserEventV1,
    BrowserSidecarErrorCodeV1,
} from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { browserCommandDispatchFailure } from '../control/types';
import { createBrowserProfileStore, type BrowserProfileStore } from '../profiles/store';
import { createBrowserStoragePartitionOwner } from '../storage/partitions';
import {
    resolveSidecarBrowserBinary,
    type SidecarBrowserBinaryCandidate,
    type SidecarBrowserBinaryResolution,
} from './binary';
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

// Product whitelist is narrowed to managed-only (FP-BRW-SOURCE-1 step 10a). System/PATH Chrome,
// floating Chrome-for-Testing, Playwright caches, and Electron Chromium must NEVER count as a
// product source — they stay fail-closed forever (TRACKING §10 Category 2). The launch owner and
// `binary.ts` enforce the same invariant defensively.
const PRODUCT_BROWSER_SIDECAR_SOURCES = new Set<SidecarBrowserBinaryCandidate['source']>([
    'managedBrowserPackage',
]);

const PRODUCT_BROWSER_SIDECAR_DISCOVERY_KINDS = new Set<SidecarBrowserBinaryCandidate['discoveryKind']>([
    'managedRuntime',
    'packagedApp',
]);

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

function isProductCandidate(candidate: SidecarBrowserBinaryCandidate): boolean {
    return PRODUCT_BROWSER_SIDECAR_SOURCES.has(candidate.source)
        && PRODUCT_BROWSER_SIDECAR_DISCOVERY_KINDS.has(candidate.discoveryKind);
}

function missingProductSourceResolution(): SidecarBrowserBinaryResolution {
    return {
        ok: false,
        source: 'managedBrowserPackage',
        errorCode: 'managed_package_missing',
        disabledReason: PRODUCT_SOURCE_MISSING_REASON,
        diagnostics: [],
    };
}

export function resolveProductBrowserSidecarBinary(params: Readonly<{
    platform?: NodeJS.Platform | string;
    candidates?: readonly SidecarBrowserBinaryCandidate[];
}> = {}): SidecarBrowserBinaryResolution {
    const productCandidates = (params.candidates ?? []).filter(isProductCandidate);
    if (productCandidates.length === 0) {
        return missingProductSourceResolution();
    }

    return resolveSidecarBrowserBinary({
        platform: params.platform ?? process.platform,
        sourcePreference: 'managed-first',
        candidates: productCandidates,
    });
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

        // Provenance is mandatory: a managed candidate without a locally-verified pinned digest
        // must never reach the launch owner. This is the BRW-7 acceptance invariant.
        if (binaryResolution.provenance?.origin !== 'managed_package') {
            return unavailable(
                'binary_resolution_failed',
                'Managed Browser sidecar source resolved without verified provenance.',
            );
        }

        if (!params.featureEnabled) return unavailable('feature_disabled', 'browser.sidecar feature disabled');
        const profileStore = params.profileStore ?? createBrowserProfileStore({
            storageRootDirectory: configuration.happyHomeDir,
            partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: configuration.happyHomeDir }),
        });
        type Launched = Extract<BrowserSidecarControlAdapterFactoryResult, { ok: true }>;
        type SessionLaunch = { promise: Promise<BrowserSidecarControlAdapterFactoryResult>; result?: Launched; closing: boolean };
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
                    if (result.ok) await result.dispose?.();
                    sessions.delete(sessionId);
                },
            });
            const promise = Promise.resolve().then(async () => {
                const remainingDeadlineMs = scope?.deadlineMs === undefined ? undefined : scope.deadlineMs - Date.now();
                if (remainingDeadlineMs !== undefined && remainingDeadlineMs <= 0) cancelLaunch();
                const result = await createLaunchOwner({
                    browserSessionId: sessionId,
                    sidecarId: profileId,
                    featureEnabled: params.featureEnabled,
                    allowPersistentProfiles: false,
                    profile,
                    profileDirectory: profileStore.resolveProfileDirectory(profileId),
                    binaryResolution,
                    signal: cancellation.signal,
                    ...(remainingDeadlineMs !== undefined ? { endpointTimeoutMs: remainingDeadlineMs } : {}),
                    // Registered profile lifecycle owns deletion, after dispose has settled CDP
                    // and the process. Never delete these same bytes through a second owner.
                    cleanupProfileDirectory: () => {},
                })(factoryInput);
                if (result.ok) {
                    session.result = result;
                    result.contextCapture?.subscribeCdpEvents?.((notification) => emit(eventListeners, {
                        ...notification,
                        ...(notification.sessionId ? { sessionId: JSON.stringify([sessionId, notification.sessionId]) } : {}),
                    }));
                    result.contextCapture?.subscribeViewLifecycle?.((event) => emit(viewListeners, event));
                    result.contextCapture?.subscribeBrowserEvents?.((event) => emit(browserEventListeners, event));
                }
                return result;
            }).finally(() => scope?.signal?.removeEventListener('abort', cancelLaunch));
            session = { promise, closing: false };
            sessions.set(sessionId, session);
            return promise;
        }
        function failed(command: BrowserCommandV1, message: string, code: 'adapter_unavailable' | 'sandbox_unavailable' = 'adapter_unavailable') {
            return browserCommandDispatchFailure({ commandId: command.commandId, adapterKind: 'chromiumSidecar', code, message });
        }
        return {
            ok: true,
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
                    const session = sessions.get(command.browserSessionId);
                    let result: BrowserSidecarControlAdapterFactoryResult | undefined;
                    try {
                        result = command.kind === 'openView'
                            ? await launchSession(command.browserSessionId, scope)
                            : await session?.promise;
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
                    return result.adapter.dispatchCommand(command, scope);
                },
            },
            contextCapture: {
                resolvePageHandle,
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
