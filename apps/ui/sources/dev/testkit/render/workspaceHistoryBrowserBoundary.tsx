import * as React from 'react';
import { createMemoryHistory } from 'expo-router/build/fork/createMemoryHistory';

// The Expo URL mirror is a platform boundary. Workspace state, transports,
// catalog admission and the draft decision all remain production code.
const subscribers = new Set<() => void>();
const changed = () => subscribers.forEach(listener => listener());
const mirror = createMemoryHistory();
const stateForPath = (href: string): Parameters<typeof mirror.replace>[0]['state'] => ({
    key: href, index: 0, routeNames: [href], routes: [{ key: href, name: href }], type: 'stack', stale: false,
});
export const router = {
    replace: (href: string) => { mirror.replace({ path: href, state: stateForPath(href) }); changed(); },
    push: (href: string) => { mirror.push({ path: href, state: stateForPath(href) }); changed(); },
    back: () => history.back(),
    canGoBack: () => history.length > 1,
};
export const useRouter = () => router;
export function usePathname() {
    return React.useSyncExternalStore(listener => { subscribers.add(listener); return () => subscribers.delete(listener); }, () => location.pathname);
}
const emptyParams = {};
export const useGlobalSearchParams = () => emptyParams;
export const useLocalSearchParams = useGlobalSearchParams;
export const useNavigation = () => null;
export const useFocusEffect = React.useEffect;
export function installUrlMirror() {
    mirror.listen(() => {
        const record = mirror.get(mirror.index);
        // Model the Expo root reset observed in DESIGN-10 when its page-local
        // memory cannot resolve a pre-reload record. The actual SDK history
        // supplies the unknown-id/index behavior; workspace must consume it first.
        if (record?.path !== location.pathname + location.search) router.replace('/');
        else changed();
    });
}
