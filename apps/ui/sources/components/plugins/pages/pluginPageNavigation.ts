import * as React from 'react';
import { Platform } from 'react-native';
import { usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useDestinationInstanceFacts } from '@/components/appShell/workspace/destinationInstanceContext';
import { useOptionalWorkspaceNavigation } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { openWorkspaceHrefOrElse } from '@/components/appShell/workspace/workspaceActionRuntime';
import { admitInternalRouteHref } from '@/utils/path/routeUtils';
import { readSessionRouteServerId } from '@/hooks/session/sessionRouteServerScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';

import {
    normalizePluginUiSubPathV1,
    type PluginUiInstanceKeyV1,
    type PluginUiLaunchInputV1,
} from '@happier-dev/protocol/plugins/ui';

import type {
    PluginSurfaceOpenHandler,
    PluginSurfaceOpenOutcome,
    PluginSurfaceOpenRequest,
} from '@/components/plugins/surfaces/openPluginSurface';
import {
    createPluginSurfaceDestinationOpenSurfaceHandler,
    type PluginSurfaceDestinationContainerHandler,
    type PluginSurfaceDestinationOpenResolution,
} from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import {
    buildPluginSurfaceDestinationId,
    normalizePluginSurfaceDestinationSlug,
} from '@/components/plugins/surfaces/pluginSurfaceDestinations';
import {
    isSamePluginSurfaceLaunchAuthority,
    createPluginSurfaceLaunchAuthority,
    resolveSelectedPluginSurfaceLaunchAuthority,
    type PluginSurfaceLaunchAuthority,
} from '@/components/plugins/surfaces/pluginSurfaceLaunchAuthority';
import { createPluginSurfaceLaunchInputStore } from '@/components/plugins/surfaces/pluginSurfaceLaunchInputStore';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import type {
    PluginUiProjectionModel,
    PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';
import type { PluginUiPolicyEvaluationContext } from '@/sync/domains/plugins/ui/policy';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { getPreferredLanguage } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { usePluginSurfaceWindowPresentation } from '@/components/plugins/surfaces/pluginSurfaceWindowPresentation';

import {
    usePluginPages,
    selectPluginPagePlacements,
    type PluginPage,
} from './pluginPages';
import { appendPluginPageRouteSubPath, buildPluginPageRoutePath, parsePluginAppPageRoutePath, pluginPageTargetKey, type PluginPageTarget } from './pluginPageRoute';
import { usePluginPageIngress, type StagePluginPageExplicitHref } from './pluginPageIngress';

/**
 * Host-provided navigation into a plugin page (EU-5b), and the launch input
 * that rides with it.
 *
 * The plugin calls `hostApi.openSurface(destination, input, { subPath })`; the host
 * resolves the qualified page, generates the route and pushes it onto the real
 * router. Because the location is a route and not private component state, the
 * user's back/forward walks the page's own navigation, a deep link renders the
 * same location, and returning to the page restores it — which is exactly why
 * bb's `navPanel` puts `subPath` in the URL rather than in a panel-local store.
 *
 * The launch input does NOT ride in the route: it is bounded at 8 KiB and a URL
 * is the wrong carrier for it, while the ROUTE must stay a clean, shareable,
 * host-owned path. It rides here instead — as a single pending open, handed to
 * the destination the navigation is going to and retired the moment it lands.
 */

/**
 * One open in flight: the argument of a navigation that has been started and
 * not yet delivered.
 *
 * It carries its own authority and destination because a launch input is only
 * meaningful for the exact surface it was addressed to. `input: undefined` is a
 * real, deliverable fact — an open WITHOUT an argument, which §3.7 requires to
 * REPLACE (not preserve) whatever a previous open staged.
 */
export type PluginPageLaunchOpen = Readonly<{
    target?: PluginPageTarget;
    authority: PluginSurfaceLaunchAuthority;
    /** Qualified `plugin:<pluginId>:<localId>` destination id. */
    pageId: string;
    /** Canonical plugin-local location; `''` at the page root. */
    subPath: string;
    input: PluginUiLaunchInputV1 | undefined;
    /** Ephemeral mount discriminator; never a route or persistence key. */
    instanceKey?: PluginUiInstanceKeyV1;
    /** Original explicit ingress awaiting its first admitted Account; never persisted or delivered. */
    pendingIngressHref?: string;
}>;

export type PluginPageLaunchInputQuery = Readonly<{
    target?: PluginPageTarget;
    authority: PluginSurfaceLaunchAuthority;
    pageId: string;
    subPath: string;
}>;

/**
 * The pending-open handoff between an `openSurface` call and the destination it
 * navigated to.
 *
 * It holds AT MOST ONE open, because §3.7 gives the host one selected page at a
 * time: a second open supersedes the first rather than queueing beside it. The
 * slot is emptied as soon as the destination reads it, so the value's lifetime
 * is one navigation — not the process, not the plugin id, and not the app
 * session.
 */
export type PluginPageLaunchInputStore = Readonly<{
    /** Stages only while the open's captured authority remains current. */
    stage: (open: PluginPageLaunchOpen) => boolean;
    /** The pending open for exactly this authority and location, or `null`. */
    peek: (query: PluginPageLaunchInputQuery) => PluginPageLaunchOpen | null;
    /** The open reached its destination; the handoff slot must not keep it. */
    settle: (open: PluginPageLaunchOpen) => void;
    /** Retire everything not staged under `authority` — or everything. */
    retire: (authority?: PluginSurfaceLaunchAuthority) => void;
    /** Retire a pending open unless one of these exact page authorities retains it. */
    retireOutside: (authorities: readonly PluginSurfaceLaunchAuthority[]) => void;
    /** Bind an explicit ingress once, then select only its exact admitted page occurrence. */
    resolveIngressAuthority: (authorities: PluginPageLaunchAuthorities, accountLifetime?: ActiveServerAccountScopeLifetime | null) => void;
    /** Leaving both origin and destination withdraws an undelivered open before Back can restore it. */
    retireOutsideLocation: (location: Readonly<{ pageId: string; subPath: string }> | null, href?: string) => void;
    subscribe: (listener: () => void) => () => void;
}>;

/** The route owner admits equivalent encodings before an origin is compared. */
function pageLaunchOriginKey(href: string): string {
    return JSON.stringify(parsePluginAppPageRoutePath(href) ?? href);
}

export function createPluginPageLaunchInputStore(readCurrentHref?: () => string): PluginPageLaunchInputStore {
    let pendingOriginKey: string | undefined;
    const store = createPluginSurfaceLaunchInputStore<PluginPageLaunchOpen>((open) => (
        // Page id and subpath are separately normalized by the route owner.
        // A delimiter makes their pair one exact handoff location without
        // inventing another route or persistence grammar.
        `${pluginPageTargetKey(open.target ?? { kind: 'app' })}\u0000${open.pageId}\u0000${open.subPath}`
    ));
    return Object.freeze({
        stage: (open) => {
            const previousOrigin = pendingOriginKey;
            pendingOriginKey = readCurrentHref === undefined ? undefined : pageLaunchOriginKey(readCurrentHref());
            const staged = store.stage(open);
            if (!staged) pendingOriginKey = previousOrigin;
            return staged;
        },
        peek: (query) => query.authority.occurrenceId === null ? null : store.peek({
            authority: query.authority,
            handoffKey: `${pluginPageTargetKey(query.target ?? { kind: 'app' })}\u0000${query.pageId}\u0000${query.subPath}`,
        }),
        settle: store.settle,
        retire: store.retire,
        retireOutside: store.retireOutside,
        resolveIngressAuthority: (authorities, accountLifetime) => {
            const retained = [...authorities.values()];
            store.updatePending(open => {
                // An exact staged launch can only survive its original authority;
                // a replacement occurrence or Machine must never adopt it.
                if (open.authority.occurrenceId !== null) return open;
                let lifetime = open.authority.accountLifetime;
                if (!lifetime && open.pendingIngressHref !== undefined) {
                    if (!accountLifetime) {
                        retained.push(open.authority);
                        return open;
                    }
                    if (!isExplicitIngressHomeCurrent(open.pendingIngressHref, accountLifetime)) return null;
                    lifetime = accountLifetime;
                    const { pendingIngressHref: _consumedHref, ...boundOpen } = open;
                    open = { ...boundOpen, authority: createPluginSurfaceLaunchAuthority({
                        serverId: lifetime.scope.serverId, accountLifetime: lifetime,
                    }) };
                }
                if (!lifetime?.isCurrent()) return null;
                const authority = authorities.get(open.pageId);
                if (authority) return authority.accountLifetime === lifetime ? { ...open, authority } : null;
                retained.push(open.authority);
                return open;
            });
            store.retireOutside(retained);
        },
        retireOutsideLocation: (location, href) => {
            store.updatePending(open => {
                if (location?.pageId === open.pageId && location.subPath === open.subPath) {
                    // Arrival ends the origin exemption, even if the renderer
                    // has not taken this handoff yet. Back is a real departure.
                    pendingOriginKey = undefined;
                    return open;
                }
                // Staging precedes navigation. A publication of the source
                // location during that transition has not left this open.
                return href !== undefined && pendingOriginKey === pageLaunchOriginKey(href) ? open : null;
            });
        },
        subscribe: store.subscribe,
    });
}

function isExplicitIngressHomeCurrent(href: string, lifetime: ActiveServerAccountScopeLifetime): boolean {
    if (!lifetime.isCurrent()) return false;
    const serverId = readSessionRouteServerId({
        serverId: new URL(href, 'https://internal.invalid').searchParams.get('serverId'),
    });
    return !serverId || areServerProfileIdentifiersEquivalent(serverId, lifetime.scope.serverId);
}

type PluginPageLaunchInputScopeValue = Readonly<{
    target: PluginPageTarget;
    authoritiesByPageId: PluginPageLaunchAuthorities;
    store: PluginPageLaunchInputStore;
    stageExplicitHref: StagePluginPageExplicitHref;
}>;

const PluginPageLaunchInputScopeContext = (
    React.createContext<PluginPageLaunchInputScopeValue | null>(null)
);

/**
 * The exact authority for every mounted app page. The key is the canonical
 * qualified page id; its value is sourced from that page's union contribution,
 * never from the app-scope model's coarse machine/generation roll-up.
 */
export type PluginPageLaunchAuthorities = ReadonlyMap<string, PluginSurfaceLaunchAuthority>;

/**
 * Derive launch authorities from the one canonical page catalog.
 *
 * A page needs its exact Account custody or selected Machine producer stamp.
 * This deliberately does not fall back to the app shell's ambient Machine,
 * because that could bind a bounded input to a replica the user did not select.
 */
export function resolvePluginPageLaunchAuthorities(input: Readonly<{
    pages: readonly PluginPage[];
    accountLifetime: ActiveServerAccountScopeLifetime | null;
}>): PluginPageLaunchAuthorities {
    const authorities = new Map<string, PluginSurfaceLaunchAuthority>();
    // Retirement is synchronous. Do not expose an authority during the narrow
    // interval before React remounts the successor Account's tree.
    if (input.accountLifetime && !input.accountLifetime.isCurrent()) {
        return authorities;
    }
    for (const page of input.pages) {
        const authority = resolveSelectedPluginSurfaceLaunchAuthority({
            placement: page.placement,
            accountLifetime: input.accountLifetime,
        });
        if (authority) authorities.set(page.id, authority);
    }
    return authorities;
}

/**
 * The lifecycle owner of every in-flight and delivered page launch input.
 *
 * It is mounted by the app-shell plugin projection owner, so the state lives
 * exactly as long as the authority that produced it: when the server/account,
 * the contributing machine or the projection generation changes, the value is
 * retired instead of being handed to a surface it was never addressed to, and
 * when the scope unmounts nothing survives it. A module-global map keyed by page
 * id survived all of those — which is the defect this replaces.
 *
 * Written with `createElement` rather than JSX so the whole navigation owner
 * (route building, destination resolution, staging and delivery) stays in one
 * `.ts` module instead of splitting across a second file.
 */
export function PluginPageLaunchInputScope(props: Readonly<{
    pluginUiProjection: PluginUiProjectionModel | null;
    target: PluginPageTarget;
    pages?: readonly PluginPage[];
    children: React.ReactNode;
}>): React.ReactElement {
    const pathname = usePathname();
    const pathnameRef = React.useRef(pathname);
    pathnameRef.current = pathname;
    const [store] = React.useState(() => createPluginPageLaunchInputStore(() => (
        Platform.OS === 'web' && typeof window !== 'undefined'
            ? `${window.location.pathname}${window.location.search}` : pathnameRef.current
    )));
    // This is the incumbent Account lifecycle, not a page-owned generation.
    // Capturing it here makes staging, delivery and retirement all consume the
    // same authority the destination mount will receive.
    const accountLifetime = useActiveServerAccountScopeLifetime();
    const [, refreshAfterAccountRetirement] = React.useReducer((revision: number) => revision + 1, 0);
    const pluginLocale = getPreferredLanguage();
    const localizePluginText = usePluginLocalizedTextResolver({
            projection: props.pluginUiProjection,
            locale: pluginLocale,
    });
    // A caller may build its target inline on every render; equal targets keep one identity so the context
    // value below is not republished to every shell consumer.
    const targetKey = pluginPageTargetKey(props.target);
    const stableTarget = React.useRef(props.target);
    if (pluginPageTargetKey(stableTarget.current) !== targetKey) stableTarget.current = props.target;
    const target = stableTarget.current;
    const ownPlacements = React.useMemo(() => props.pages ? [] : selectPluginPagePlacements(props.pluginUiProjection,
        { container: 'appPage', targetKind: target.kind }), [props.pages, props.pluginUiProjection, target.kind]);
    const ownPages = usePluginPages({ target,
        placements: ownPlacements,
        localize: localizePluginText,
    });
    const pages = props.pages ?? ownPages;
    React.useEffect(() => () => store.retire(), [store, targetKey]);
    // A projection that fills in page by page re-resolves every page; the same grants keep one Map, so the
    // context below is republished only when an authority really changes (or its Account lifetime retires).
    const heldAuthorities = React.useRef<PluginPageLaunchAuthorities | null>(null);
    const authoritiesByPageId = React.useMemo(() => {
        const next = resolvePluginPageLaunchAuthorities({ pages, accountLifetime });
        const held = heldAuthorities.current;
        const same = held !== null && held.size === next.size && [...next].every(([pageId, authority]) => {
            const previous = held.get(pageId);
            return previous !== undefined && isSamePluginSurfaceLaunchAuthority(previous, authority);
        });
        heldAuthorities.current = same ? held : next;
        return heldAuthorities.current;
    }, [accountLifetime, pages]);

    React.useEffect(() => {
        // A selected page origin is a full producer identity. Keep a pending
        // handoff only if that exact page authority remains selected; a union
        // machine/generation cannot retain an input for another plugin's page.
        store.resolveIngressAuthority(authoritiesByPageId, accountLifetime);
    }, [accountLifetime, authoritiesByPageId, store]);
    React.useEffect(() => {
        const retirement = accountLifetime?.onRetire(() => {
            // `onRetire` runs synchronously from the incumbent reset owner.
            // Clear the bounded handoff before the successor Account mounts,
            // then refresh the context so already-delivered input also loses
            // its stale authority on the next render. Capture can retire the
            // Account while a sibling renders; publish the React update only
            // after that render, without delaying the authority withdrawal.
            store.retire();
            queueMicrotask(refreshAfterAccountRetirement);
        });
        return () => retirement?.dispose();
    }, [accountLifetime, refreshAfterAccountRetirement, store]);
    React.useEffect(() => () => { store.retire(); }, [store]);

    const authoritiesRef = React.useRef(authoritiesByPageId);
    authoritiesRef.current = authoritiesByPageId;
    const stageExplicitHref = React.useCallback<StagePluginPageExplicitHref>((href, lifetime = captureActiveServerAccountScopeLifetime()) => {
        if (targetKey !== 'app' || (lifetime && !isExplicitIngressHomeCurrent(href, lifetime))) return false;
        const location = parsePluginAppPageRoutePath(href);
        if (!location) return false;
        const pageId = buildPluginSurfaceDestinationId(location.pluginId, location.localId);
        if (!lifetime) {
            const staged = store.stage({ target: { kind: 'app' }, authority: createPluginSurfaceLaunchAuthority({}),
                pageId, subPath: location.subPath, input: undefined, pendingIngressHref: href });
            // The OS may finish resolving its initial URL after Account admission.
            // Bind that original ingress in the same slot without replaying the OS read.
            store.resolveIngressAuthority(authoritiesRef.current, captureActiveServerAccountScopeLifetime());
            return staged;
        }
        const selected = authoritiesRef.current.get(pageId);
        // A cold URL is an explicit open under ONE current Account, not yet an
        // executable page grant. The same pending slot waits for exact admission.
        const authority = selected && selected.accountLifetime === lifetime ? selected : createPluginSurfaceLaunchAuthority({
            serverId: lifetime.scope.serverId, accountLifetime: lifetime,
        });
        return store.stage({ target: { kind: 'app' }, authority, pageId, subPath: location.subPath, input: undefined });
    }, [store, targetKey]);
    const retireUnmatchedLocation = React.useCallback((href: string) => {
        const location = parsePluginAppPageRoutePath(href);
        store.retireOutsideLocation(location ? {
            pageId: buildPluginSurfaceDestinationId(location.pluginId, location.localId), subPath: location.subPath,
        } : null, href);
    }, [store]);
    usePluginPageIngress(stageExplicitHref, retireUnmatchedLocation, targetKey === 'app');
    const value = React.useMemo(
        () => Object.freeze({ authoritiesByPageId, store, target, stageExplicitHref }),
        [authoritiesByPageId, store, target, stageExplicitHref],
    );
    return React.createElement(
        PluginPageLaunchInputScopeContext.Provider,
        { value },
        props.children,
    );
}

/** Explicit external/notification navigation joins the same page launch handoff as openSurface. */
export function usePluginPageExplicitNavigation(): (href: string) => void {
    const scope = React.useContext(PluginPageLaunchInputScopeContext);
    const router = useRouter();
    const current = React.useRef({ scope, router });
    current.current = { scope, router };
    return React.useCallback((href: string) => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        const navigate = () => {
            // A notification may have proved Account A before the existing
            // unsaved-edits guard awaited a human decision. Never lend that
            // explicit open to whichever Account is active after the decision.
            if (lifetime && !lifetime.isCurrent()) return;
            current.current.scope?.stageExplicitHref(href, lifetime);
            current.current.router.push(admitInternalRouteHref(href));
        };
        if (parsePluginAppPageRoutePath(href)) {
            fireAndForget(Promise.resolve(runGuardedNavigation(navigate)), { tag: 'plugin-page-explicit-navigation' });
        } else navigate();
    }, []);
}

