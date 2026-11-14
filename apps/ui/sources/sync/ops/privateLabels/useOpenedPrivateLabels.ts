import * as React from 'react';
import type {
    PrivateLabelBindingV1,
    PrivateLabelReadV1,
    PrivateLabelReadPolicyV1,
} from '@happier-dev/protocol/crypto/privateLabelV1';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import {
    createPrivateLabelClient,
    isPrivateLabelLifecycleFailureV1,
} from './privateLabelClient';

export type PrivateLabelOpenRequestV1 = Readonly<{
    /** A caller-owned stable identifier, usually the persisted resource id. */
    key: string;
    binding: PrivateLabelBindingV1;
    label: PrivateLabelReadV1 | null | undefined;
    /** Owner-established policy; it is not inferred from the label binding or viewer. */
    readPolicy: PrivateLabelReadPolicyV1;
}>;

const EMPTY_OPENED_LABELS: Readonly<Record<string, string | null>> = Object.freeze({});

function requestKey(request: PrivateLabelOpenRequestV1): string {
    return JSON.stringify({
        key: request.key,
        binding: request.binding,
        label: request.label ?? null,
        readPolicy: request.readPolicy,
    });
}

/**
 * Opens an already-authorized recipient projection under its persisted binding.
 * It makes no detail request: unavailable keys and stale views remain unlabeled
 * until the normal projection changes or a current credential can open them.
 */
export function useOpenedPrivateLabels(params: Readonly<{
    scope: ServerAccountScope | null;
    requests: readonly PrivateLabelOpenRequestV1[];
    enabled?: boolean;
}>): Readonly<Record<string, string | null>> {
    const scopeKey = params.scope ? `${params.scope.serverId}:${params.scope.accountId}` : '';
    const requests = params.requests.map(request => ({ request, key: requestKey(request) }));
    const key = JSON.stringify(requests.map(request => request.key));
    const requestsRef = React.useRef(requests);
    requestsRef.current = requests;
    const [opened, setOpened] = React.useState<Readonly<{
        scopeKey: string;
        key: string;
        requestKeys: ReadonlyMap<string, string>;
        values: Readonly<Record<string, string | null>>;
    }> | null>(null);
    // A replacement withdraws its own old label immediately. Unchanged requests
    // retain their already-opened values under the same scope and privacy arm.
    const retained = opened?.scopeKey === scopeKey
        ? opened.key === key ? opened.values : Object.fromEntries(requests
            .filter(({ request, key }) => opened.requestKeys.get(request.key) === key)
            .map(({ request }) => [request.key, opened.values[request.key] ?? null]))
        : EMPTY_OPENED_LABELS;

    React.useEffect(() => {
        const scope = params.scope;
        if (!scope || params.enabled === false || requestsRef.current.length === 0) return;
        const abort = new AbortController();
        const client = createPrivateLabelClient(scope);
        const requests = requestsRef.current;
        const pending = requests.filter(({ request, key }) => opened?.scopeKey !== scopeKey
            || opened.requestKeys.get(request.key) !== key
            || opened.values[request.key] === null);
        void Promise.all(pending.map(async ({ request }): Promise<readonly [string, string | null]> => {
            try {
                return [request.key, await client.open({
                    binding: request.binding,
                    label: request.label,
                    readPolicy: request.readPolicy,
                    signal: abort.signal,
                })];
            } catch (error) {
                // Account custody withdraws the whole captured batch immediately;
                // an ordinary label failure leaves its unchanged siblings intact.
                if (isPrivateLabelLifecycleFailureV1(error, abort.signal)) throw error;
                return [request.key, null];
            }
        })).then((entries) => {
            if (abort.signal.aborted) return;
            setOpened({ scopeKey, key, requestKeys: new Map(requests.map(({ request, key }) => [request.key, key])),
                values: { ...retained, ...Object.fromEntries(entries) } });
        }, () => {
            if (!abort.signal.aborted) setOpened(null);
        });
        return () => abort.abort();
    }, [key, params.enabled, params.scope?.accountId, params.scope?.serverId, scopeKey]);

    return retained;
}
