import { describe, expect, it } from 'vitest';
import { SessionPullRequestWatchBindingReadV1Schema } from '@happier-dev/channels-protocol/v1';

import { TriagePullRequestStatusV1Schema } from './pullRequestStatus.js';
import { TriageEntryRefV1Schema } from './identity.js';
import { SessionPullRequestStatusResourceInputV1Schema, SessionPullRequestStatusResourceResultV1Schema } from './sessionPullRequestStatus.js';

const status = TriagePullRequestStatusV1Schema.parse({
    kind: 'status', observedAtMs: 100, checks: null, review: null, merge: null, branch: null, facts: [],
});
const metadata = {
    bindingId: 'binding-1', revision: 1,
    link: { provider: 'github', repository: 'acme/widgets', number: 7, url: 'https://github.com/acme/widgets/pull/7' },
    watch: { policy: { mode: 'notify', archiveAfterMerge: false },
        reason: null, fixAttemptLimit: 3, roundsStarted: 0, watchingMachine: null },
    latestUpdate: null,
};
const failure = { class: 'transient', code: 'offline' };

function ready(nativeStatus: unknown) {
    return { kind: 'ready', sessionId: 'session-1', pullRequests: [{ ...metadata, nativeStatus }] };
}

describe('Session PR Resource admission', () => {
    it('carries only a closed source setup offer alongside typed native unavailability', () => {
        const offer = { destination: { pluginId: 'example.source', localId: 'source-settings' },
            displayName: 'Example source', kindNames: ['Pull requests'] };
        const recovery = { kind: 'configureSources', offers: [offer] };
        const unavailable = { kind: 'unavailable', failure: { class: 'unsupportedContract', code: 'configuredSourceUnavailable' }, recovery };
        expect(SessionPullRequestStatusResourceResultV1Schema.parse(ready(unavailable))).toEqual(ready(unavailable));
        for (const invalid of [
            { ...recovery, offers: [] },
            { ...recovery, offers: [{ ...offer, input: { kind: 'reconfigure' } }] },
            { ...recovery, offers: [{ ...offer, destination: { ...offer.destination, credential: 'not-routing' } }] },
        ]) expect(SessionPullRequestStatusResourceResultV1Schema.safeParse(ready({ ...unavailable, recovery: invalid })).success).toBe(false);
        expect(SessionPullRequestStatusResourceResultV1Schema.safeParse(ready({ kind: 'current', value: status, checkedAtMs: 200, recovery })).success).toBe(false);
    });

    it('admits optional canonical entry correspondence without requiring it for an external binding', () => {
        const entry = { entryRef: TriageEntryRefV1Schema.parse({ source: { pluginId: 'happier.scm.forge.github', localId: 'pull-requests' },
            kindId: 'pull-request', collisionScope: 'acme/widgets', entryId: '7' }),
            sourceInstanceId: '00000000-0000-4000-8000-000000000001' };
        const external = ready({ kind: 'current', value: status, checkedAtMs: 200 });
        expect(SessionPullRequestStatusResourceResultV1Schema.parse(external)).toEqual(external);
        const linked = { ...external, pullRequests: [{ ...external.pullRequests[0], entry }] };
        expect(SessionPullRequestStatusResourceResultV1Schema.parse(linked)).toEqual(linked);
        for (const invalid of [{ ...entry, sourceInstanceId: 'invented-from-url' },
            { ...entry, entryRef: { ...entry.entryRef, entryId: '' } }, { entryRef: entry.entryRef },
            { ...entry, credentialRevision: 1 }]) {
            expect(SessionPullRequestStatusResourceResultV1Schema.safeParse({ ...external,
                pullRequests: [{ ...external.pullRequests[0], entry: invalid }] }).success).toBe(false);
        }
    });

    it('composes every admitted Watch metadata field without introducing authority', () => {
        const admitted = SessionPullRequestWatchBindingReadV1Schema.parse({ ...metadata,
            watch: { ...metadata.watch, roundsStarted: 2,
                progress: { roundsStarted: 2, continuationRounds: 1, cause: { kind: 'feedback' }, sourceHeadSha: 'head-1' },
                watchingMachine: { serverId: 'home-1', machineId: 'machine-1', label: 'Work computer' } },
            latestUpdate: { occurrenceId: 'update-1', occurredAtMs: 150, kinds: ['comment'], summary: 'New feedback',
                summaryTruncated: false, location: { kind: 'provider', url: metadata.link.url } },
        });
        const nativeStatus = { kind: 'current', value: status, checkedAtMs: 200 };
        expect(SessionPullRequestStatusResourceResultV1Schema.parse({ kind: 'ready', sessionId: 'session-1',
            pullRequests: [{ ...admitted, nativeStatus }] }))
            .toEqual({ kind: 'ready', sessionId: 'session-1', pullRequests: [{ ...admitted, nativeStatus }] });
        expect(SessionPullRequestStatusResourceResultV1Schema.safeParse({ kind: 'ready', sessionId: 'session-1',
            pullRequests: [{ ...admitted, nativeStatus, credentialRevision: 9 }] }).success).toBe(false);
    });

    it('requires an exact host address, retaining the canonical Session address grammar', () => {
        expect(SessionPullRequestStatusResourceInputV1Schema.parse({ serverId: 'home-1', sessionId: 'session-1' }))
            .toEqual({ serverId: 'home-1', sessionId: 'session-1' });
        expect(SessionPullRequestStatusResourceInputV1Schema.safeParse({ sessionId: 'session-1' }).success).toBe(false);
        expect(SessionPullRequestStatusResourceInputV1Schema.safeParse({ serverId: 'home-1', sessionId: { selector: 'manager' } }).success).toBe(false);
    });

    it('admits both successful and retained stale status with the last successful source clock', () => {
        expect(SessionPullRequestStatusResourceResultV1Schema.parse(ready({ kind: 'current', value: status, checkedAtMs: 200 })))
            .toMatchObject({ pullRequests: [{ nativeStatus: { kind: 'current', value: { observedAtMs: 100 }, checkedAtMs: 200 } }] });
        expect(SessionPullRequestStatusResourceResultV1Schema.parse(ready({ kind: 'stale', value: status, checkedAtMs: 200, failure })))
            .toMatchObject({ pullRequests: [{ nativeStatus: { kind: 'stale', checkedAtMs: 200, failure } }] });
        for (const nativeStatus of [
            { kind: 'current', value: status },
            { kind: 'stale', value: status, failure },
            { kind: 'current', value: status, checkedAtMs: 1.5 },
            { kind: 'stale', value: status, checkedAtMs: 200, failure, observedAtMs: 300 },
        ]) expect(SessionPullRequestStatusResourceResultV1Schema.safeParse(ready(nativeStatus)).success).toBe(false);
    });

    it('keeps unavailable distinct from an empty linked set and invents no successful value or clock', () => {
        expect(SessionPullRequestStatusResourceResultV1Schema.parse({ kind: 'ready', sessionId: 'session-1', pullRequests: [] }))
            .toEqual({ kind: 'ready', sessionId: 'session-1', pullRequests: [] });
        expect(SessionPullRequestStatusResourceResultV1Schema.parse({ kind: 'unavailable', sessionId: 'session-1', failure }))
            .toEqual({ kind: 'unavailable', sessionId: 'session-1', failure });
        expect(SessionPullRequestStatusResourceResultV1Schema.parse(ready({ kind: 'unavailable', failure })))
            .toMatchObject({ pullRequests: [{ nativeStatus: { kind: 'unavailable', failure } }] });
        expect(SessionPullRequestStatusResourceResultV1Schema.safeParse(ready({ kind: 'unavailable', failure, checkedAtMs: 200 })).success).toBe(false);
        expect(SessionPullRequestStatusResourceResultV1Schema.safeParse(ready({ kind: 'unavailable', failure, value: status })).success).toBe(false);
    });

    it('closes the full composition without broadening Channels policy or native status', () => {
        const current = ready({ kind: 'current', value: status, checkedAtMs: 200 });
        expect(SessionPullRequestStatusResourceResultV1Schema.safeParse({ ...current, extra: true }).success).toBe(false);
        expect(SessionPullRequestStatusResourceResultV1Schema.safeParse({ ...current,
            pullRequests: [{ ...current.pullRequests[0], watch: { ...metadata.watch, policy: { ...metadata.watch.policy, mode: 'auto' } } }],
        }).success).toBe(false);
        expect(SessionPullRequestStatusResourceResultV1Schema.safeParse(ready({ kind: 'current', value: { ...status, ready: true }, checkedAtMs: 200 })).success).toBe(false);
    });
});