/**
 * Stage the argument of one open for its destination.
 *
 * Outside a scope there is no authority to bind the value to, so staging is
 * refused rather than falling back to an unbound lifetime — the failure mode
 * this owner exists to prevent.
 */
export function usePluginPageLaunchInputStaging(): (open: Readonly<{
    target?: PluginPageTarget;
    pageId: string;
    subPath: string;
    input: PluginUiLaunchInputV1 | undefined;
    instanceKey?: PluginUiInstanceKeyV1;
}>) => boolean {
    const scope = React.useContext(PluginPageLaunchInputScopeContext);
    return React.useCallback((open) => {
        if (!scope) return false;
        if (open.target && pluginPageTargetKey(open.target) !== pluginPageTargetKey(scope.target)) return false;
        const authority = scope.authoritiesByPageId.get(open.pageId);
        if (!authority) return false;
        return scope.store.stage({ authority, ...open, target: scope.target });
    }, [scope]);
}

/**
 * The minimal catalog fact needed to activate an already-resolved app page.
 *
 * The compact catalog remains a discovery projection: it does not own page
 * lifetime, route currentness, or launch input. This adapter accepts only its
 * host-issued identity and route, then crosses the incumbent page route/launch
 * owner exactly as an input-less `openSurface` would.
 */
export type PluginPageCatalogActivation = Readonly<{
    id: string;
    routePath: string;
}>;

