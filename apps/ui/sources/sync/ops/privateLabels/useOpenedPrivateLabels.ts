import * as React from 'react';
import type {
    PrivateLabelBindingV1,
    PrivateLabelReadV1,
    PrivateLabelReadPolicyV1,
} from '@happier-dev/protocol/crypto/privateLabelV1';

import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import { openPrivateLabelBatch } from './privateLabelClient';

export type PrivateLabelOpenRequestV1 = Readonly<{
    /** A caller-owned stable identifier, usually the persisted resource id. */
    key: string;
    binding: PrivateLabelBindingV1;
    label: PrivateLabelReadV1 | null | undefined;
    /** Owner-established policy; it is not inferred from the label binding or viewer. */
    readPolicy: PrivateLabelReadPolicyV1;
}>;

type ScopedRequest = PrivateLabelOpenRequestV1 & Readonly<{ scope: ServerAccountScope }>;
type OpenedLabels = Readonly<Record<string, string | null>>;
type OpenedBatch = Readonly<{
    key: string;
    requestKeys: ReadonlyMap<string, string>;
    values: OpenedLabels;
}>;

const EMPTY_OPENED_LABELS: OpenedLabels = Object.freeze({});

function retainOpenedLabels(requestKeys: ReadonlyMap<string, string>, openedBatch: OpenedBatch): OpenedLabels {
    return Object.fromEntries([...requestKeys]
        .filter(([id, key]) => openedBatch.requestKeys.get(id) === key && Object.hasOwn(openedBatch.values, id))
        .map(([id]) => [id, openedBatch.values[id]]));
}

/**
 * Opens already-authorized recipient projections under their persisted bindings.
 * A replacement withdraws its own label immediately and a lifecycle refusal
 * withdraws the captured scope. Retained values live only in this hook mount.
 */
export function useScopedOpenedPrivateLabels(
    requests: readonly ScopedRequest[],
    enabled = true,
): ReadonlyMap<string, OpenedLabels> {
    const { batches, key } = React.useMemo(() => {
        const groupedRequests = new Map<string, { scope: ServerAccountScope; requests: ScopedRequest[] }>();
        for (const request of requests) {
            const scopeKey = serverAccountScopeKeySuffix(request.scope);
            const batch = groupedRequests.get(scopeKey);
            if (batch) batch.requests.push(request);
            else groupedRequests.set(scopeKey, { scope: request.scope, requests: [request] });
        }
        const batches = new Map([...groupedRequests].map(([scopeKey, batch]) => {
            const requestKeys = new Map(batch.requests.map(({ key, binding, label, readPolicy }) => [
                key, JSON.stringify([binding, label ?? null, readPolicy]),
            ]));
            return [scopeKey, { ...batch, requestKeys, key: JSON.stringify([...requestKeys]) }];
        }));
        return { batches, key: JSON.stringify([...batches].map(([scopeKey, batch]) => [scopeKey, batch.key])) };
    }, [requests]);
    const batchesRef = React.useRef(batches);
    batchesRef.current = batches;
    const wasEnabled = React.useRef(enabled);
    const [opened, setOpened] = React.useState<ReadonlyMap<string, OpenedBatch>>(() => new Map());

    const retained = React.useMemo(() => {
        const names = new Map<string, OpenedLabels>();
        for (const [scopeKey, batch] of batchesRef.current) {
            const previous = opened.get(scopeKey);
            if (previous) names.set(scopeKey, previous.key === batch.key
                ? previous.values : retainOpenedLabels(batch.requestKeys, previous));
        }
        return names;
    }, [key, opened]);

    React.useEffect(() => {
        const batches = batchesRef.current;
        const resumed = enabled && !wasEnabled.current;
        wasEnabled.current = enabled;
        if ([...opened.keys()].some(scopeKey => !batches.has(scopeKey))) {
            setOpened(previous => new Map([...previous].filter(([scopeKey]) => batches.has(scopeKey))));
        }
        if (!enabled || batches.size === 0) return;

        const abort = new AbortController();
        for (const [scopeKey, batch] of batches) {
            if (!resumed && opened.get(scopeKey)?.key === batch.key) continue;
            const unchanged = retained.get(scopeKey) ?? EMPTY_OPENED_LABELS;
            const pending = batch.requests.filter(request => !Object.hasOwn(unchanged, request.key) || unchanged[request.key] === null);
            const publish = (values: OpenedLabels) => {
                if (abort.signal.aborted) return;
                setOpened(previous => new Map(previous).set(scopeKey, {
                    key: batch.key, requestKeys: batch.requestKeys, values,
                }));
            };
            if (pending.length === 0) {
                publish(unchanged);
                continue;
            }
            void openPrivateLabelBatch(batch.scope, pending, abort.signal).then(
                values => publish({
                    ...unchanged,
                    ...Object.fromEntries(pending.map((request, index) => [request.key, values[index] ?? null])),
                }),
                () => publish(EMPTY_OPENED_LABELS),
            );
        }
        return () => abort.abort();
    }, [key, enabled]);

    return retained;
}

export function useOpenedPrivateLabels(params: Readonly<{
    scope: ServerAccountScope | null;
    requests: readonly PrivateLabelOpenRequestV1[];
    enabled?: boolean;
}>): OpenedLabels {
    const requests = React.useMemo(() => {
        const scope = params.scope;
        return scope ? params.requests.map(request => ({ ...request, scope })) : [];
    }, [params.requests, params.scope?.serverId, params.scope?.accountId]);
    const opened = useScopedOpenedPrivateLabels(requests, params.enabled);
    return (params.scope ? opened.get(serverAccountScopeKeySuffix(params.scope)) : undefined) ?? EMPTY_OPENED_LABELS;
}
