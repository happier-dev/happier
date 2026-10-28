import * as React from 'react';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { SessionAppearanceColor } from '@/sync/domains/session/organization/appearanceColor';
import type { SessionWorkspacePresentationMetadata } from '@/sync/domains/session/listing/sessionWorkspacePresentation';
import {
    createCustomSessionAppearanceColorsSelector,
    selectEffectiveSessionAppearanceColor,
    selectSessionAppearanceColor,
    selectSessionAppearancesSupported,
    type SessionAppearanceSelectorState,
} from '@/sync/store/selectors/sessionAppearance';

type SessionAppearanceHookOptions = Readonly<{
    /** False keeps the hook unsubscribed (a closed menu); it returns the inert value instead. */
    enabled?: boolean;
}>;

const NO_CUSTOM_COLORS: readonly `#${string}`[] = Object.freeze([]);

function subscribeToNothing(): () => void {
    return () => undefined;
}

/** Subscribes only while enabled, so always-mounted rows pay nothing until their menu opens. */
function useEnabledStorageSelection<T>(
    enabled: boolean,
    select: (state: SessionAppearanceSelectorState) => T,
    inert: T,
): T {
    const store = getStorage();
    const getSnapshot = React.useCallback(
        () => (enabled ? select(store.getState()) : inert),
        [enabled, inert, select, store],
    );
    return React.useSyncExternalStore(enabled ? store.subscribe : subscribeToNothing, getSnapshot, getSnapshot);
}

/** False until this server returns the requested sessionAppearances snapshot field. Workspace colours remain available. */
export function useSessionAppearancesSupported(serverId: string | null | undefined, options?: SessionAppearanceHookOptions): boolean {
    const select = React.useCallback((state: SessionAppearanceSelectorState) => selectSessionAppearancesSupported(state, serverId), [serverId]);
    return useEnabledStorageSelection(options?.enabled !== false, select, false);
}

/** The session's own colour (not the inherited workspace colour). Mount enabled only while its menu is open. */
export function useSessionOwnAppearanceColor(
    serverId: string | null | undefined,
    sessionId: string,
    options?: SessionAppearanceHookOptions,
): SessionAppearanceColor | null {
    const select = React.useCallback(
        (state: SessionAppearanceSelectorState) => (serverId ? selectSessionAppearanceColor(state, { serverId, sessionId }) : null),
        [serverId, sessionId],
    );
    return useEnabledStorageSelection(options?.enabled !== false, select, null);
}

/** The colour a session shows (its own, else its project's). Mount enabled only while its menu is open. */
export function useEffectiveSessionAppearanceColor(
    serverId: string | null | undefined,
    sessionId: string,
    metadata: SessionWorkspacePresentationMetadata,
    options?: SessionAppearanceHookOptions,
): SessionAppearanceColor | null {
    const select = React.useCallback(
        (state: SessionAppearanceSelectorState) => (serverId ? selectEffectiveSessionAppearanceColor(state, { serverId, sessionId, metadata }) : null),
        [metadata, serverId, sessionId],
    );
    return useEnabledStorageSelection(options?.enabled !== false, select, null);
}

/** Mount inside an open picker. Returns distinct opaque hex colours currently in use, not historical recency. */
export function useCustomSessionAppearanceColors(serverId?: string | null, options?: SessionAppearanceHookOptions): readonly `#${string}`[] {
    const selector = React.useMemo(() => createCustomSessionAppearanceColorsSelector(serverId), [serverId]);
    return useEnabledStorageSelection(options?.enabled !== false, selector, NO_CUSTOM_COLORS);
}
