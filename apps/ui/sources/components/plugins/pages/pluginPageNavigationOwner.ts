import { PluginUiSetPageNavigationRequestV1Schema, type PluginUiPageNavigationV1 } from '@happier-dev/protocol/plugins/ui/pageNavigation';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { createPluginSurfaceHostApiError } from '@/components/plugins/surfaces/createPluginSurfaceHostApi';

/** The physical page mount lends a declaration; only its controlled value can select chrome. */
export function createPluginPageNavigationOwner() {
    type Snapshot = Readonly<{ navigation: PluginUiPageNavigationV1 | null; request: string | null }>;
    let snapshot: Snapshot = { navigation: null, request: null };
    const listeners = new Set<() => void>();
    const update = (next: Snapshot) => {
        if (snapshot.navigation === next.navigation && snapshot.request === next.request) return;
        snapshot = next;
        for (const listener of listeners) listener();
    };
    return {
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        clear: () => update({ navigation: null, request: null }),
        setPageNavigation: (payload: unknown) => {
            const parsed = PluginUiSetPageNavigationRequestV1Schema.safeParse(payload);
            if (!parsed.success) return createPluginSurfaceHostApiError('invalid_payload', ['plugin_page_navigation_invalid']);
            const previous = snapshot.navigation;
            const next = parsed.data.navigation;
            // A rejected request republishes an unchanged declaration. Keep its
            // catalog identity so settlement does not resolve M1 or placements again.
            const navigation = sameStrictJsonValue(previous, next) ? previous : next && previous
                && sameStrictJsonValue(previous.items, next.items) ? { ...next, items: previous.items } : next;
            update({ navigation, request: null });
            return {};
        },
        select: (value: string) => {
            if (value === snapshot.navigation?.value) return;
            update({ navigation: snapshot.navigation, request: value });
        },
    };
}
