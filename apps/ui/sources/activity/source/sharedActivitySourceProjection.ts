import * as React from 'react';

import { storage } from '@/sync/domains/state/storageStore';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ActiveServerSnapshot } from '@/sync/domains/server/serverProfiles';
import type { StorageState } from '@/sync/store/types';

import type { ActivityAttentionSource } from './activityAttentionSourceTypes';
import type { ActivityPersonalSessionMembership } from './activityPersonalSessionMembership';
import { useActivityBoundaryRefresh } from './useActivityBoundaryRefresh';
import {
    createActivityAttentionSourceSelector,
    useActivityActiveServer,
    useActivityRuleAudienceScopes,
} from './useActivityAttentionSource';
import { useActivityPersonalSessionMembership } from './activityPersonalSessionMembership';

/** One projection input: the summary source with its rule audience scopes, the instant, and the store state. */
export type ActivitySourceProjectionInput = Readonly<{
    source: ActivityAttentionSource;
    nowMs: number;
    state: StorageState;
}>;

type Projected = Readonly<{ nextAttentionBoundaryMs: number | null }>;

/**
 * A projector may keep state between calls (a per-address table); it is created once per shared
 * projection and again after a freshness boundary, so a boundary always re-projects completely.
 */
export type ActivitySourceProjector<T extends Projected> = Readonly<{
    /** Called when the source moved. */
    project: (input: ActivitySourceProjectionInput) => T;
    /** Called for a publication the source owner found nothing in, so a changed-id reader keeps its revision. */
    observeUnchangedSource?: (state: StorageState) => void;
}>;

export type ActivitySourceProjectorFactory<T extends Projected> = () => ActivitySourceProjector<T>;

type SharedProjection<T extends Projected> = {
    consumers: number;
    select: (state: StorageState) => T;
    /** A freshness boundary of the published value elapsed: the next read re-projects at the new instant. */
    expire: (boundaryMs: number) => void;
};

type Inputs = Readonly<{
    membership: ActivityPersonalSessionMembership;
    activeServer: ActiveServerSnapshot;
    audienceScopes: ReadonlyMap<string, ServerAccountScope>;
}>;

/** How a shared projection learns that its source moved; see `createActivityAttentionSourceSelector`. */
export type ActivitySourceChangeDetection = 'signature' | 'identity';

// Every mounted consumer of the same projection with the same inputs reads one selector, one source
// signature and one projection per store publication, instead of one each.
const sharedByMembership = new WeakMap<ActivityPersonalSessionMembership,
    WeakMap<ActiveServerSnapshot, Map<string, Map<ActivitySourceProjectorFactory<Projected>, SharedProjection<Projected>>>>>();

function audienceScopesKey(scopes: ReadonlyMap<string, ServerAccountScope>): string {
    return JSON.stringify([...scopes].map(([home, scope]) => [home, scope.serverId, scope.accountId]).sort());
}

function createSharedProjection<T extends Projected>(inputs: Inputs, createProjector: ActivitySourceProjectorFactory<T>,
    retain: (previous: T | undefined, next: T) => T, changeDetection: ActivitySourceChangeDetection): SharedProjection<T> {
    const selectSource = createActivityAttentionSourceSelector({
        personalMembership: inputs.membership, activeServer: inputs.activeServer, includeSessionMessages: false, changeDetection,
    });
    let projector = createProjector();
    let previousState: StorageState | undefined;
    let previousSelected: ActivityAttentionSource | undefined;
    let source: ActivityAttentionSource | undefined;
    let published: T | undefined;
    let expired = false;
    return {
        consumers: 0,
        select(state) {
            if (published && !expired && previousState === state) return published;
            previousState = state;
            const selected = selectSource(state);
            if (expired) {
                expired = false;
                projector = createProjector();
            } else if (published && previousSelected === selected) {
                projector.observeUnchangedSource?.(state);
                return published;
            }
            if (!source || previousSelected !== selected) source = { ...selected, audienceScopes: inputs.audienceScopes };
            previousSelected = selected;
            published = retain(published, projector.project({ source, nowMs: Date.now(), state }));
            return published;
        },
        expire(boundaryMs) {
            if (published?.nextAttentionBoundaryMs === boundaryMs) expired = true;
        },
    };
}

function sharedProjectionsFor(inputs: Inputs) {
    let byServer = sharedByMembership.get(inputs.membership);
    if (!byServer) sharedByMembership.set(inputs.membership, byServer = new WeakMap());
    let byScopes = byServer.get(inputs.activeServer);
    if (!byScopes) byServer.set(inputs.activeServer, byScopes = new Map());
    const scopesKey = audienceScopesKey(inputs.audienceScopes);
    let byProjector = byScopes.get(scopesKey);
    if (!byProjector) byScopes.set(scopesKey, byProjector = new Map());
    return byProjector;
}

