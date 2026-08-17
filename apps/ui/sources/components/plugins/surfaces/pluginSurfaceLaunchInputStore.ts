import {
    isSamePluginSurfaceLaunchAuthority,
    type PluginSurfaceLaunchAuthority,
} from './pluginSurfaceLaunchAuthority';

/**
 * One bounded handoff slot between an admitted `openSurface` producer and the
 * host destination it selected. The route and Details workspace own separate
 * lifecycle scopes, but both use this same currentness/retirement owner rather
 * than inventing placement-local launch storage.
 */
export type PluginSurfaceLaunchInputStore<TLaunch extends Readonly<{
    authority: PluginSurfaceLaunchAuthority;
}>> = Readonly<{
    /** Stages only while the captured Account authority is still current. */
    stage: (launch: TLaunch) => boolean;
    /** Reads the one pending handoff addressed to an exact authority/key pair. */
    peek: (query: Readonly<{
        authority: PluginSurfaceLaunchAuthority;
        handoffKey: string;
    }>) => TLaunch | null;
    /** Transfers one exact pending record to its destination. */
    settle: (launch: TLaunch) => void;
    /** Retires the pending value unless it belongs to the supplied authority. */
    retire: (authority?: PluginSurfaceLaunchAuthority) => void;
    /** Retires the pending value unless one exact authority still owns it. */
    retireOutside: (authorities: readonly PluginSurfaceLaunchAuthority[]) => void;
    /**
     * Removes a stale pending record for one host destination without touching
     * a current handoff addressed to a different destination.
     */
    retireHandoffIfAuthorityChanged: (query: Readonly<{
        authority: PluginSurfaceLaunchAuthority | null;
        handoffKey: string;
    }>) => void;
    subscribe: (listener: () => void) => () => void;
}>;

/**
 * The key remains an owner-level identity supplied by the route/pane adapter.
 * It is deliberately not derived from launch input, which is opaque payload
 * rather than durable or mount identity.
 */
export function createPluginSurfaceLaunchInputStore<TLaunch extends Readonly<{
    authority: PluginSurfaceLaunchAuthority;
}>>(handoffKeyFor: (launch: TLaunch) => string): PluginSurfaceLaunchInputStore<TLaunch> {
    let pending: TLaunch | null = null;
    const listeners = new Set<() => void>();

    const notify = (): void => {
        for (const listener of [...listeners]) listener();
    };

    const retireOutside = (authorities: readonly PluginSurfaceLaunchAuthority[]): void => {
        if (!pending) return;
        if (authorities.some((authority) => isSamePluginSurfaceLaunchAuthority(pending!.authority, authority))) {
            return;
        }
        pending = null;
        notify();
    };

    return Object.freeze({
        stage: (launch) => {
            // Account retirement is synchronous. Refuse a late producer before
            // it can retain opaque input for the successor Account.
            if (launch.authority.accountLifetime?.isCurrent() === false) return false;
            pending = Object.freeze({ ...launch }) as TLaunch;
            notify();
            return true;
        },
        peek: (query) => {
            if (!pending) return null;
            return handoffKeyFor(pending) === query.handoffKey
                && isSamePluginSurfaceLaunchAuthority(pending.authority, query.authority)
                ? pending
                : null;
        },
        settle: (launch) => {
            // Identity, not equality: settling a superseded open must never
            // discard the record that replaced it.
            if (pending !== launch) return;
            pending = null;
            notify();
        },
        retire: (authority) => {
            retireOutside(authority ? [authority] : []);
        },
        retireOutside,
        retireHandoffIfAuthorityChanged: (query) => {
            if (!pending || handoffKeyFor(pending) !== query.handoffKey) return;
            if (
                query.authority
                && isSamePluginSurfaceLaunchAuthority(pending.authority, query.authority)
            ) return;
            pending = null;
            notify();
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
    });
}
