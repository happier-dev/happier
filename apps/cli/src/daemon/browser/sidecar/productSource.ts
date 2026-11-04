import { createHash } from 'node:crypto';

import type {
    BrowserCommandV1,
    BrowserCommandDispatchResultV1,
    BrowserEventV1,
    BrowserSidecarErrorCodeV1,
} from '@happier-dev/protocol';

import { invalidateProcessLaunchDiscovery } from '@/processes/launchNotification';
import type { MachineResourcesPolicyReader } from '@/processes/toolIdleTimeouts';
import { browserCommandDispatchFailure } from '../control/types';
import type { BrowserProfileStore } from '../profiles/store';
import { createConfiguredBrowserProfileStore } from '../profiles/configuredStore';
import { resolveProductBrowserSidecarBinary } from './binary';
import type {
    BrowserSidecarControlAdapterFactory,
    BrowserSidecarControlAdapterFactoryResult,
    BrowserSidecarCdpEventSubscriber,
    BrowserSidecarViewLifecycleSubscriber,
    BrowserSidecarCdpPageHandle,
    BrowserSidecarCdpCommandScope,
    BrowserSidecarExtensionViewInput,
} from './controlAdapter';
import {
    createBrowserSidecarLaunchOwnerControlAdapterFactory,
    type BrowserSidecarLaunchOwnerControlAdapterFactoryInput,
} from './launchOwner';
import { resolveManagedBrowserSidecarCandidate } from './source';

