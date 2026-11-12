import * as React from 'react';
import type { RegistryActionIdV1, RegistrySourceStatusV1, REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/registries';
import { REGISTRY_ITEMS_LIST_ACTION_ID_V1, REGISTRY_ITEMS_READ_ACTION_ID_V1 } from '@happier-dev/protocol/registries/registryActionIdsV1';
import { type RegistryFailureStatus } from './describeRegistrySourceStatus';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { invalidateUiRegistryItemMemoV1, invalidateUiRegistryUpdateMemoV1, invalidateUiRegistrySourcesMemoV1, useRegistryCarrierRecovery } from './registryHostDeps';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useStoreActionTarget } from '@/components/settings/plugins/model/useStoreMachineScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import { RegistryActionFailure } from './registryActionFailure';

/** Reads share the mounted approval/currentness owner and retain last-known data during refresh. */
export function useRegistryActionRead<T, K extends RegistryActionIdV1>(actionId: K, input: unknown,
    parse: (value: ReturnType<(typeof REGISTRY_ACTION_OUTPUT_SCHEMAS_V1)[K]['parse']>, previous: T | null) => T, revision?: unknown, enabled = true,
    recovery?: Readonly<{ resolving?: boolean; sourceIds?: readonly string[]; installMachineId?: string | null; scope?: ServerAccountScope;
        failures?: (value: T | null) => readonly Readonly<{ sourceId: string; status: RegistrySourceStatusV1 }>[] }>): {
    scopeKey: string;
    inputKey: string;
    revision: unknown;
    value: T | null;
    error: string | null;
    status: RegistryFailureStatus | null;
    loading: boolean;
    stale: boolean;
    refresh: () => Promise<void>;
    execution: ReturnType<typeof useMountedActionExecution>;
    scope: ReturnType<typeof useAccountSettingsScope>;
    externalActionTarget: ReturnType<typeof useStoreActionTarget>;
} {
    const presented = useLayoutPresentationActive();
    enabled = enabled && presented;
    const demand = React.useRef(enabled);
    demand.current = enabled;
    const activeScope = useAccountSettingsScope();
    const scope = recovery?.scope ?? activeScope;
    const externalActionTarget = useStoreActionTarget(recovery?.installMachineId,
        actionId === REGISTRY_ITEMS_LIST_ACTION_ID_V1 || actionId === REGISTRY_ITEMS_READ_ACTION_ID_V1, recovery?.scope);
    const execution = useMountedActionExecution(scope);
    const scopeKey = JSON.stringify([scope?.serverId, scope?.accountId, externalActionTarget]);
    const inputKey = JSON.stringify(input);
    const args = React.useMemo(() => JSON.parse(inputKey) as unknown, [inputKey]);
    const parser = React.useRef(parse);
    parser.current = parse;
    const recoveryOptions = React.useRef(recovery);
    recoveryOptions.current = recovery;
    const [state, setState] = React.useState<{ scopeKey: string; inputKey: string; revision: unknown; value: T | null; loading: boolean; error: string | null; status: RegistryFailureStatus | null }>({
        scopeKey, inputKey, revision, value: null, loading: enabled, error: null, status: null,
    });
    const latest = React.useRef(state);
    latest.current = state;
    const generation = React.useRef(0);
    const pending = React.useRef<AbortController | null>(null);
    const load = React.useCallback(async (force: boolean) => {
        pending.current?.abort();
        const request = ++generation.current;
        if (!demand.current || !execution.ready || recovery?.resolving) return;
        const controller = new AbortController();
        pending.current = controller;
        const previous = latest.current;
        // Reopening a failed read is a natural recovery boundary, just like Try again.
        // Healthy reads keep their memo; outages do not start an automatic retry loop.
        if (previous.scopeKey === scopeKey && previous.inputKey === inputKey && Object.is(previous.revision, revision)) {
            const retryable = (status: RegistrySourceStatusV1 | null) => status?.state === 'needs_machine' || status?.state === 'unreachable';
            // Listing pages retain admitted failures until explicit Retry, without
            // forcing healthy siblings to fetch again on navigation.
            force ||= actionId !== REGISTRY_ITEMS_LIST_ACTION_ID_V1 && (retryable(previous.status)
                || Boolean(recoveryOptions.current?.failures?.(previous.value).some(page => retryable(page.status))));
        }
        if (force && actionId === 'registries.items.read' && scope) invalidateUiRegistryItemMemoV1(scope, args);
        if (force && actionId === 'registries.updates.check' && scope) invalidateUiRegistryUpdateMemoV1(scope, args);
        if (force && actionId === 'registries.sources.list' && scope) invalidateUiRegistrySourcesMemoV1(scope, args);
        setState(previous => {
            // A source-list revision refreshes descriptors, not their Account authority. Keep this exact
            // list mounted (including mutation receipts); item reads still withdraw on source changes.
            const sameAuthority = previous.scopeKey === scopeKey && (Object.is(previous.revision, revision)
                || (actionId === 'registries.sources.list' && previous.inputKey === inputKey));
            return { scopeKey, revision: sameAuthority ? previous.revision : revision, inputKey: sameAuthority ? previous.inputKey : inputKey,
                value: sameAuthority ? previous.value : null, loading: true, error: null, status: null };
        });
        try {
            const value = force && actionId === 'registries.items.list' && args && typeof args === 'object'
                ? { ...args, refresh: true } : args;
            const result = await execution.execute(actionId, value, { signal: controller.signal, externalActionTarget });
            if (request !== generation.current || !execution.isCurrent()) return;
            if (!result.ok) throw new RegistryActionFailure(result);
            // The registry protocol host already validated this same-process Action result.
            const parsed = parser.current(result.result as ReturnType<(typeof REGISTRY_ACTION_OUTPUT_SCHEMAS_V1)[K]['parse']>, previous.scopeKey === scopeKey && previous.inputKey === inputKey
                && Object.is(previous.revision, revision) ? previous.value : null);
            setState(previous => ({ scopeKey, inputKey, revision, value: previous.scopeKey === scopeKey && Object.is(previous.revision, revision)
                && sameStrictJsonValue(previous.value, parsed)
                ? previous.value : parsed, loading: false, error: null, status: null }));
        } catch (error) {
            if (request !== generation.current || !execution.isCurrent()) return;
            setState(previous => {
                const sameAuthority = previous.scopeKey === scopeKey && (Object.is(previous.revision, revision)
                    || (actionId === 'registries.sources.list' && previous.inputKey === inputKey));
                return { scopeKey, revision: sameAuthority ? previous.revision : revision, inputKey: sameAuthority ? previous.inputKey : inputKey,
                    value: sameAuthority ? previous.value : null, loading: false,
                    error: error instanceof Error ? error.message : 'registry_unavailable',
                    status: error instanceof RegistryActionFailure ? error.status : null };
            });
        } finally { if (pending.current === controller) pending.current = null; }
    }, [actionId, args, enabled, execution.execute, execution.isCurrent, execution.ready, scopeKey, scope, inputKey, revision, externalActionTarget, recovery?.resolving]);
    const refresh = React.useCallback(() => load(true), [load]);
    // The per-source host retries needs_machine pages on a normal read. Only
    // the person's Retry bypasses healthy source memos.
    const recover = React.useCallback(() => load(false), [load]);
    React.useEffect(() => {
        void load(false);
        return () => { generation.current += 1; pending.current?.abort(); };
    }, [load, revision]);
    const current = state.scopeKey === scopeKey && (Object.is(state.revision, revision)
        || (actionId === 'registries.sources.list' && state.inputKey === inputKey))
        ? state : { scopeKey, inputKey, revision, value: null, loading: enabled, error: null, status: null };
    const failedSources = recovery?.failures?.(current.value).filter(page => page.status.state === 'needs_machine').map(page => page.sourceId) ?? [];
    useRegistryCarrierRecovery(execution.ready && (current.status?.state === 'needs_machine' || failedSources.length > 0), recover, scope,
        current.status?.state === 'needs_machine' ? recovery?.sourceIds : failedSources, enabled && !current.loading, externalActionTarget);
    // Credential retirement precedes the Sync store's next Account projection.
    // Never disclose that previous projection through an unbound mounted caller.
    const stale = current.inputKey !== inputKey || !Object.is(current.revision, revision);
    const answered = current.value !== null || current.error !== null;
    return { ...current, value: execution.ready ? current.value : null, error: execution.ready ? current.error : null,
        status: execution.ready ? current.status : null,
        // A demanded read that has not answered is still loading: the render between demand and its effect never settles empty.
        loading: enabled && (recovery?.resolving || current.loading || !execution.ready || !answered || stale && current.error === null),
        stale, refresh, execution, scope, externalActionTarget };
}