export type CreatePluginPageCatalogActivationHandlerInput = Readonly<{
    navigate: (routePath: string) => void;
    openWindow?: (routePath: string) => Promise<PluginSurfaceOpenOutcome>;
    stageLaunchInput: (open: Readonly<{
        pageId: string;
        subPath: string;
        input: PluginUiLaunchInputV1 | undefined;
    }>) => boolean;
}>;

/**
 * Adapts a compact catalog activation to the page launch owner.
 *
 * An already-mounted page observes catalog activation as an explicit input-less
 * open. The router owns route currentness and history: its Expo pathname mirror
 * can still name the page root after the workspace moved to a detail.
 */
export function createPluginPageCatalogActivationHandler(
    input: CreatePluginPageCatalogActivationHandlerInput,
): (destination: PluginPageCatalogActivation) => void {
    return (destination) => {
        fireAndForget(Promise.resolve(runGuardedNavigation(() => {
            // Staging can update an already-mounted editor, so it belongs
            // after the dirty decision, not merely before guarded routing.
            input.stageLaunchInput({ pageId: destination.id, subPath: '', input: undefined });
            input.navigate(destination.routePath);
        })), { tag: 'plugin-page-catalog-navigation' });
    };
}

/**
 * The single React adapter for compact app-page activation.
 *
 * It reuses the canonical launch-input staging scope and the real route owner;
 * callers cannot create a parallel route or ephemeral-input path.
 */
