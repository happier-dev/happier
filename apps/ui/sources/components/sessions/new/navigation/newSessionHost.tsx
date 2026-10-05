import * as React from 'react';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';

import type { ProviderBoundModelRef } from '@happier-dev/protocol';
import type { DaemonProviderModelProjectionResponseV1 } from '@happier-dev/protocol/rpc';
import type { ModelOption } from '@/sync/domains/models/modelOptions';

import type { PermissionMode } from '@/constants/PermissionModes';
import type { SessionSpawnNewActionExecutor } from '@/sync/ops/actions/sessionSpawnNewAction';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

/**
 * Where the one New Session surface lives.
 *
 * The `/new` route hosts it on its own route: its params are the route's params and a draft
 * change is a navigation. Home embeds the same surface (same model, same composer) inside its
 * page: there the params are the embedding host's local state, a draft change swaps that state,
 * and handing off to the created session pushes it so Home stays in history.
 *
 * Every New Session reader and writer of "route params" goes through this seam, so the model
 * never learns which host it is in beyond `embedded`.
 */
export type NewSessionHostParams = Readonly<Record<string, string | string[] | undefined>>;

export type NewSessionHostDraftEntry = Readonly<{ draftId: string; draftOrigin: 'ordinary' | null }>;

export type NewSessionEmbeddedHost = Readonly<{
    params: NewSessionHostParams;
    /** Merges into the host's params; `undefined` clears a key, as `router.setParams` does. */
    setParams: (patch: Readonly<Record<string, unknown>>) => void;
    /** Opens another draft in place of the current one (start another, delete). */
    openDraft: (entry: NewSessionHostDraftEntry) => void;
    /** The surface handed its draft to a destination (the created session). */
    onHandedOff: (destination: Parameters<ReturnType<typeof useRouter>['push']>[0]) => void;
    /**
     * Whether the person has shown intent to use the embedded composer (focus, hover, press).
     * Until then its closed chips and pickers issue no machine RPCs.
     */
    demanded: boolean;
    /**
     * A host that creates the Session itself (the embed's new chat): Send spawns through this
     * executor instead of the app's Action executor, with the same launch attempt, custody and
     * retry. Absent, the app spawns.
     */
    executeSpawnAction?: SessionSpawnNewActionExecutor;
    /**
     * `inPlace`: handing off to the created Session navigates nowhere — the host presents it in
     * the same place (`onHandedOff`). Default `push`: the created Session's route is pushed.
     */
    createdSessionPresentation?: 'push' | 'inPlace';
    /**
     * A host that fixes part of the creation (the embed's new chat): the composer offers only what
     * the profile allows and hides the pickers it decides. Narrowing only; the grant enforces.
     */
    creationProfile?: NewSessionCreationProfile;
}>;

export type NewSessionCreationProfile = Readonly<{
    /** The authenticated host's document scope when it has no Account login. */
    draftScope?: ServerAccountScope;
    /** The host binds the machine: no machine, profile or resume picker. */
    hostBindsMachine: true;
    /** The injected creation executor's bound target, independent of Account machine records. */
    machineId?: string;
    /** A fixed agent (its backend target key): the agent picker is hidden. */
    agentTargetKey?: string;
    /** `null`/absent: no extra narrowing. Otherwise only these models are offered. */
    allowedModels?: readonly ProviderBoundModelRef[] | null;
    /** Admitted host catalog; a restricted child does not probe the Account's machine inventory. */
    modelCatalog?: Readonly<{
        nativeModels: readonly ModelOption[];
        providerProjection: Extract<DaemonProviderModelProjectionResponseV1, { status: 'success' }> | null;
    }>;
    /** Coerced to the first listed mode; offered as a choice only with two or more. */
    permissionModes?: readonly PermissionMode[] | null;
    /** Default `true`. */
    attachments?: boolean;
}>;

const NewSessionEmbeddedHostContext = React.createContext<NewSessionEmbeddedHost | null>(null);

export function NewSessionEmbeddedHostProvider(props: Readonly<{
    host: NewSessionEmbeddedHost;
    children: React.ReactNode;
}>): React.ReactElement {
    return (
        <NewSessionEmbeddedHostContext.Provider value={props.host}>
            {props.children}
        </NewSessionEmbeddedHostContext.Provider>
    );
}

export function useNewSessionEmbeddedHost(): NewSessionEmbeddedHost | null {
    return React.useContext(NewSessionEmbeddedHostContext);
}

/** The New Session params: the `/new` route's own, or the embedding host's. */
export function useNewSessionHostParams<T extends object = NewSessionHostParams>(): T {
    const routeParams = useLocalSearchParams();
    const host = React.useContext(NewSessionEmbeddedHostContext);
    return (host ? host.params : routeParams) as T;
}

/** The embedding host's creation profile, when it fixes part of the creation. */
export function useNewSessionHostCreationProfile(): NewSessionCreationProfile | undefined {
    return React.useContext(NewSessionEmbeddedHostContext)?.creationProfile;
}

