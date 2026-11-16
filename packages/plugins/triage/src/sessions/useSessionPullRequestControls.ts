import * as React from 'react';
import { usePluginHostApi } from '@happier-dev/plugin-ui';
import type { ActionSessionAddressV1 } from '@happier-dev/plugin-sdk/sessions';
import type { PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import type { SessionPullRequestWatchPolicyV1, SessionPullRequestWatchReadResultV1 } from '@happier-dev/channels-protocol/v1';

import { acceptTriagePullRequestWatchOfferV1, openTriagePullRequestLocalFormV1, projectTriagePullRequestWatchOfferV1,
    readTriageSessionPullRequestWatchDefaultsV1, type TriagePullRequestWatchDefaultsResultV1,
    type TriagePullRequestLocalCauseV1, type TriagePullRequestWatchAcceptanceResultV1,
    type TriagePullRequestWatchOfferV1 } from './sessionPullRequestControls.js';

type Binding = Extract<SessionPullRequestWatchReadResultV1, { kind: 'ready' }>['bindings'][number]
    & Pick<import('./sessionPullRequestStatus.js').TriageSessionPullRequestBindingV1, 'entry'>;

/** Invoke only for an actual open/link offer. Mounting (including a hidden glance) performs no read. */
export function useTriageSessionPullRequestWatchDefaultsV1(enabled: boolean):
    (options?: PluginCancellationOptions) => Promise<TriagePullRequestWatchDefaultsResultV1> {
    const host = usePluginHostApi();
    return React.useCallback((options?: PluginCancellationOptions): Promise<TriagePullRequestWatchDefaultsResultV1> =>
        enabled ? readTriageSessionPullRequestWatchDefaultsV1(host, options) : Promise.resolve({ kind: 'unavailable' }),
    [enabled, host]);
}
export type TriageSessionPullRequestControlsV1 = Readonly<{
    offer: TriagePullRequestWatchOfferV1 | null;
    watch(options?: PluginCancellationOptions): Promise<TriagePullRequestWatchAcceptanceResultV1 | null>;
    openLocalReproduction(cause?: TriagePullRequestLocalCauseV1, options?: PluginCancellationOptions): ReturnType<typeof openTriagePullRequestLocalFormV1>;
}>;

/** c1/c3 consume their selected shared Resource binding. Mounting adds no reads, watches or effects. */
export function useTriageSessionPullRequestControlsV1(
    session: ActionSessionAddressV1,
    binding: Binding,
    defaultPolicy: SessionPullRequestWatchPolicyV1,
): TriageSessionPullRequestControlsV1 {
    const host = usePluginHostApi();
    const offer = React.useMemo(() => projectTriagePullRequestWatchOfferV1(session, binding, defaultPolicy),
        [session, binding, defaultPolicy]);
    const watch = React.useCallback((options?: PluginCancellationOptions) => {
        if (offer === null) return Promise.resolve(null);
        return acceptTriagePullRequestWatchOfferV1(host, offer, options);
    }, [host, offer]);
    const openLocalReproduction = React.useCallback((cause?: TriagePullRequestLocalCauseV1, options?: PluginCancellationOptions) =>
        openTriagePullRequestLocalFormV1(host, { session, binding, ...(cause === undefined ? {} : { cause }) }, options),
    [host, session, binding]);
    return React.useMemo(() => ({ offer, watch, openLocalReproduction }), [offer, watch, openLocalReproduction]);
}
