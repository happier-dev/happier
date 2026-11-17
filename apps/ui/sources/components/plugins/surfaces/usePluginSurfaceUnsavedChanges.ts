import * as React from 'react';
import { PluginUiSetUnsavedChangesRequestV1Schema } from '@happier-dev/protocol/plugins/ui';

import { useDetailsTabChrome } from '@/components/appShell/panes/details/workspace/detailsTabChrome';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useUnsavedDraftNavigationGuard } from '@/utils/navigation/useUnsavedDraftNavigationGuard';
import { createPluginSurfaceHostApiError, type PluginSurfaceHostApiMethodHandler } from './createPluginSurfaceHostApi';

/** Fallback for physical mounts whose enclosing page does not supply its own dirty/history owner. */
export function usePluginSurfaceUnsavedChanges(input: Readonly<{
    scopeKey: string;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    focused: boolean;
}>) {
    const chrome = useDetailsTabChrome();
    const owner = React.useMemo(() => {
        let value = false;
        const listeners = new Set<() => void>();
        const dirty = {
            get current() { return value; },
            set current(next: boolean) {
                if (next === value) return;
                value = next;
                chrome.setUnsaved(next);
                for (const listener of listeners) listener();
            },
        };
        return { dirty, getSnapshot: () => value,
            subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
    }, [chrome, input.accountLifetime, input.scopeKey]);
    const isDirty = React.useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
    const currentOwner = React.useRef(owner);
    currentOwner.current = owner;
    const publisherIsCurrent = React.useRef<(() => boolean) | null>(null);
    const publish = React.useCallback((next: boolean) => {
        owner.dirty.current = next;
    }, [owner]);
    const clear = React.useCallback(() => publish(false), [publish]);
    const captureDecisionCurrentness = React.useCallback(() => {
        const isCurrent = publisherIsCurrent.current;
        return () => currentOwner.current === owner && isCurrent?.() !== false
            && input.accountLifetime?.isCurrent() !== false;
    }, [input.accountLifetime, owner]);
    useUnsavedDraftNavigationGuard({ navigation: null, focused: input.focused && isDirty,
        isDirty, isDirtyRef: owner.dirty, onDiscard: clear, captureDecisionCurrentness, tag: 'PluginSurfaceHost.unsavedChanges' });
    React.useLayoutEffect(() => {
        const retirement = input.accountLifetime?.onRetire(clear);
        return () => { retirement?.dispose(); clear(); };
    }, [clear, input.accountLifetime]);
    const createHandler = React.useCallback((isCurrent: () => boolean): PluginSurfaceHostApiMethodHandler => request => {
        const parsed = PluginUiSetUnsavedChangesRequestV1Schema.safeParse(request.payload);
        if (!parsed.success) return createPluginSurfaceHostApiError('invalid_payload', ['plugin_surface_unsaved_changes_invalid']);
        publisherIsCurrent.current = isCurrent;
        publish(parsed.data.isDirty);
        return {};
    }, [publish]);
    return React.useMemo(() => ({ createHandler, clear }), [clear, createHandler]);
}