/** The embedding host's own Session-creation executor, when it has one. */
export function useNewSessionHostSpawnExecutor(): SessionSpawnNewActionExecutor | undefined {
    return React.useContext(NewSessionEmbeddedHostContext)?.executeSpawnAction;
}

/** Route-mode surfaces always have intent (the person opened them); embedded ones wait for it. */
export function useNewSessionHostDemanded(): boolean {
    const host = React.useContext(NewSessionEmbeddedHostContext);
    return host ? host.demanded : true;
}

type RouterLike = ReturnType<typeof useRouter>;
function useDefaultNavigation() {
    return useNavigation();
}
type NavigationLike = ReturnType<typeof useDefaultNavigation>;

type SetParamsAction = Readonly<{
    type?: unknown;
    source?: unknown;
    payload?: Readonly<{ params?: Readonly<Record<string, unknown>> }>;
}>;

function isOwnSetParamsAction(action: unknown): action is SetParamsAction {
    if (!action || typeof action !== 'object') return false;
    const candidate = action as SetParamsAction;
    return candidate.type === 'SET_PARAMS' && candidate.source === undefined;
}

/**
 * The router and navigation the New Session surface acts through. On `/new` these are the real
 * route objects, unchanged. Embedded, param writes land in the host, and `replace` — which the
 * surface uses only to hand its draft to the created session — pushes the destination instead,
 * so the embedding page stays behind it, then tells the host its draft left.
 */
export function useNewSessionHostNavigation(): Readonly<{
    embedded: boolean;
    router: RouterLike;
    navigation: NavigationLike;
    openDraft: (entry: NewSessionHostDraftEntry, mode: 'push' | 'replace') => void;
}> {
    const router = useRouter();
    const navigation = useDefaultNavigation();
    const host = React.useContext(NewSessionEmbeddedHostContext);
    const setParams = host?.setParams;
    const openHostDraft = host?.openDraft;
    const onHandedOff = host?.onHandedOff;
    const presentsInPlace = host?.createdSessionPresentation === 'inPlace';

    return React.useMemo(() => {
        if (!setParams || !openHostDraft || !onHandedOff) {
            return {
                embedded: false,
                router,
                navigation,
                openDraft: (entry: NewSessionHostDraftEntry, mode: 'push' | 'replace') => {
                    const href = {
                        pathname: '/new' as const,
                        params: { draftId: entry.draftId, ...(entry.draftOrigin ? { draftOrigin: entry.draftOrigin } : {}) },
                    };
                    if (mode === 'replace') router.replace(href);
                    else router.push(href);
                },
            };
        }
        const embeddedRouter = {
            ...router,
            setParams: (patch: Readonly<Record<string, unknown>>) => setParams(patch ?? {}),
            push: ((href: Parameters<RouterLike['push']>[0], options?: Parameters<RouterLike['push']>[1]) => {
                // Preflight machine links must not navigate an in-place chat into the app shell.
                if (!presentsInPlace) router.push(href, options);
            }) as RouterLike['push'],
            replace: ((href: Parameters<RouterLike['push']>[0], options?: Parameters<RouterLike['push']>[1]) => {
                if (!presentsInPlace) router.push(href, options);
                onHandedOff(href);
            }) as RouterLike['replace'],
        } as RouterLike;
        const embeddedNavigation = {
            ...(navigation ?? {}),
            setParams: (patch: Readonly<Record<string, unknown>>) => setParams(patch ?? {}),
            dispatch: (action: unknown) => {
                if (isOwnSetParamsAction(action)) {
                    setParams(action.payload?.params ?? {});
                    return;
                }
                (navigation as unknown as { dispatch?: (value: unknown) => void } | null)?.dispatch?.(action);
            },
            // Nothing to go back to inside a page: the embedding page is not this surface's route.
            canGoBack: () => false,
            goBack: () => undefined,
        } as unknown as NavigationLike;
        return {
            embedded: true,
            router: embeddedRouter,
            navigation: embeddedNavigation,
            openDraft: (entry: NewSessionHostDraftEntry) => openHostDraft(entry),
        };
    }, [navigation, onHandedOff, openHostDraft, presentsInPlace, router, setParams]);
}

/** Applies a `router.setParams`-style patch: `undefined` removes a key. */
export function mergeNewSessionHostParams(
    current: NewSessionHostParams,
    patch: Readonly<Record<string, unknown>>,
): NewSessionHostParams {
    let changed = false;
    const next: Record<string, string | string[] | undefined> = { ...current };
    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || value === null) {
            if (key in next) {
                delete next[key];
                changed = true;
            }
            continue;
        }
        const normalized = Array.isArray(value) ? value.map(String) : String(value);
        const previous = next[key];
        const same = Array.isArray(normalized)
            ? Array.isArray(previous) && previous.length === normalized.length && previous.every((entry, index) => entry === normalized[index])
            : previous === normalized;
        if (!same) {
            next[key] = normalized;
            changed = true;
        }
    }
    return changed ? next : current;
}