export function usePluginPageCatalogActivationHandler(navigate?: (routePath: string) => void): (
    destination: PluginPageCatalogActivation,
) => void {
    const router = useRouter();
    const stageLaunchInput = usePluginPageLaunchInputStaging();
    return React.useMemo(() => createPluginPageCatalogActivationHandler({
        stageLaunchInput,
        navigate: navigate ?? ((routePath) => {
            router.push(routePath as Parameters<typeof router.push>[0]);
        }),
    }), [navigate, router, stageLaunchInput]);
}

/**
 * The mounted page's launch input.
 *
 * The destination TAKES the pending open — it does not read a shared slot that
 * keeps holding it — and then holds the value itself for as long as it is the
 * same page and editor under the same authority. A location change retires
 * that editor unless the location owner settled it as preserving. That
 * is what makes the three §3.7 rules hold at once: reopening with new input
 * replaces it, an open without input clears it, and a later navigation to the
 * same location cannot inherit an argument from an earlier one.
 */
export function usePluginPageLaunch(location: Readonly<{
    pluginId: string;
    localId: string;
    subPath: string | null;
    preserveDeliveredLaunch?: boolean;
}>): PluginPageLaunchOpen | null {
    const scope = React.useContext(PluginPageLaunchInputScopeContext);
    const { localId, pluginId, subPath } = location;
    const workspace = useOptionalWorkspaceNavigation();
    const destination = useDestinationInstanceFacts();
    // A cold web Expo body can precede catalog admission, then disappear when
    // the retained workspace takes over. It is not the delivery destination.
    // Hidden retained pages likewise have no renderer to receive a new open;
    // native stack routes remain their own physical hosts.
    const canReceive = destination?.visible !== false
        && (Platform.OS !== 'web' || workspace === null || destination !== null);
    // Built from the ROUTE, through the canonical qualified-id builder, so the
    // open is also retired when the route resolves to no page at all (an
    // uninstalled, hidden or unknown destination) instead of being left pending.
    const pageId = buildPluginSurfaceDestinationId(
        pluginId.trim(),
        normalizePluginSurfaceDestinationSlug(localId),
    );
    const authority = scope?.authoritiesByPageId.get(pageId) ?? null;

    const subscribe = React.useCallback((onStoreChange: () => void) => (
        scope ? scope.store.subscribe(onStoreChange) : () => {}
    ), [scope]);
    const getSnapshot = React.useCallback(() => (
        canReceive && scope && authority && subPath !== null
            ? scope.store.peek({ authority, pageId, subPath, target: scope.target })
            : null
    ), [authority, canReceive, pageId, scope, subPath]);
    const staged = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    const [delivered, setDelivered] = React.useState<PluginPageLaunchOpen | null>(null);
    const retained = (
        canReceive
        && delivered !== null
        && scope !== null
        && authority !== null
        && subPath !== null
        && delivered.pageId === pageId
        && (delivered.subPath === subPath || location.preserveDeliveredLaunch)
        && pluginPageTargetKey(delivered.target ?? { kind: 'app' }) === pluginPageTargetKey(scope.target)
        && isSamePluginSurfaceLaunchAuthority(delivered.authority, authority)
    ) ? (delivered.subPath === subPath ? delivered : { ...delivered, subPath }) : null;
    const current = staged ?? retained;
    if (current !== delivered) {
        setDelivered(current);
    }

    React.useEffect(() => {
        if (staged !== null) scope?.store.settle(staged);
    }, [scope, staged]);

    return current;
}

