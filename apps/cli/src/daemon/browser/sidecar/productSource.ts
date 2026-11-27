import { BrowserHttpUrlV1Schema } from '@happier-dev/protocol/browser/url';

import type {
    BrowserCommandV1,
    BrowserCommandDispatchResultV1,
    BrowserEventV1,
    BrowserDaemonViewV1,
    BrowserSidecarErrorCodeV1,
} from '@happier-dev/protocol';

import { logger } from '@/ui/logger';
import { invalidateProcessLaunchDiscovery } from '@/processes/launchNotification';
import type { MachineResourcesPolicyReader } from '@/processes/toolIdleTimeouts';
import { browserCommandDispatchFailure, isBrowserDaemonControlAdapterKind } from '../control/types';
import type { BrowserExistingProfile } from '../control/types';
import { deriveSessionBrowserProfileId, type BrowserProfileStore } from '../profiles/store';
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
import type { BrowserSidecarInteractions } from './interactions';
import { inspectLocalBrowserWindowHost, type LocalBrowserWindowHost } from './localWindow';

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
    /** Existing admitted Session attribution; absent ownership never grants guest access. */
    readSessionAccountId?: (sessionId: string) => string | null;
    readMachineResourcesPolicy?: MachineResourcesPolicyReader;
    localWindowHost?: LocalBrowserWindowHost;
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
        type SessionLaunch = { promise?: Promise<BrowserSidecarControlAdapterFactoryResult>; result?: Launched;
            stop: () => Promise<void>; closing: boolean; pendingCommands: number;
            terminalViews: readonly BrowserDaemonViewV1[];
            profileId: string; extensionDirectories: readonly string[]; presentation: 'headless' | 'window' };
        const sessions = new Map<string, SessionLaunch>();
        for (const command of await profileStore.readRetainedSessionPages()) {
            const profileId = command.profileId ?? deriveSessionBrowserProfileId(command.browserSessionId);
            if (command.profileId) await profileStore.loadPersistentProfile(profileId);
            else profileStore.register({ profileId, storageMode: 'ephemeral',
                owner: { kind: 'session', id: command.browserSessionId }, cleanupOnSessionClose: true });
            sessions.set(command.browserSessionId, { profileId, closing: true, pendingCommands: 0,
                extensionDirectories: [], presentation: 'headless', stop: async () => {}, terminalViews: [{
                    browserSessionId: command.browserSessionId, viewId: command.viewId,
                    sourceId: `restarted:${command.viewId}`, target: command.target, platform: command.platform,
                    adapterKind: 'chromiumSidecar', closedAfterRestart: command,
                    events: [{ kind: 'viewClosed', browserSessionId: command.browserSessionId, viewId: command.viewId,
                        eventId: `restarted:${command.viewId}`, occurredAt: Date.now(), reasonCode: 'daemon_restarted' }],
                }] });
        }
        // A profile restart replaces a physical page, not the selected workspace view.
        // Keep that view discoverable until the finite replacement operation settles.
        const profileReplacements = new Map<string, { view: BrowserDaemonViewV1; closedEvent?: BrowserEventV1 }>();
        const eventListeners = new Set<BrowserSidecarCdpEventSubscriber>();
        const viewListeners = new Set<BrowserSidecarViewLifecycleSubscriber>();
        const browserEventListeners = new Set<(event: BrowserEventV1) => void>();
        const interactionListeners = new Set<Parameters<BrowserSidecarInteractions['subscribe']>[0]>();
        let disposal: Promise<void> | null = null;

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
        function resolveInteractions(view: Readonly<{ browserSessionId: string }>) {
            const session = sessions.get(view.browserSessionId);
            return !session?.closing ? session?.result?.contextCapture?.interactions : undefined;
        }
        // Interactions retain their real per-process CDP transport, view bindings and staging.
        // The product surface only selects the Session owner, just like control and capture.
        const interactions: BrowserSidecarInteractions = {
            getState: view => resolveInteractions(view)?.getState(view) ?? null,
            subscribe(listener) { interactionListeners.add(listener); return () => { interactionListeners.delete(listener); }; },
            execute: async request => resolveInteractions(request)?.execute(request) ?? { ok: false, errorCode: 'view_closed' },
            stageUpload: async (view, files) => {
                const owner = resolveInteractions(view);
                if (!owner) throw new Error('Browser view is closed');
                return owner.stageUpload(view, files);
            },
            dispose: async () => {
                await Promise.all([...sessions.values()].map(session => session.result?.contextCapture?.interactions?.dispose()));
                interactionListeners.clear();
            },
        };
        function canAccessSessionProfile(sessionId: string, scope?: BrowserSidecarCdpCommandScope, requestedProfileId?: string, existingProfile?: BrowserExistingProfile): boolean {
            const requester = scope?.requester;
            const shared = scope?.sessionBrowserAccess;
            if (shared && (shared.sessionId !== sessionId || !shared.effectiveAccess.capabilities.readTranscript)) return false;
            if (!requester || requester.role === 'manage'
                || requester.actorAccountId && requester.actorAccountId === requester.custodianAccountId) return true;
            // Mounted UI records belong to their adapter, outside the native profile store.
            if (existingProfile && !isBrowserDaemonControlAdapterKind(existingProfile.adapterKind)) return true;
            if (!shared && (!requester.actorAccountId || params.readSessionAccountId?.(sessionId) !== requester.actorAccountId)) return false;
            if (existingProfile && !existingProfile.profileId) return false;
            const existing = sessions.get(sessionId);
            // Admission reuses only a running/starting engine. Terminal discovery
            // supplies its retained profile provenance through existingProfile instead.
            const profileId = existingProfile?.profileId ?? (existing?.promise ? existing.profileId : undefined);
            // Persistent profiles may contain owner logins. Commands and discovery
            // share this decision, including reusing an already-running engine.
            return !requestedProfileId && (!profileId || profileStore.getProfile(profileId)?.storageMode === 'ephemeral');
        }
        function getCommandAccessFailure(command: Readonly<{ commandId: string; browserSessionId: string; profileId?: string; existingProfile?: BrowserExistingProfile }>, scope?: BrowserSidecarCdpCommandScope) {
            if (scope?.sessionBrowserAccess && !scope.sessionBrowserAccess.effectiveAccess.capabilities.submitAgentInput) {
                return browserCommandDispatchFailure({ commandId: command.commandId, adapterKind: 'chromiumSidecar',
                    code: 'permission_denied', message: 'This Session share permits viewing the Browser.', completion: 'known', retryable: false });
            }
            return canAccessSessionProfile(command.browserSessionId, scope, command.profileId, command.existingProfile) ? undefined
                : browserCommandDispatchFailure({ commandId: command.commandId, adapterKind: 'chromiumSidecar',
                    code: 'profile_policy_denied', message: 'This Browser profile is unavailable to this Session.', completion: 'known', retryable: false });
        }
        function terminalViewsForSession(sessionId: string): readonly BrowserDaemonViewV1[] {
            const session = sessions.get(sessionId);
            if (!session) return [];
            const adapter = session.result?.adapter;
            if (!adapter) return session.terminalViews;
            const terminalViews = adapter.listTerminalViews?.(sessionId) ?? [];
            const currentIds = new Set([...(adapter.listViews?.(sessionId) ?? []), ...terminalViews].map(view => view.viewId));
            return [...session.terminalViews.filter(view => !currentIds.has(view.viewId)), ...terminalViews];
        }
        async function launchSession(sessionId: string, scope?: BrowserSidecarCdpCommandScope, requestedProfileId?: string, presentation: 'headless' | 'window' = 'headless'): Promise<BrowserSidecarControlAdapterFactoryResult> {
            const existing = sessions.get(sessionId);
            if (existing?.promise) {
                if (requestedProfileId && existing.profileId !== requestedProfileId) {
                    return unavailable('profile_policy_denied', 'Close this browser before selecting a different profile.');
                }
                return existing.promise;
            }
            const profileId = requestedProfileId ?? deriveSessionBrowserProfileId(sessionId);
            if (requestedProfileId && [...sessions.values()].some(current => current.promise && current.profileId === profileId)) {
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
            const retire = () => {
                // Preserve only the binding owner's final facts and profile custody until
                // this Session ends. Release the native engine, transport and launch promise.
                session.terminalViews = terminalViewsForSession(sessionId);
                session.result = undefined;
                session.promise = undefined;
                session.extensionDirectories = [];
                session.stop = async () => {};
            };
            const stop = (): Promise<void> => {
                session.closing = true;
                // Cancel an unfinished launch. Established engines finish orderly
                // disposal before cancellation closes their native transport.
                if (!session.result) cancellation.abort();
                stopping ??= (async () => {
                    const result = await session.promise?.catch(() => undefined);
                    try {
                        const disposal = result?.ok ? result.dispose?.() : undefined;
                        await disposal;
                    } catch (error) {
                        // An observed child exit releases its memory slot even if
                        // CDP cleanup failed. A purge still reports that failure.
                        if (result?.ok && result.isProcessAlive?.() === false) retire();
                        throw error;
                    } finally {
                        cancellation.abort();
                    }
                    retire();
                })();
                return stopping;
            };
            const beforePurge = async () => {
                await sessions.get(sessionId)?.stop();
                sessions.delete(sessionId);
            };
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
                    presentation,
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
                    result.contextCapture?.subscribeViewLifecycle?.((event) => {
                        if (event.type === 'bound') session.terminalViews = session.terminalViews.filter(view => !view.closedAfterRestart);
                        emit(viewListeners, event);
                    });
                    result.contextCapture?.subscribeBrowserEvents?.((event) => {
                        const replacement = profileReplacements.get(event.browserSessionId);
                        if (event.kind === 'viewClosed' && event.viewId === replacement?.view.viewId) {
                            replacement.closedEvent = event;
                            return;
                        }
                        emit(browserEventListeners, event);
                    });
                    result.contextCapture?.interactions?.subscribe((view) => emit(interactionListeners, view));
                }
                return result;
            }).finally(() => scope?.signal?.removeEventListener('abort', cancelLaunch));
            session = { promise, stop, closing: false, pendingCommands: 0,
                terminalViews: existing?.profileId === profileId ? existing.terminalViews : [],
                profileId, extensionDirectories: [], presentation };
            sessions.set(sessionId, session);
            return promise;
        }
        function failed(command: Readonly<{ commandId: string }>, message: string, code: 'adapter_unavailable' | 'sandbox_unavailable' | 'profile_policy_denied' = 'adapter_unavailable') {
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
            command: Pick<BrowserCommandV1, 'commandId' | 'browserSessionId'> & Readonly<{ kind: BrowserCommandV1['kind']; profileId?: string; viewId?: string }>,
            scope: BrowserSidecarCdpCommandScope | undefined,
            dispatch: (result: Launched) => ReturnType<Launched['adapter']['dispatchCommand']>,
            presentation: 'headless' | 'window' = 'headless',
        ): Promise<BrowserCommandDispatchResultV1> {
            if (disposal) return failed(command, 'Browser runtime is closing.');
            const accessFailure = getCommandAccessFailure(command, scope);
            if (accessFailure) return accessFailure;
            if (command.kind === 'openView') {
                // Engine lifetime owns resource admission; the Session profile
                // survives a process exit. Starting/stopping engines keep their slot.
                for (const current of sessions.values()) {
                    if (!current.closing && current.result?.isProcessAlive?.() === false) {
                        await current.stop();
                    }
                }
                if (disposal) return failed(command, 'Browser runtime is closing.');
                if (!sessions.get(command.browserSessionId)?.promise) {
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
                    const activeEngines = [...sessions.values()].filter(session => session.promise).length;
                    if (activeEngines >= limit) {
                        return browserCommandDispatchFailure({ commandId: command.commandId, adapterKind: 'chromiumSidecar',
                            code: 'waiting_for_memory', completion: 'known', retryable: true,
                            message: `Waiting for memory: ${activeEngines} of ${limit} browser sidecars are in use. Close a browser or raise the browser limit in resource settings, then retry.` });
                    }
                    // launchSession reserves synchronously before its first awaited
                    // launch, so concurrent opens cannot pass the same vacant slot.
                }
            }
            const session = sessions.get(command.browserSessionId);
            // Reserve command use before awaiting launch too: a failed first page
            // must not retire the engine underneath a sibling still opening a view.
            const pendingResult = command.kind === 'openView'
                ? launchSession(command.browserSessionId, scope, command.profileId, presentation)
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
                    if (result && !session?.promise) await commandSession?.stop();
                    return failed(command, result?.disabledReason ?? 'Browser session is unavailable.',
                        result?.errorCode === 'sandbox_unavailable' || result?.errorCode === 'profile_policy_denied'
                            ? result.errorCode : 'adapter_unavailable');
                }
                if (sessions.get(command.browserSessionId)?.closing || disposal) return failed(command, 'Browser session is closing.');
                const dispatched = await dispatch(result);
                if (dispatched.status === 'dispatched') {
                    // Keep one recoverable page through the profile owner, including when a
                    // closed tab leaves another page alive. Never replace the native result
                    // with a metadata-write failure after the effect has already happened.
                    try {
                        const session = sessions.get(command.browserSessionId);
                        const pages = session?.result?.adapter.listViews?.(command.browserSessionId) ?? [];
                        const page = pages.find(page => page.viewId === command.viewId) ?? pages.at(-1);
                        if (page && session) {
                            const currentUrl = session.result?.contextCapture?.getNavigationState?.(page)?.currentUrl;
                            const profile = profileStore.getProfile(session.profileId);
                            const profileId = profile?.storageMode === 'user' || profile?.storageMode === 'plugin'
                                ? profile.profileId : undefined;
                            await profileStore.retainSessionPage({ kind: 'openView', commandId: command.commandId,
                                browserSessionId: page.browserSessionId, viewId: page.viewId, platform: page.platform,
                                target: page.target.kind === 'externalUrl' && currentUrl ? { ...page.target, url: currentUrl } : page.target,
                                focus: true, ...(profileId ? { profileId } : {}) });
                        } else if (command.kind === 'closeView') await profileStore.forgetSessionPage(command.browserSessionId);
                    } catch {
                        logger.warn('[browser] Restart recovery metadata could not be saved.');
                    }
                }
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
            stopSession: async browserSessionId => {
                await sessions.get(browserSessionId)?.stop();
                sessions.delete(browserSessionId);
                await profileStore.forgetSessionPage(browserSessionId);
            },
            readResourceTargets,
            readProcessRoots: () => readResourceTargets().map(target => target.root),
            localWindow: {
                async showAsWindow(command) {
                    const host = await inspectLocalBrowserWindowHost(params.localWindowHost);
                    if (!host.available) return { ok: false, reason: host.reason };
                    const existing = sessions.get(command.browserSessionId);
                    if (existing?.promise) {
                        const control = factoryInput.resolveInputControl?.(command);
                        if (existing.closing || existing.pendingCommands || !existing.result
                            || control?.getAdmissionFailure('human') === 'busy' || control?.isObservationHeld()) {
                            return { ok: false, reason: 'browser_busy' };
                        }
                        const views = existing.result.adapter.listViews?.(command.browserSessionId) ?? [];
                        const view = views.find(view => view.viewId === command.viewId);
                        if (!view) return { ok: false, reason: 'view_not_found' };
                        // A Chromium process belongs to a Session. Never relaunch siblings for a per-view intent.
                        if (views.length !== 1) return { ok: false, reason: 'shared_browser_session' };
                        if (command.profileId && command.profileId !== existing.profileId) return { ok: false, reason: 'profile_mismatch' };
                        if (existing.presentation === 'window') {
                            const result = await dispatchSessionCommand(command, undefined,
                                launched => launched.adapter.dispatchCommand({ ...command, kind: 'focusView' }));
                            return result.status === 'dispatched' ? { ok: true, result } : { ok: false, reason: 'open_failed', result };
                        }
                        const currentUrl = existing.result.contextCapture?.getNavigationState?.(command)?.currentUrl
                            ?? (view.target.kind === 'externalUrl' ? view.target.url : undefined);
                        const url = BrowserHttpUrlV1Schema.safeParse(currentUrl);
                        if (!url.success) return { ok: false, reason: 'unsupported_view' };
                        const profile = profileStore.getProfile(existing.profileId);
                        command = { ...command, target: { kind: 'externalUrl', targetId: view.target.targetId, url: url.data },
                            profileId: profile?.storageMode === 'user' || profile?.storageMode === 'plugin' ? existing.profileId : undefined };
                        try { await existing.stop(); }
                        catch { return { ok: false, reason: 'open_failed' }; }
                    }
                    const result = await dispatchSessionCommand(command, undefined,
                        launched => launched.adapter.dispatchCommand(command), 'window');
                    return result.status === 'dispatched' ? { ok: true, result } : { ok: false, reason: 'open_failed', result };
                },
            },
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
                subscribeViewLifecycle: listener => { viewListeners.add(listener); return () => { viewListeners.delete(listener); }; },
                getCommandAccessFailure,
                listTerminalViews: (browserSessionId, scope) => {
                    if (!canAccessSessionProfile(browserSessionId, scope, undefined, {
                        adapterKind: 'chromiumSidecar', profileId: sessions.get(browserSessionId)?.profileId,
                    })) return [];
                    const replacement = profileReplacements.get(browserSessionId);
                    return terminalViewsForSession(browserSessionId).filter(view => !view.events.some(event =>
                        event.kind === 'viewClosed' && event.viewId === replacement?.view.viewId));
                },
                listViews: (browserSessionId, scope) => {
                    if (!canAccessSessionProfile(browserSessionId, scope)) return [];
                    const session = sessions.get(browserSessionId);
                    const created = sessionCreatedEvent(browserSessionId);
                    // Discovery materializes the daemon's real Session/profile binding,
                    // including views opened by an agent before any UI was mounted.
                    const views = (!session?.closing ? session?.result?.adapter.listViews?.(browserSessionId) ?? [] : []).map(view => created
                        ? { ...view, events: [created, ...view.events] } : view);
                    const replacement = profileReplacements.get(browserSessionId);
                    return replacement && !views.some(view => view.viewId === replacement.view.viewId)
                        ? [...views, replacement.view] : views;
                },
                async replaceProfile(command, scope) {
                    const denied = getCommandAccessFailure(command, scope);
                    if (denied) return denied;
                    const views = sessions.get(command.browserSessionId)?.result?.adapter.listViews?.(command.browserSessionId, scope) ?? [];
                    const view = views.find(view => view.viewId === command.viewId);
                    if (!view) return browserCommandDispatchFailure({ commandId: command.commandId, code: 'view_not_found',
                        message: 'The Browser page is no longer available.' });
                    const replacement = { view, closedEvent: undefined as BrowserEventV1 | undefined };
                    profileReplacements.set(command.browserSessionId, replacement);
                    let replaced = false;
                    try {
                        const events: BrowserEventV1[] = [];
                        for (const current of views) {
                            const closed = await dispatchSessionCommand({ kind: 'closeView', browserSessionId: command.browserSessionId,
                                commandId: `${command.commandId}:close:${current.viewId}` }, scope,
                            result => result.adapter.dispatchCommand({ kind: 'closeView', browserSessionId: command.browserSessionId,
                                viewId: current.viewId, commandId: `${command.commandId}:close:${current.viewId}` }, scope));
                            if (closed.status !== 'dispatched') return closed;
                            events.push(...closed.events.filter(event => event.kind !== 'viewClosed' || event.viewId !== command.viewId));
                        }
                        const opened = await dispatchSessionCommand(command, scope, result => result.adapter.dispatchCommand(command, scope));
                        replaced = opened.status === 'dispatched';
                        return opened.status === 'dispatched' ? { ...opened, events: [...events, ...opened.events] } : opened;
                    } finally {
                        profileReplacements.delete(command.browserSessionId);
                        if (!replaced && replacement.closedEvent) emit(browserEventListeners, replacement.closedEvent);
                        emit(viewListeners, { type: resolvePageHandle(command) ? 'bound' : 'unbound',
                            browserSessionId: command.browserSessionId, viewId: command.viewId });
                    }
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
                interactions,
                resolvePageHandle,
                resolveNativeObservation: (view) => resolvePageHandle(view)
                    ? sessions.get(view.browserSessionId)?.result?.contextCapture?.resolveNativeObservation?.(view) : undefined,
                getNavigationEvent: (view) => {
                    const session = sessions.get(view.browserSessionId);
                    return !session?.closing ? session?.result?.contextCapture?.getNavigationEvent?.(view) ?? null : null;
                },
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
                    sessions.clear();
                    eventListeners.clear();
                    viewListeners.clear();
                    browserEventListeners.clear();
                    interactionListeners.clear();
                })();
                return disposal;
            },
        };
    };
}
