import {
    listServerProfiles,
    loadHomeViewState,
    subscribeHomeViewState,
    subscribeServerProfiles,
    updateHomeViewState,
    type HomeViewStateV1,
} from '@/sync/domains/server/serverProfiles';
import { ALL_HOMES_MINIMUM_HOME_COUNT, ALL_HOMES_SELECTION_TARGET_ID, isAllHomesSelectionTargetId } from './allHomesSelectionTarget';
import { listServerProfileScopeIds, resolveServerProfileScopeIdForSelectionIdentifier } from './serverSelectionProfileScopeIds';

const SESSION_STORAGE_HOME_VIEW_TARGET_KEY = 'homeViewActiveTargetV1';

type HomeViewTarget = Readonly<{
    kind: 'server' | 'group';
    id: string;
}>;

const tabTargetListeners = new Set<() => void>();
let effectiveStateCache: Readonly<{
    deviceState: HomeViewStateV1;
    profileScopeKey: string;
    targetKey: string;
    value: HomeViewStateV1;
}> | null = null;

function profileScopeKey(profiles: ReturnType<typeof listServerProfiles>): string {
    return profiles.map((profile) => [
        profile.id,
        profile.serverIdentityId ?? '',
        ...(profile.legacyServerIds ?? []),
    ].join('\u0000')).join('\u0001');
}

