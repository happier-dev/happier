import { SessionPullRequestStatusResourceResultV1Schema, type TriagePullRequestOperationsV1 } from '@happier-dev/triage-protocol/v1';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import type { TriageSessionPullRequestBindingV1 } from '../sessionPullRequestStatus.js';

export const operationHead = 'a'.repeat(40);
export const operationOffers = {
    readiness: 'unknown', unmetRequirements: [],
    primary: { id: 'merge', title: 'Merge', disabledReason: null,
        actionRef: { pluginId: 'example.forge', localId: 'merge' }, variants: [
            { id: 'merge', method: { title: 'Merge commit' }, input: { headRevision: operationHead, mergeMethod: 'merge' } },
            { id: 'squash', method: { title: 'Squash' }, input: { headRevision: operationHead, mergeMethod: 'squash' } },
        ] },
    alternatives: [{ id: 'cancelAutoMerge', title: 'Cancel auto-merge', disabledReason: null,
        actionRef: { pluginId: 'example.forge', localId: 'auto-merge-set' }, variants: [{ id: 'direct', input: { enabled: false } }] }],
} satisfies TriagePullRequestOperationsV1;

export function createSessionPullRequestOperationsBinding(): TriageSessionPullRequestBindingV1 {
    const fixture = createTriageSourceV1Fixture();
    const result = SessionPullRequestStatusResourceResultV1Schema.parse({ kind: 'ready', sessionId: 'session-1', pullRequests: [{
        bindingId: 'binding-1', revision: 7, link: { provider: 'github', repository: 'acme/widgets', number: 7,
            url: 'https://github.com/acme/widgets/pull/7' },
        watch: { policy: { mode: 'off', archiveAfterMerge: false }, reason: null,
            fixAttemptLimit: 3, roundsStarted: 0, watchingMachine: null }, latestUpdate: null,
        entry: { entryRef: { source: fixture.configuredInstance.instance.source, ...fixture.getInput.localRef },
            sourceInstanceId: fixture.configuredInstance.instance.sourceInstanceId },
        nativeStatus: { kind: 'current', checkedAtMs: 100, value: { kind: 'status', observedAtMs: 99,
            checks: null, review: null, merge: null, branch: { head: 'topic', base: 'main', headRevision: operationHead },
            facts: [], operations: operationOffers } },
    }] });
    if (result.kind !== 'ready' || !result.pullRequests[0]) throw new Error('Expected admitted fixture');
    return result.pullRequests[0];
}

/** Public Resource producer fixture used by the actual Companion and SCM presentation hosts. */
export function createSessionPullRequestOperationGlanceBinding(operation: 'merge' | 'dequeue' | 'cancelAutoMerge'): TriageSessionPullRequestBindingV1 {
    const original = createSessionPullRequestOperationsBinding();
    if (original.nativeStatus.kind !== 'current') throw new Error('Expected native fixture');
    const primary = operation === 'dequeue' ? { id: 'dequeue', title: 'Leave queue', disabledReason: null,
        actionRef: { pluginId: 'example.forge', localId: 'dequeue' }, variants: [{ id: 'direct', input: { pullRequestId: 'native-pr-7' } }] }
        : operationOffers.primary;
    const result = SessionPullRequestStatusResourceResultV1Schema.parse({ kind: 'ready', sessionId: 'session-1', pullRequests: [{
        ...original, nativeStatus: { ...original.nativeStatus, value: { ...original.nativeStatus.value,
            operations: { ...operationOffers, primary, alternatives: operation === 'cancelAutoMerge' ? operationOffers.alternatives : [] },
        } },
    }] });
    if (result.kind !== 'ready' || !result.pullRequests[0]) throw new Error('Expected operation glance binding');
    return result.pullRequests[0];
}