/**
 * Backwards-compatible narrow view of the page launch handoff. New mount
 * adapters consume {@link usePluginPageLaunch} so the optional instance key
 * travels with the same ephemeral currentness proof as launch input.
 */
export function usePluginPageLaunchInput(location: Readonly<{
    pluginId: string;
    localId: string;
    subPath: string | null;
}>): PluginUiLaunchInputV1 | undefined {
    return usePluginPageLaunch(location)?.input;
}

export type CreatePluginPageDestinationHandlerInput = Readonly<{
    pages: readonly PluginPage[];
    navigate: (routePath: string) => void | Promise<void>;
    openWindow?: (routePath: string) => PluginSurfaceOpenOutcome | Promise<PluginSurfaceOpenOutcome>;
    stageLaunchInput: (open: Readonly<{
        target?: PluginPageTarget;
        pageId: string;
        subPath: string;
        input: PluginUiLaunchInputV1 | undefined;
        instanceKey?: PluginUiInstanceKeyV1;
    }>) => boolean;
}>;

/**
 * Compatibility constructor for tests and non-React adapters. Unlike the
 * retired local-page lookup, it accepts the complete mounted app projection and
 * delegates its exact binding decision to the shared destination resolver.
 */
export type CreatePluginPageOpenSurfaceHandlerInput = CreatePluginPageDestinationHandlerInput & Readonly<{
    target?: PluginPageTarget;
    placements: readonly PluginUiSurfacePlacementProjection[];
    accountLifetime?: ActiveServerAccountScopeLifetime | null;
    policyContext?: PluginUiPolicyEvaluationContext;
}>;