function isWebRuntime(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function readTabTarget(): HomeViewTarget | null {
    if (!isWebRuntime()) return null;
    try {
        const raw = globalThis.sessionStorage?.getItem(SESSION_STORAGE_HOME_VIEW_TARGET_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const kind = parsed.kind === 'server' || parsed.kind === 'group' ? parsed.kind : null;
        const id = typeof parsed.id === 'string' ? parsed.id.trim() : '';
        return kind && id ? { kind, id } : null;
    } catch {
        return null;
    }
}

function writeTabTarget(target: HomeViewTarget | null, notify = true): void {
    if (!isWebRuntime()) return;
    try {
        const previous = readTabTarget();
        if (target) {
            if (previous?.kind === target.kind && previous.id === target.id) return;
            globalThis.sessionStorage?.setItem(SESSION_STORAGE_HOME_VIEW_TARGET_KEY, JSON.stringify(target));
        } else {
            if (!previous) return;
            globalThis.sessionStorage?.removeItem(SESSION_STORAGE_HOME_VIEW_TARGET_KEY);
        }
        effectiveStateCache = null;
        if (notify) {
            for (const listener of tabTargetListeners) listener();
        }
    } catch {
        // A session-storage failure leaves the device target authoritative.
    }
}

function targetFromState(
    state: HomeViewStateV1,
    profiles: ReturnType<typeof listServerProfiles>,
): HomeViewTarget | null {
    const id = state.activeTargetId?.trim() ?? '';
    if (!id || (state.activeTargetKind !== 'server' && state.activeTargetKind !== 'group')) return null;
    if (state.activeTargetKind === 'group' && isAllHomesSelectionTargetId(id)) {
        return listServerProfileScopeIds(profiles).length >= ALL_HOMES_MINIMUM_HOME_COUNT ? { kind: 'group', id } : null;
    }
    if (state.activeTargetKind === 'group') {
        return state.groups.some((group) => group.id === id && group.serverIds.length > 0)
            ? { kind: 'group', id }
            : null;
    }
    const scopeId = resolveServerProfileScopeIdForSelectionIdentifier(profiles, id);
    return scopeId ? { kind: 'server', id: scopeId } : null;
}

/**
 * Combines device-global group definitions/default target with this web tab's
 * routine target. This is a view over the existing owners, not another store.
 */
export function loadEffectiveHomeViewState(): HomeViewStateV1 | null {
    const deviceState = loadHomeViewState();
    if (!deviceState || !isWebRuntime()) return deviceState;
    const tabTarget = readTabTarget();
    if (!tabTarget) return deviceState;
    const profiles = listServerProfiles();
    const currentProfileScopeKey = profileScopeKey(profiles);
    const validTarget = targetFromState({
        ...deviceState,
        activeTargetKind: tabTarget.kind,
        activeTargetId: tabTarget.id,
    }, profiles);
    if (!validTarget) {
        writeTabTarget(null, false);
        return deviceState;
    }
    if (validTarget.kind !== tabTarget.kind || validTarget.id !== tabTarget.id) {
        writeTabTarget(validTarget, false);
    }
    const targetKey = `${validTarget.kind}:${validTarget.id}`;
    if (
        effectiveStateCache?.deviceState === deviceState
        && effectiveStateCache.profileScopeKey === currentProfileScopeKey
        && effectiveStateCache.targetKey === targetKey
    ) {
        return effectiveStateCache.value;
    }
    const value = {
        ...deviceState,
        activeTargetKind: validTarget.kind,
        activeTargetId: validTarget.id,
    };
    effectiveStateCache = { deviceState, profileScopeKey: currentProfileScopeKey, targetKey, value };
    return value;
}

function overlayTabTarget(deviceState: HomeViewStateV1): HomeViewStateV1 {
    const tabTarget = readTabTarget();
    if (!tabTarget) return deviceState;
    const validTarget = targetFromState({
        ...deviceState,
        activeTargetKind: tabTarget.kind,
        activeTargetId: tabTarget.id,
    }, listServerProfiles());
    return validTarget
        ? { ...deviceState, activeTargetKind: validTarget.kind, activeTargetId: validTarget.id }
        : deviceState;
}

/**
 * Group definitions are device-global; the active target is applied at the
 * requested platform scope. Non-web runtimes use the device target.
 *
 * A tab-scoped update runs the caller's updater through the canonical persisted
 * owner, against the latest device state under its browser-wide lock, so a group
 * create/rename/remove/membership/presentation edit made from a browser tab is
 * persisted device-wide without overwriting a concurrent edit from another
 * surface. The requested target is applied only to this tab: a routine browser
 * selection never rewrites the device default.
 */
export async function updateEffectiveHomeViewState(
    update: (current: HomeViewStateV1) => HomeViewStateV1,
    options: Readonly<{ scope: 'tab' | 'device' }>,
): Promise<HomeViewStateV1> {
    if (options.scope !== 'tab' || !isWebRuntime()) {
        // The canonical persisted owner invokes this updater only after acquiring
        // the browser-wide state lock and re-reading the latest device state.
        return await updateHomeViewState(update);
    }

    const tabRequest: { requested: HomeViewStateV1 | null } = { requested: null };
    const savedDeviceState = await updateHomeViewState((latestDeviceState) => {
        const requested = update(overlayTabTarget(latestDeviceState));
        tabRequest.requested = requested;
        return { ...latestDeviceState, groups: requested.groups };
    });
    if (tabRequest.requested) {
        writeTabTarget(targetFromState(
            { ...tabRequest.requested, groups: savedDeviceState.groups },
            listServerProfiles(),
        ));
    }
    return loadEffectiveHomeViewState() ?? savedDeviceState;
}

/** Show the joined session view without changing the Home used for new sessions. */
export async function selectAllHomes(options: Readonly<{ scope: 'tab' | 'device' }>): Promise<void> {
    await updateEffectiveHomeViewState((current) => ({
        ...current,
        activeTargetKind: 'group',
        activeTargetId: ALL_HOMES_SELECTION_TARGET_ID,
    }), options);
}

export function subscribeEffectiveHomeViewState(listener: () => void): () => void {
    tabTargetListeners.add(listener);
    const unsubscribeDevice = subscribeHomeViewState(() => {
        effectiveStateCache = null;
        listener();
    });
    const unsubscribeProfiles = subscribeServerProfiles(() => {
        effectiveStateCache = null;
        const currentTarget = readTabTarget();
        if (currentTarget) {
            const deviceState = loadHomeViewState();
            const validTarget = deviceState
                ? targetFromState({
                    ...deviceState,
                    activeTargetKind: currentTarget.kind,
                    activeTargetId: currentTarget.id,
                }, listServerProfiles())
                : null;
            if (!validTarget) writeTabTarget(null, false);
            else if (validTarget.kind !== currentTarget.kind || validTarget.id !== currentTarget.id) {
                writeTabTarget(validTarget, false);
            }
        }
        listener();
    });
    return () => {
        tabTargetListeners.delete(listener);
        unsubscribeDevice();
        unsubscribeProfiles();
    };
}
