import * as React from 'react';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { SessionAppearanceColor } from '@/sync/domains/session/organization/appearanceColor';
import { createCustomSessionAppearanceColorsSelector, selectSessionAppearanceColor, selectEffectiveSessionAppearanceColor, selectSessionAppearancesSupported, type SessionAppearanceSelectorState } from '@/sync/store/selectors/sessionAppearance';

type SessionAppearanceHookOptions = Readonly<{ enabled?: boolean }>;
const NO_CUSTOM_COLORS: readonly `#${string}`[] = Object.freeze([]);
function useEnabledStorageSelection<T>(enabled: boolean, select: (state: SessionAppearanceSelectorState) => T, inert: T): T {
    return getStorage()(React.useCallback(state => enabled ? select(state) : inert, [enabled, inert, select]));
}

export function useSessionAppearancesSupported(serverId: string | null | undefined, options?: SessionAppearanceHookOptions): boolean {
    const select = React.useCallback((state: SessionAppearanceSelectorState) => selectSessionAppearancesSupported(state, serverId), [serverId]);
    return useEnabledStorageSelection(options?.enabled !== false, select, false);
}

export function useSessionOwnAppearanceColor(serverId: string | null | undefined, sessionId: string, options?: SessionAppearanceHookOptions): SessionAppearanceColor | null {
    const select = React.useCallback((state: SessionAppearanceSelectorState) => serverId ? selectSessionAppearanceColor(state, { serverId, sessionId }) : null, [serverId, sessionId]);
    return useEnabledStorageSelection(options?.enabled !== false, select, null);
}

export function useEffectiveSessionAppearanceColor(serverId: string | null | undefined, sessionId: string, workspaceKey?: string | null, options?: SessionAppearanceHookOptions): SessionAppearanceColor | null {
    const select = React.useCallback((state: SessionAppearanceSelectorState) => serverId ? selectEffectiveSessionAppearanceColor(state, { serverId, sessionId, workspaceKey }) : null, [serverId, sessionId, workspaceKey]);
    return useEnabledStorageSelection(options?.enabled !== false, select, null);
}

export function useCustomSessionAppearanceColors(serverId?: string | null, options?: SessionAppearanceHookOptions): readonly `#${string}`[] {
    const selector = React.useMemo(() => createCustomSessionAppearanceColorsSelector(serverId), [serverId]);
    return useEnabledStorageSelection(options?.enabled !== false, selector, NO_CUSTOM_COLORS);
}