function openResolvedPluginPage(input: Readonly<{
    page: PluginPage;
    request: PluginSurfaceOpenRequest;
}> & Pick<CreatePluginPageDestinationHandlerInput, 'navigate' | 'stageLaunchInput' | 'openWindow'>): PluginSurfaceOpenOutcome | Promise<PluginSurfaceOpenOutcome> {
    const { page, request } = input;
    if (request.instanceKey !== undefined) {
        return {
            ok: false,
            code: 'invalid_payload',
            reason: 'plugin_surface_open_instance_key_unsupported',
        };
    }
    // Availability is the catalog's decision, not a second one made here.
    if (page.disabledReason) {
        return { ok: false, code: 'unavailable', reason: page.disabledReason };
    }
    // Concrete mounted requests should already have crossed the Protocol
    // request schema, but this host boundary still refuses an invalid direct
    // invocation rather than coercing it to the page root.
    const subPath = request.subPath === undefined
        ? ''
        : normalizePluginUiSubPathV1(request.subPath);
    if (subPath === null) {
        return {
            ok: false,
            code: 'invalid_payload',
            reason: 'plugin_surface_open_sub_path_invalid',
        };
    }
    const routePath = page.target.kind === 'machine' || (page.target.kind === 'app' && page.target.context)
        ? buildPluginPageRoutePath({ ...page.target, pluginId: page.pluginId, localId: page.localId, subPath })
        : appendPluginPageRouteSubPath(page.routePath, subPath);
    if (request.presentation === 'window') {
        // A new realm restores through the incumbent page fallback. Runtime
        // launch input remains one-shot in its original mounted scope.
        return input.openWindow?.(routePath) ?? {
            ok: false, code: 'unsupported_method', reason: 'plugin_surface_open_window_unsupported',
        };
    }
    let outcome: PluginSurfaceOpenOutcome = {
        ok: false, code: 'unavailable', reason: 'plugin_page_navigation_cancelled',
    };
    const admission = runGuardedNavigation(() => {
        const staged = input.stageLaunchInput({
            target: page.target,
            pageId: page.id,
            subPath,
            input: request.input,
            ...(request.instanceKey === undefined ? {} : { instanceKey: request.instanceKey }),
        });
        // A route with no launch value has the same selection contract as catalog
        // navigation. Real payloads remain bound to the exact current producer.
        if (!staged && request.input !== undefined) {
            outcome = { ok: false, code: 'unavailable', reason: 'plugin_surface_open_origin_unavailable' };
            return;
        }
        const navigation = input.navigate(routePath);
        if (navigation) return navigation.then(() => { outcome = { ok: true }; });
        outcome = { ok: true };
    });
    return admission === true ? outcome : admission.then(() => outcome);
}