function acquireSharedProjection<T extends Projected>(inputs: Inputs, createProjector: ActivitySourceProjectorFactory<T>,
    retain: (previous: T | undefined, next: T) => T, changeDetection: ActivitySourceChangeDetection): SharedProjection<T> {
    const byProjector = sharedProjectionsFor(inputs);
    let shared = byProjector.get(createProjector as ActivitySourceProjectorFactory<Projected>) as SharedProjection<T> | undefined;
    if (!shared) {
        shared = createSharedProjection(inputs, createProjector, retain, changeDetection);
        byProjector.set(createProjector as ActivitySourceProjectorFactory<Projected>, shared as SharedProjection<Projected>);
    }
    return shared;
}

/** A mounted consumer keeps its projection registered (again, after a remount released it). */
function retainSharedProjection(inputs: Inputs, createProjector: ActivitySourceProjectorFactory<Projected>, shared: SharedProjection<Projected>): void {
    const byProjector = sharedProjectionsFor(inputs);
    if (!byProjector.has(createProjector)) byProjector.set(createProjector, shared);
    shared.consumers += 1;
}

function releaseSharedProjection(inputs: Inputs, createProjector: ActivitySourceProjectorFactory<Projected>, shared: SharedProjection<Projected>): void {
    shared.consumers -= 1;
    if (shared.consumers > 0) return;
    const byScopes = sharedByMembership.get(inputs.membership)?.get(inputs.activeServer);
    const scopesKey = audienceScopesKey(inputs.audienceScopes);
    const byProjector = byScopes?.get(scopesKey);
    if (!byScopes || !byProjector || byProjector.get(createProjector) !== shared) return;
    byProjector.delete(createProjector);
    if (byProjector.size === 0) byScopes.delete(scopesKey);
}

/**
 * The summary attention source projected once per publication for every mounted consumer of the same
 * `createProjector` (a module-scope factory, or a stable callback for a consumer-specific projection).
 * `retain` keeps the previous value while it reads the same, so a Session row write that changes nothing
 * projected renders no consumer; a freshness boundary re-projects at the new instant. `presented: false`
 * (a hidden retained surface) holds the last value and reads nothing. A projector that follows the
 * store's changed-id publication itself uses `identity` change detection, so no publication signs the
 * whole corpus; the same factory is always used with the same mode.
 */
export function useSharedActivitySourceProjection<T extends Projected, R extends Projected = T>(
    createProjector: ActivitySourceProjectorFactory<T>,
    retain: (previous: T | undefined, next: T) => T,
    options: Readonly<{
        presented?: boolean;
        changeDetection?: ActivitySourceChangeDetection;
        /** A consumer's own reading of the shared value (stable); returning the previous value renders nothing. */
        pick?: (value: T) => R;
    }> = {},
): R {
    const presented = options.presented !== false;
    const changeDetection = options.changeDetection ?? 'signature';
    const pick = options.pick;
    const [boundaryVersion, advanceBoundary] = React.useReducer((value: number) => value + 1, 0);
    const membership = useActivityPersonalSessionMembership();
    const activeServer = useActivityActiveServer();
    const audienceScopes = useActivityRuleAudienceScopes();
    const inputs = React.useMemo<Inputs>(() => ({ membership, activeServer, audienceScopes }), [activeServer, audienceScopes, membership]);
    const shared = React.useMemo(() => acquireSharedProjection(inputs, createProjector, retain, changeDetection),
        [changeDetection, createProjector, inputs, retain]);
    React.useEffect(() => {
        retainSharedProjection(inputs, createProjector as ActivitySourceProjectorFactory<Projected>, shared as SharedProjection<Projected>);
        return () => releaseSharedProjection(inputs, createProjector as ActivitySourceProjectorFactory<Projected>,
            shared as SharedProjection<Projected>);
    }, [createProjector, inputs, shared]);
    const held = React.useRef<R | undefined>(undefined);
    // `boundaryVersion` re-creates the reader, so the store re-reads after `expire` even without a publication.
    const select = React.useMemo(() => (state: StorageState): R => {
        if (!presented && held.current) return held.current;
        const value = shared.select(state);
        return pick ? pick(value) : value as unknown as R;
    }, [boundaryVersion, pick, presented, shared]);
    const value = storage(select);
    if (presented) held.current = value;
    const boundaryMs = presented ? value.nextAttentionBoundaryMs : null;
    const refresh = React.useCallback(() => {
        if (boundaryMs !== null) shared.expire(boundaryMs);
        advanceBoundary();
    }, [boundaryMs, shared]);
    useActivityBoundaryRefresh(boundaryMs, refresh);
    return value;
}
