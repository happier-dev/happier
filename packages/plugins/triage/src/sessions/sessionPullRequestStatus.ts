import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';
import { useLivePluginResourceProjection, type PluginUiResourceProjection, type PluginUiResourceProjectionSnapshot } from '@happier-dev/plugin-ui';
import { reconcileTriagePullRequestStatusV1, SessionPullRequestStatusResourceResultV1Schema,
    type SessionPullRequestStatusResourceResultV1 } from '@happier-dev/triage-protocol/v1';
import type { ScmPullRequestSummary } from '@happier-dev/plugin-sdk/scm';

import { TRIAGE_SESSION_PULL_REQUEST_STATUS_RESOURCE_LOCAL_ID_V1 } from './sessionPullRequestResourceId.js';

export type TriageSessionPullRequestBindingV1 = Extract<SessionPullRequestStatusResourceResultV1, { kind: 'ready' }>['pullRequests'][number];
export type TriageSessionPullRequestProjectionSnapshotV1 = PluginUiResourceProjectionSnapshot<SessionPullRequestStatusResourceResultV1>;
export type TriageSessionPullRequestCardV1 = Readonly<{ kind: 'branchHint'; pullRequest: ScmPullRequestSummary }>
    | Readonly<{ kind: 'bound'; pullRequest: Readonly<{
        provider: Pick<ScmPullRequestSummary['provider'], 'displayName'>;
        number?: number | null; url: string; title: string;
    }>; binding: TriageSessionPullRequestBindingV1 }>;

function leaf<T>(previous: T | undefined, next: T): T {
    return previous !== undefined && pluginJsonValuesEqual(previous, next) ? previous : next;
}

/** One typed admission at the existing shared Resource entry, never a second acquisition owner. */
export const TRIAGE_SESSION_PULL_REQUEST_STATUS_PROJECTION_V1: PluginUiResourceProjection<SessionPullRequestStatusResourceResultV1> = {
    decode(content, previous) {
        const next = SessionPullRequestStatusResourceResultV1Schema.parse(JSON.parse(new TextDecoder().decode(content.bytes)));
        if (next.kind !== 'ready' || previous?.kind !== 'ready' || next.sessionId !== previous.sessionId) return next;
        const old = new Map(previous.pullRequests.map(binding => [binding.bindingId, binding]));
        const pullRequests = next.pullRequests.map(binding => {
            const baseline = old.get(binding.bindingId);
            if (!baseline) return binding;
            const link = leaf(baseline.link, binding.link);
            const watch = leaf(baseline.watch, binding.watch);
            const latestUpdate = leaf(baseline.latestUpdate, binding.latestUpdate);
            const entry = leaf(baseline.entry, binding.entry);
            const native = binding.nativeStatus;
            const oldNative = baseline.nativeStatus;
            // The host resets this entry on private authority retirement. Within that lifetime,
            // only the same admitted entry/PR/head may reuse native entities across transport.
            const sameAuthority = entry === baseline.entry && binding.link.provider === baseline.link.provider
                && binding.link.repository === baseline.link.repository && binding.link.number === baseline.link.number
                && binding.link.url === baseline.link.url;
            let nativeStatus = native;
            if (native.kind !== 'unavailable') {
                const previousValue = sameAuthority && oldNative.kind !== 'unavailable'
                    && oldNative.value.branch?.headRevision === native.value.branch?.headRevision ? oldNative.value : null;
                const { value } = reconcileTriagePullRequestStatusV1(previousValue, native.value);
                // checkedAtMs belongs to the Resource wrapper, not the retained value's observation carrier.
                const projected = value === native.value ? native : { ...native, value };
                nativeStatus = previousValue === null ? projected : leaf(oldNative, projected);
            } else if (sameAuthority && oldNative.kind === 'unavailable') nativeStatus = leaf(oldNative, native);
            return baseline.revision === binding.revision && link === baseline.link && watch === baseline.watch
                && latestUpdate === baseline.latestUpdate && entry === baseline.entry && nativeStatus === baseline.nativeStatus
                ? baseline : { ...binding, ...(entry === undefined ? {} : { entry }), link, watch, latestUpdate, nativeStatus };
        });
        if (pullRequests.length === previous.pullRequests.length && pullRequests.every((binding, index) => binding === previous.pullRequests[index])) return previous;
        return { ...next, pullRequests };
    },
};

export function selectTriageSessionPullRequestStatusV1(
    value: SessionPullRequestStatusResourceResultV1 | undefined,
    sessionId: string | null,
    url: string | null,
): TriageSessionPullRequestBindingV1 | null {
    if (value?.kind !== 'ready' || value.sessionId !== sessionId || url === null) return null;
    const matches = value.pullRequests.filter(binding => binding.link.url === url);
    return matches.length === 1 ? matches[0]! : null;
}

/** Branch discovery supplies an explicit hint; only an exact Session binding supplies linked status. */
export function projectTriageSessionPullRequestCardsV1(
    pullRequest: ScmPullRequestSummary | undefined,
    sessionId: string | null,
    value: SessionPullRequestStatusResourceResultV1 | undefined,
): readonly TriageSessionPullRequestCardV1[] {
    const bindings = value?.kind === 'ready' && value.sessionId === sessionId ? value.pullRequests : [];
    const cards: TriageSessionPullRequestCardV1[] = bindings.map(binding => {
        const native = binding.nativeStatus.kind === 'unavailable' ? null : binding.nativeStatus.value;
        const summary = pullRequest?.url === binding.link.url ? pullRequest : {
            provider: { displayName: 'GitHub' },
            number: binding.link.number, url: binding.link.url, title: native?.title ?? binding.link.url,
        };
        return { kind: 'bound', pullRequest: summary, binding };
    });
    if (pullRequest && !bindings.some(binding => binding.link.url === pullRequest.url)) cards.push({ kind: 'branchHint', pullRequest });
    return cards;
}

export function useTriageSessionPullRequestStatusV1<T>(
    selector: (snapshot: PluginUiResourceProjectionSnapshot<SessionPullRequestStatusResourceResultV1>) => T,
    enabled = true,
) {
    return useLivePluginResourceProjection(TRIAGE_SESSION_PULL_REQUEST_STATUS_RESOURCE_LOCAL_ID_V1,
        TRIAGE_SESSION_PULL_REQUEST_STATUS_PROJECTION_V1, selector, { enabled });
}
