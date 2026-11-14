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

function requestKey(requests: readonly PrivateLabelOpenRequestV1[]): string {
    return JSON.stringify(requests.map((request) => ({
        key: request.key,
        binding: request.binding,
        label: request.label ?? null,
        readPolicy: request.readPolicy,
    })));
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
    const key = requestKey(params.requests);
    const requestsRef = React.useRef(params.requests);
    requestsRef.current = params.requests;
    const [opened, setOpened] = React.useState<Readonly<{
        scopeKey: string;
        key: string;
        values: Readonly<Record<string, string | null>>;
    }> | null>(null);

    React.useEffect(() => {
        const scope = params.scope;
        if (!scope || params.enabled === false || requestsRef.current.length === 0) return;
        const abort = new AbortController();
        const client = createPrivateLabelClient(scope);
        const requests = requestsRef.current;
        void Promise.allSettled(requests.map(async (request) => [
            request.key,
            await client.open({
                binding: request.binding,
                label: request.label,
                readPolicy: request.readPolicy,
                signal: abort.signal,
            }),
        ] as const)).then((results) => {
            if (abort.signal.aborted) return;
            const entries: Array<readonly [string, string | null]> = [];
            for (const [index, result] of results.entries()) {
                if (result.status === 'fulfilled') {
                    entries.push(result.value);
                    continue;
                }
                // Lost Account custody ends this effect; only a label-local
                // failure becomes unavailable so its siblings keep rendering.
                if (isPrivateLabelLifecycleFailureV1(result.reason, abort.signal)) return;
                entries.push([requests[index]!.key, null]);
            }
            setOpened({ scopeKey, key, values: Object.fromEntries(entries) });
        });
        return () => abort.abort();
    }, [key, params.enabled, params.scope?.accountId, params.scope?.serverId, scopeKey]);

    return opened?.scopeKey === scopeKey && opened.key === key
        ? opened.values
        : EMPTY_OPENED_LABELS;
}