type CreateLaunchOwnerFactory = (
    input: BrowserSidecarLaunchOwnerControlAdapterFactoryInput,
) => BrowserSidecarControlAdapterFactory;

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
    resolveManagedCandidate?: typeof resolveManagedBrowserSidecarCandidate;
    createLaunchOwnerFactory?: CreateLaunchOwnerFactory;
    profileStore?: BrowserProfileStore;
    readMachineResourcesPolicy?: MachineResourcesPolicyReader;
}>): BrowserSidecarControlAdapterFactory {
    const resolveCandidate = params.resolveManagedCandidate ?? resolveManagedBrowserSidecarCandidate;
    const createLaunchOwner = params.createLaunchOwnerFactory
        ?? createBrowserSidecarLaunchOwnerControlAdapterFactory;
    const platform = params.platform ?? process.platform;
    const arch = params.arch ?? process.arch;

    return async (factoryInput) => {
        const candidate = await resolveCandidate({ platform, arch });

        const binaryResolution = resolveProductBrowserSidecarBinary({
            platform,
            candidates: candidate ? [candidate] : [],
        });
        if (!binaryResolution.ok) {
            return unavailable(binaryResolution.errorCode, binaryResolution.disabledReason);
        }

        const profileStore = params.profileStore ?? createConfiguredBrowserProfileStore();
        type Launched = Extract<BrowserSidecarControlAdapterFactoryResult, { ok: true }>;
        type SessionLaunch = { promise: Promise<BrowserSidecarControlAdapterFactoryResult>; result?: Launched;
            stop: () => Promise<void>; closing: boolean; pendingCommands: number;
            profileId: string; extensionDirectories: readonly string[] };
        const sessions = new Map<string, SessionLaunch>();
        const eventListeners = new Set<BrowserSidecarCdpEventSubscriber>();
        const viewListeners = new Set<BrowserSidecarViewLifecycleSubscriber>();
        const browserEventListeners = new Set<(event: BrowserEventV1) => void>();
        let disposal: Promise<void> | null = null;

        const profileIdForSession = (sessionId: string): string =>
            `browser_session_${createHash('sha256').update(sessionId).digest('hex')}`;
        function sessionCreatedEvent(browserSessionId: string) {
            const profileId = sessions.get(browserSessionId)?.profileId;
            const profile = profileId ? profileStore.getProfile(profileId) : null;
            if (!profile || profile.lifecycleState !== 'active' || profile.createdAt === undefined) return null;
            return { kind: 'sessionCreated', eventId: `${profile.profileId}:created`, browserSessionId,
                profileId: profile.profileId, occurredAt: profile.createdAt } satisfies BrowserEventV1;
        }
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
        async function launchSession(sessionId: string, scope?: BrowserSidecarCdpCommandScope, requestedProfileId?: string): Promise<BrowserSidecarControlAdapterFactoryResult> {
            const existing = sessions.get(sessionId);
            // Decide profile custody once on open, including reusing a running engine.
            // Guests retain their Session profile; persistent profiles can hold owner logins.
            if (scope?.requester && scope.requester.role !== 'manage'
                && (requestedProfileId || (existing && profileStore.getProfile(existing.profileId)?.storageMode !== 'ephemeral'))) {
                return unavailable('profile_policy_denied', 'Guest Sessions use their own browser profile.');
            }
            if (existing) {
                if (requestedProfileId && existing.profileId !== requestedProfileId) {
                    return unavailable('profile_policy_denied', 'Close this browser before selecting a different profile.');
                }
                return existing.promise;
            }
            const profileId = requestedProfileId ?? profileIdForSession(sessionId);
            if (requestedProfileId && [...sessions.values()].some(current => current.profileId === profileId)) {
                return unavailable('profile_policy_denied', 'This browser profile is already open in another Session.');
            }
            const previousProfile = profileStore.getProfile(profileId);
            if (!requestedProfileId && previousProfile && previousProfile.lifecycleState !== 'active') {
                return unavailable('launch_failed', 'Browser session profile is purging or unusable after a failed purge.');
            }
            let session: SessionLaunch;
            const cancellation = new AbortController();
            const cancelLaunch = () => cancellation.abort();
            if (scope?.signal?.aborted || (scope?.deadlineMs !== undefined && scope.deadlineMs <= Date.now())) cancelLaunch();
            else scope?.signal?.addEventListener('abort', cancelLaunch, { once: true });
            let stopping: Promise<void> | undefined;
            const stop = (): Promise<void> => {
                session.closing = true;
                cancellation.abort();
                stopping ??= (async () => {
                    const result = await session.promise.catch(() => undefined);
                    try {
                        if (result?.ok) await result.dispose?.();
                    } catch (error) {
                        // An observed child exit releases its memory slot even if
                        // CDP cleanup failed. A purge still reports that failure.
                        if (result?.ok && result.isProcessAlive?.() === false) sessions.delete(sessionId);
                        throw error;
                    }
                    sessions.delete(sessionId);
                })();
                return stopping;
            };
            const beforePurge = async () => { await sessions.get(sessionId)?.stop(); };
            const ephemeralProfile = requestedProfileId ? null : profileStore.register({
                profileId, storageMode: 'ephemeral', owner: { kind: 'session', id: sessionId },
                createdAt: previousProfile?.createdAt,
                cleanupOnSessionClose: true,
                beforePurge,
            });
            const promise = Promise.resolve().then(async () => {
                let profile = ephemeralProfile;
                if (requestedProfileId) {
                    const persistent = await profileStore.loadPersistentProfile(requestedProfileId);
                    if (!persistent) return unavailable('profile_policy_denied', 'The selected persistent browser profile does not exist.');
                    const extensions = await profileStore.listExtensions(requestedProfileId);
                    if (!extensions.ok) return unavailable('profile_policy_denied', `Browser profile extensions are unavailable: ${extensions.reason}.`);
                    profile = profileStore.register({ ...persistent, beforePurge });
                    session.extensionDirectories = extensions.extensions.filter(extension => extension.enabled).map(extension => extension.directory);
                }
                if (!profile) return unavailable('profile_policy_denied', 'Browser profile is unavailable.');
                const remainingDeadlineMs = scope?.deadlineMs === undefined ? undefined : scope.deadlineMs - Date.now();
                if (remainingDeadlineMs !== undefined && remainingDeadlineMs <= 0) cancelLaunch();
                const result = await createLaunchOwner({
                    browserSessionId: sessionId,
                    sidecarId: profileId,
                    profile,
                    profileDirectory: profileStore.resolveProfileDirectory(profileId),
                    extensionDirectories: session.extensionDirectories,
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
            session = { promise, stop, closing: false, pendingCommands: 0, profileId, extensionDirectories: [] };
            sessions.set(sessionId, session);
            return promise;
        }
        function failed(command: Readonly<{ commandId: string }>, message: string, code: 'adapter_unavailable' | 'sandbox_unavailable' = 'adapter_unavailable') {
            return browserCommandDispatchFailure({ commandId: command.commandId, adapterKind: 'chromiumSidecar', code, message });
        }
        const readResourceTargets = () => [...sessions.entries()].flatMap(([sessionId, session]) => {
                if (session.closing || disposal) return [];
                return (session.result?.readResourceTargets?.() ?? []).map(target => ({ ...target,
                    stopAndPurge: async () => {
                        if (sessions.get(sessionId) !== session || session.closing) throw new Error('Browser session is no longer current.');
                        const outcome = await profileStore.purgeForExplicitRequest({ profileIds: [session.profileId] });
                        if (outcome.failedProfileIds.length) throw new Error('Browser session profile purge failed.');
                    },
                    root: { ...target.root, stop: async () => {
                        if (sessions.get(sessionId) !== session || session.closing) throw new Error('Browser session is no longer current.');
                        await session.stop();
                    } },
                }));
            });
        async function dispatchSessionCommand(
            command: Pick<BrowserCommandV1, 'commandId' | 'browserSessionId'> & Readonly<{ kind: BrowserCommandV1['kind']; profileId?: string }>,
            scope: BrowserSidecarCdpCommandScope | undefined,
            dispatch: (result: Launched) => ReturnType<Launched['adapter']['dispatchCommand']>,
        ): Promise<BrowserCommandDispatchResultV1> {
            if (disposal) return failed(command, 'Browser runtime is closing.');
            if (command.kind === 'openView') {
                // Engine lifetime owns resource admission; the Session profile
                // survives a process exit. Starting/stopping engines keep their slot.
                for (const current of sessions.values()) {
                    if (!current.closing && current.result?.isProcessAlive?.() === false) {
                        await current.stop();
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
                ? launchSession(command.browserSessionId, scope, command.profileId)
                : session?.promise;
            const commandSession = sessions.get(command.browserSessionId);
            if (commandSession) commandSession.pendingCommands++;
            try {
                let result: BrowserSidecarControlAdapterFactoryResult | undefined;
                try {
                    result = await pendingResult;
                } catch {
                    await commandSession?.stop();
                    return failed(command, 'Browser session launch failed.');
                }
                if (!result?.ok) {
                    if (result && !session) await commandSession?.stop();
                    return failed(command, result?.disabledReason ?? 'Browser session is unavailable.',
                        result?.errorCode === 'sandbox_unavailable' ? 'sandbox_unavailable' : 'adapter_unavailable');
                }
                if (sessions.get(command.browserSessionId)?.closing || disposal) return failed(command, 'Browser session is closing.');
                const dispatched = await dispatch(result);
                if (commandSession?.pendingCommands === 1
                    && result.adapter.listViews?.(command.browserSessionId).length === 0) {
                    // Retire the engine after the final in-flight command drains,
                    // retaining its Session workspace for the next open.
                    await commandSession.stop();
                }
                const created = command.kind === 'openView' && dispatched.status === 'dispatched'
                    ? sessionCreatedEvent(command.browserSessionId) : null;
                return created && dispatched.status === 'dispatched'
                    ? { ...dispatched, events: [created, ...dispatched.events] } : dispatched;
            } finally {
                if (commandSession) commandSession.pendingCommands--;
            }
        }
        return {
            ok: true,
            readResourceTargets,
            readProcessRoots: () => readResourceTargets().map(target => target.root),
            extensions: {
                openView: (input: BrowserSidecarExtensionViewInput, scope) => dispatchSessionCommand({
                    commandId: input.commandId, browserSessionId: input.browserSessionId,
                    kind: 'openView', profileId: input.profileId,
                }, scope, result => result.extensions?.openView(input, scope)
                    ?? Promise.resolve(failed(input, 'Browser extension pages are unavailable.'))),
                restartProfile: async (profileId) => {
                    await Promise.all([...sessions.values()].filter(session => session.profileId === profileId).map(session => session.stop()));
                },
                getProfileRuntime: (profileId) => {
                    const session = [...sessions.values()].find(current => current.profileId === profileId && !current.closing);
                    return { active: Boolean(session), extensionDirectories: session?.extensionDirectories ?? [] };
                },
            },
            adapter: {
                adapterKind: 'chromiumSidecar',
                listViews: (browserSessionId) => {
                    const session = sessions.get(browserSessionId);
                    if (session?.closing) return [];
                    const created = sessionCreatedEvent(browserSessionId);
                    // Discovery materializes the daemon's real Session/profile binding,
                    // including views opened by an agent before any UI was mounted.
                    return (session?.result?.adapter.listViews?.(browserSessionId) ?? []).map(view => created
                        ? { ...view, events: [created, ...view.events] } : view);
                },
                supportsOpenView: (command) => !disposal && command.target.kind === 'externalUrl',
                ownsView: (view) => {
                    const session = sessions.get(view.browserSessionId);
                    return !session?.closing && Boolean(session?.result?.adapter.ownsView(view));
                },
                dispatchCommand: (command, scope) => dispatchSessionCommand(command, scope,
                    result => result.adapter.dispatchCommand(command, scope)),
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
                resolveProfile: (view) => {
                    const profileId = sessions.get(view.browserSessionId)?.profileId;
                    return profileId && resolvePageHandle(view) ? profileStore.getProfile(profileId) : null;
                },
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
                    // Runtime disposal is not Session end. Keep workspace bytes and
                    // registrations with the shared store for explicit/Session purge.
                    await Promise.all([...sessions.values()].map(session => session.stop()));
                    eventListeners.clear();
                    viewListeners.clear();
                    browserEventListeners.clear();
                })();
                return disposal;
            },
        };
    };
}
