import * as React from 'react';
import { Linking, Platform } from 'react-native';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { resolveNativeAppLinkHref } from '@/utils/url/nativeAppLink';
import { desktopHostKind } from '@/utils/platform/desktopHost';
import { usePathname } from '@/components/appShell/workspace/destinationRoute';

export type StagePluginPageExplicitHref = (href: string, lifetime?: ActiveServerAccountScopeLifetime | null) => boolean;

/** Observe explicit platform ingress, never URL restoration or route changes. */
export function usePluginPageIngress(stage: StagePluginPageExplicitHref, retireUnmatchedLocation: (href: string) => void, enabled: boolean): void {
    const stageRef = React.useRef(stage);
    stageRef.current = stage;
    // Capture the document address before a child's router layout effect can rewrite it.
    const documentHref = enabled && Platform.OS === 'web' && typeof window !== 'undefined'
        ? `${window.location.pathname}${window.location.search}` : null;
    const pathname = usePathname();
    const currentHref = documentHref ?? pathname;
    React.useEffect(() => {
        if (!enabled) return;
        // Only an address unchanged through this commit proves a departure.
        // A child layout can reconcile a temporary parent URL back to the
        // still-current source page while its replacement open is in flight.
        // Startup provenance below keeps the original document address.
        const committedHref = Platform.OS === 'web' && typeof window !== 'undefined'
            ? `${window.location.pathname}${window.location.search}` : currentHref;
        if (committedHref !== currentHref) return;
        retireUnmatchedLocation(committedHref);
    }, [currentHref, enabled, retireUnmatchedLocation]);
    React.useEffect(() => {
        if (!enabled) return;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (Platform.OS === 'web') {
            // Desktop IPC already delivers the native startup/live URL; it is
            // not a second fresh browser-document open.
            if (desktopHostKind() === 'tauri') return;
            const entry = typeof window !== 'undefined'
                ? window.performance?.getEntriesByType?.('navigation')[0] : undefined;
            if (documentHref && entry && 'type' in entry && entry.type === 'navigate') {
                stageRef.current(documentHref, lifetime);
            }
            return;
        }
        let disposed = false;
        let receivedLiveUrl = false;
        const subscription = Linking.addEventListener('url', event => {
            receivedLiveUrl = true;
            const href = resolveNativeAppLinkHref(event.url);
            if (href) stageRef.current(href);
        });
        void Linking.getInitialURL().then(url => {
            if (disposed || receivedLiveUrl || !url) return;
            const href = resolveNativeAppLinkHref(url);
            if (href) stageRef.current(href, lifetime);
        }).catch(() => {});
        return () => { disposed = true; subscription.remove(); };
        // Platform ingress is subscribed once per owning app scope. Catalog/route
        // changes reconcile the existing pending slot, not the OS startup snapshot.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled]);
}