export function createPluginPageOpenSurfaceHandler(
    input: CreatePluginPageOpenSurfaceHandlerInput,
): PluginSurfaceOpenHandler {
    return createPluginSurfaceDestinationOpenSurfaceHandler({
        placements: input.placements,
        targetKind: input.target?.kind ?? 'app',
        ...(input.accountLifetime === undefined ? {} : { accountLifetime: input.accountLifetime }),
        ...(input.policyContext === undefined ? {} : { policyContext: input.policyContext }),
        handlers: { appPage: createPluginPageDestinationHandler(input) },
        ...(input.openWindow ? { windowHandlers: { appPage: createPluginPageDestinationHandler(input) } } : {}),
    });
}

/**
 * Page adapter for the common qualified destination resolver.
 *
 * The resolver has already selected one exact `appPage` binding. This adapter
 * only finds that same catalog entry by projection placement identity and asks
 * the incumbent route/launch-input owner to navigate; it never retries a
 * reference lookup or chooses a different page.
 */
export function createPluginPageDestinationHandler(
    input: CreatePluginPageDestinationHandlerInput,
): PluginSurfaceDestinationContainerHandler {
    return (resolution: PluginSurfaceDestinationOpenResolution) => {
        if (resolution.placement.binding.container !== 'appPage') {
            return {
                ok: false,
                code: 'unavailable',
                reason: 'plugin_surface_open_destination_owner_unavailable',
            };
        }
        const page = input.pages.find((candidate) => candidate.placement.id === resolution.placement.id
            && candidate.target.kind === resolution.placement.binding.targetKind
            && candidate.pluginId === resolution.placement.binding.destination.pluginId
            && candidate.localId === resolution.placement.binding.destination.localId) ?? null;
        if (!page) {
            return {
                ok: false,
                code: 'unavailable',
                reason: 'plugin_surface_open_destination_unknown',
            };
        }
        return openResolvedPluginPage({ ...input, page, request: resolution.request });
    };
}

/** The route owner exposed as a container adapter for the shared resolver. */
export function usePluginPageDestinationHandler(input: Readonly<{
    pages: readonly PluginPage[];
}>): PluginSurfaceDestinationContainerHandler {
    const router = useRouter();
    const stageLaunchInput = usePluginPageLaunchInputStaging();
    const openWindow = usePluginSurfaceWindowPresentation();
    const { pages } = input;
    return React.useMemo(() => createPluginPageDestinationHandler({
        pages,
        stageLaunchInput,
        openWindow,
        // This owner also mounts above WorkspaceProvider. Its existing bridge
        // reaches the mounted workspace even while Expo still mirrors the root.
        navigate: (routePath) => openWorkspaceHrefOrElse(routePath, () => {
            router.push(routePath as Parameters<typeof router.push>[0]);
        }),
    }), [openWindow, pages, router, stageLaunchInput]);
}
