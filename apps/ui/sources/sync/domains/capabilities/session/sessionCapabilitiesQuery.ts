import * as React from 'react';
import { SessionCapabilitiesGetOutputV1Schema, type SessionCapabilitiesGetOutputV1 } from '@happier-dev/protocol/actions/specs/sessionCapabilities';
import { createSharedSubscriptionStore } from '@/sync/runtime/subscriptions/sharedSubscriptionStore';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { readServerAccountScopeOwnerLifetime, serverAccountScopedResourceKey, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { applySessionSelectionV1, type SessionCapabilityOverrideV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';

type Preview = Extract<SessionCapabilitiesGetOutputV1, { ok: true }>;
type Query = Readonly<{ preview: Preview | null; status: 'idle' | 'loading' | 'ready' | 'unavailable'; error: string | null }>;
type Input = Readonly<{ sessionId: string; lifetime: ServerAccountScopeLifetime }>;
const empty: Query = { preview: null, status: 'idle', error: null };
const execute = createFrontDoorActionExecute();

// Info and the Skills pane demand the same Session read. Closing either surface
// leaves its result/in-flight read with the Account owner, until credential retirement.
const store = createSharedSubscriptionStore<Input, Query, Query, typeof execute>({
    emptyState: empty, createState: () => empty, normalizeInput: input => input,
    storeKey: input => serverAccountScopedResourceKey(input.lifetime.scope, input.sessionId),
    defaultSnapshotClient: execute, retainState: true,
    subscribeRetirement: (input, retire) => {
        const subscription = input.lifetime.onRetire(retire);
        return () => subscription.dispose();
    },
    beginRefresh: state => ({ ...state, status: 'loading', error: null }),
    refresh: async ({ input, state, snapshotClient, signal }) => {
        const result = await snapshotClient('session.capabilities.get', { sessionId: input.sessionId }, {
            serverId: input.lifetime.scope.serverId, expectedAccountId: input.lifetime.scope.accountId,
            surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, defaultSessionId: input.sessionId, signal,
        });
        const parsed = result.ok ? SessionCapabilitiesGetOutputV1Schema.safeParse(result.result) : null;
        return parsed?.success && parsed.data.ok ? { preview: parsed.data, status: 'ready', error: null }
            : { ...state, status: 'unavailable', error: !result.ok ? result.errorCode ?? result.error
                : parsed?.success && !parsed.data.ok ? parsed.data.code : 'invalid_action_output' };
    },
    failRefresh: (state, _input, _now, error) => ({ ...state, status: 'unavailable', error: error instanceof Error ? error.message : String(error) }),
    applySnapshot: (_state, snapshot) => snapshot,
});

function useSessionCapabilitiesQueryInput(sessionId: string, binding: ServerAccountScopeLifetime | null | undefined) {
    return React.useMemo(() => binding ? { sessionId, lifetime: readServerAccountScopeOwnerLifetime(binding) } : null, [sessionId, binding]);
}

/** All Session surfaces apply current selection to the Machine owner's retained rule baseline. */
export function resolveSessionCapabilityItemSelected(
    item: Pick<Preview['skills']['items'][number], 'selected' | 'reachEnabled' | 'selectable' | 'decidedBy'> | undefined,
    override: SessionCapabilityOverrideV1,
    managedEnabled = true,
): boolean | null {
    // An explicit exclusion is known without a preview; inherit is not a synonym for Off.
    if (!item) return override === 'off' ? false : null;
    return applySessionSelectionV1({ reach: { enabled: item.reachEnabled ?? item.selected, decidedBy: item.decidedBy }, selectable: item.selectable,
        forceIncluded: override === 'on', forceExcluded: override === 'off', managedEnabled }).selected;
}

/** Passive scalar subscription: opening a transcript neither demands a preview nor reads the library. */
export function useSessionSkillSelected(sessionId: string, binding: ServerAccountScopeLifetime | null | undefined,
    skillId: string, override: SessionCapabilityOverrideV1): boolean | null {
    const input = useSessionCapabilitiesQueryInput(sessionId, binding);
    const subscribe = React.useCallback((listener: () => void) => input ? store.observe(input, listener) : () => {}, [input]);
    const read = React.useCallback(() => resolveSessionCapabilityItemSelected(
        input ? store.getState(input).preview?.skills.items.find(item => item.id === skillId) : undefined, override,
    ), [input, skillId, override]);
    return React.useSyncExternalStore(subscribe, read, read);
}

export function useSessionCapabilitiesQuery(sessionId: string, binding: ServerAccountScopeLifetime | null | undefined) {
    const input = useSessionCapabilitiesQueryInput(sessionId, binding);
    const subscribe = React.useCallback((listener: () => void) => input ? store.observe(input, listener) : () => {}, [input]);
    const read = React.useCallback(() => input ? store.getState(input) : empty, [input]);
    const query = React.useSyncExternalStore(subscribe, read, read);
    const demandPreview = React.useCallback(async () => { if (input) await store.readOnce(input); }, [input]);
    const requestedFacts = React.useRef<string | null>(null);
    React.useEffect(() => { requestedFacts.current = null; }, [input]);
    const refresh = React.useCallback(async (factsKey?: string) => {
        if (!input || typeof factsKey === 'string' && requestedFacts.current === factsKey) return;
        requestedFacts.current = factsKey ?? null;
        // A changed input or explicit Retry replaces a pending observation. Ordinary
        // surface demand above reuses it, including across navigation.
        store.reconfigure({ ...input });
        await store.read(input);
    }, [input]);
    return { ...query, demandPreview, refresh };
}
