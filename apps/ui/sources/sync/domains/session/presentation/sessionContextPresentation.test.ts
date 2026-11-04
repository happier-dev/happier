import {
    projectSessionAwarenessV1} from '@happier-dev/protocol/sessions/awareness/projectV1';
import {
    type ProjectSessionAwarenessV1Input,
    type SessionContentAvailabilityInputV1} from '@happier-dev/protocol/sessions/awareness/inputV1';
import {
    type SessionViewerProjectionV1,
} from '@happier-dev/protocol/sessions/personal/viewer';
import { afterEach, describe, expect, it } from 'vitest';
import { NO_TEAM_GROUP_CAPABILITIES_V1 } from '@happier-dev/protocol/teams';
import { applyTeamGroupProjection, resetTeamsSnapshotsForTests } from '@/sync/store/teams/teamsSnapshots';
import type { SessionListHomeObservation } from '@/sync/domains/session/listing/sessionListHomeObservation';

import {
    buildSessionContextFacts,
    projectSessionContextPresentation,
    resolveSessionContextLine,
    readSessionHomeLastUpdatedRefreshAtMs,
    readSessionHomeLastUpdatedLabelRefreshAtMs,
    retainPresentedSessionHomeObservations,
} from './sessionContextPresentation';

function makeAwareness(params: Readonly<{
    content: SessionContentAvailabilityInputV1;
    workspacePath?: string | null;
}>) {
    const input: ProjectSessionAwarenessV1Input = {
        nowMs: 1_000,
        sessionId: 'session-1',
        lifecycle: { meaningfulActivityAtMs: 900 },
        runtime: { presence: 'online', lastObservedAtMs: 900 },
        pending: { hasPendingPermissionRequests: false, hasPendingUserActionRequests: false },
        content: params.content,
        workspace: params.workspacePath ? { path: params.workspacePath } : null,
        currentness: { lifecycle: 'observed', runtime: 'observed', pending: 'observed', work: 'observed' },
    };
    return projectSessionAwarenessV1(input);
}

const VIEWER_RESPONSIBLE: SessionViewerProjectionV1 = {
    latestFailureSeq: null,
    readState: { state: 'tracking', lastViewedSessionSeq: 4, unreadSince: null },
    relevance: { relevant: true, reasons: ['responsible_for_me'] },
    follow: { follows: true, notificationLevel: 'important' },
    notification: { level: 'important', source: 'preference' },
    attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
};

const VIEWER_FOLLOWING_ONLY: SessionViewerProjectionV1 = {
    ...VIEWER_RESPONSIBLE,
    relevance: { relevant: true, reasons: ['followed_by_me'] },
};

const VIEWER_SHARED_DIRECTLY: SessionViewerProjectionV1 = {
    ...VIEWER_RESPONSIBLE,
    relevance: { relevant: true, reasons: ['shared_directly_with_me'] },
    follow: { follows: false, notificationLevel: null },
    notification: { level: 'none', source: 'none' },
};

describe('sessionContextPresentation', () => {
    it('retains a current Home across success-clock refetches and republishes once its time is shown', () => {
        const current = { 'home-a': { phase: 'ready', lastSuccessAt: 1_000 } } as const;
        const refetched = retainPresentedSessionHomeObservations(current, { 'home-a': { phase: 'ready', lastSuccessAt: 9_000 } });
        expect(refetched).toBe(current);

        const offline = { 'home-a': { phase: 'offline', lastSuccessAt: 9_000 } } as const;
        expect(retainPresentedSessionHomeObservations(refetched, offline)).toEqual(offline);
        const offlineAdvanced = { 'home-a': { phase: 'offline', lastSuccessAt: 12_000 } } as const;
        expect(retainPresentedSessionHomeObservations(offline, offlineAdvanced)).toEqual(offlineAdvanced);
        expect(retainPresentedSessionHomeObservations(offline, { ...offline, 'home-b': { phase: 'ready', lastSuccessAt: 1 } }))
            .toEqual({ ...offline, 'home-b': { phase: 'ready', lastSuccessAt: 1 } });
    });

    it('schedules stale Home age changes without adding a freshness expiry to a reachable Home', () => {
        expect(readSessionHomeLastUpdatedRefreshAtMs({ phase: 'offline', lastSuccessAt: 1_000 }, 91_000)).toBe(121_000);
        expect(readSessionHomeLastUpdatedRefreshAtMs({ phase: 'error', lastSuccessAt: 1_000 }, 91_000)).toBe(121_000);
        expect(readSessionHomeLastUpdatedRefreshAtMs({ phase: 'ready', lastSuccessAt: 1_000 }, 91_000)).toBeNull();
        expect(readSessionHomeLastUpdatedRefreshAtMs({ phase: 'offline', lastSuccessAt: null }, 91_000)).toBeNull();
        for (const [homeObservation, boundary] of [
            [{ phase: 'offline', lastSuccessAt: 1_000 }, 121_000],
            [{ phase: 'error', lastSuccessAt: 1_000 }, 121_000],
            [{ phase: 'ready', lastSuccessAt: 1_000 }, null],
            [{ phase: 'offline', lastSuccessAt: null }, null],
            [{ phase: 'offline', lastSuccessAt: 92_000 }, 92_000],
        ] as const) {
            const facts = buildSessionContextFacts({ address: { serverId: 'home', sessionId: 'session' }, homeObservation });
            expect(readSessionHomeLastUpdatedLabelRefreshAtMs(facts.freshness, 91_000)).toBe(boundary);
        }
    });
    it('uses the canonical Home label rather than a relay-derived profile or caller name', () => {
        const host = 'happier-agent-qa-orc.localhost:3017';
        const facts = buildSessionContextFacts({ address: { serverId: 'home-a', sessionId: 'session-1' }, homeName: host,
            serverProfile: { id: 'home-a', name: host, serverUrl: `http://${host}`, createdAt: 1, updatedAt: 1, lastUsedAt: 1, source: 'manual' } });
        expect(facts.home?.name).toBe('This Home');
    });
    afterEach(resetTeamsSnapshotsForTests);

    it('uses the exact Home and viewer Account directory for the server-selected Group', () => {
        const audienceContext = { kind: 'group', teamId: 'team', groupId: 'group' } as const;
        for (const [serverId, accountId, name] of [
            ['home-a', 'viewer', 'A group'], ['home-b', 'viewer', 'B group'], ['home-b', 'other', 'Other account group'],
        ]) {
            applyTeamGroupProjection({
                scope: { serverId, accountId }, address: { serverId, teamId: 'team' }, observedAt: 1,
                group: { v: 1, id: 'group', teamId: 'team', name, description: null, archivedAt: null,
                    memberCount: 1, management: { kind: 'native' }, capabilities: NO_TEAM_GROUP_CAPABILITIES_V1 },
            });
        }
        const facts = buildSessionContextFacts({
            address: { serverId: 'home-b', sessionId: 'same-session' }, audienceContext,
            audienceScope: { serverId: 'home-b', accountId: 'viewer' },
            awareness: makeAwareness({ content: { mode: 'e2ee', keyState: 'access_pending' } }),
        });
        expect(facts.audience).toEqual({ kind: 'group', label: 'B group' });
        expect(facts.responsibility).toBeNull();
        expect(projectSessionContextPresentation(facts).mayShowDecryptedContent).toBe(false);
        expect(buildSessionContextFacts({
            address: facts.address, audienceContext, audienceScope: { serverId: 'home-a', accountId: 'viewer' },
        }).audience).toBeNull();
        expect(buildSessionContextFacts({
            address: facts.address, audienceScope: { serverId: 'home-b', accountId: 'viewer' },
        }).audience).toBeNull();
    });

    it('keeps missing audience, responsibility and content availability unknown while retaining structural workspace context', () => {
        const presentation = projectSessionContextPresentation(buildSessionContextFacts({
            address: { serverId: 'home-b', sessionId: 'session-1' },
            homeName: 'Home B',
            workspaceLabel: '/private/retained/path',
        }));

        expect(presentation).toMatchObject({
            address: { serverId: 'home-b', sessionId: 'session-1' },
            contextLine: 'Home B · /private/retained/path',
            mayShowDecryptedContent: null,
            workspace: { label: '/private/retained/path' },
        });
        expect(presentation.segments).toEqual([
            { kind: 'home', label: 'Home B' },
            { kind: 'workspace', label: '/private/retained/path' },
        ]);
        expect(presentation.contextLine).not.toContain('Personal');
    });

    it('shows the qualified workspace and responsibility once content is readable', () => {
        const presentation = projectSessionContextPresentation(buildSessionContextFacts({
            address: { serverId: 'home-b', sessionId: 'session-1' },
            homeName: 'Home B',
            awareness: makeAwareness({ content: { mode: 'plain' }, workspacePath: '/home/alice/project' }),
            viewer: VIEWER_RESPONSIBLE,
            homeDir: '/home/alice',
        }));

        expect(presentation.segments).toEqual([
            { kind: 'home', label: 'Home B' },
            { kind: 'responsibility', label: 'Assigned to you' },
            { kind: 'workspace', label: '~/project' },
        ]);
        expect(presentation.contextLine).toBe('Home B · Assigned to you · ~/project');
        expect(presentation.mayShowDecryptedContent).toBe(true);
        expect(presentation.workspace).toEqual({ label: '~/project' });
    });

    it('omits only workspace when a surface disables machine paths', () => {
        const presentation = projectSessionContextPresentation({
            address: { serverId: 'home-b', sessionId: 'session-1' },
            home: { name: 'Home B', serverUrl: null },
            audience: { kind: 'group', label: 'Developers' },
            responsibility: { kind: 'assigned', label: 'Assigned to you' },
            contentAvailability: 'access_pending',
            workspace: { label: '~/PRIVATE-WORKSPACE-SENTINEL' },
            freshness: {
                state: 'offline',
                lastSuccessAt: 1_000,
                label: 'Offline',
                lastUpdatedLabel: 'Last updated 18m ago',
            },
        });

        expect(resolveSessionContextLine(presentation, { showWorkspace: false })).toBe(
            'Home B · Offline · Last updated 18m ago · Developers · Assigned to you · Encrypted access pending',
        );
        expect(resolveSessionContextLine(presentation, { showWorkspace: false }))
            .not.toContain('PRIVATE-WORKSPACE-SENTINEL');
    });

    it('spends context words on assignment only, never on Follow', () => {
        const following = buildSessionContextFacts({
            address: { serverId: 'home-b', sessionId: 'session-1' },
            awareness: makeAwareness({ content: { mode: 'plain' } }),
            viewer: VIEWER_FOLLOWING_ONLY,
        });
        const assigned = buildSessionContextFacts({
            address: { serverId: 'home-b', sessionId: 'session-1' },
            awareness: makeAwareness({ content: { mode: 'plain' } }),
            viewer: VIEWER_RESPONSIBLE,
        });

        // The Follow fact stays available for the glyph its control owns...
        expect(following.responsibility?.kind).toBe('following');
        // ...but a followed row already explains itself, so the line stays quiet.
        expect(projectSessionContextPresentation(following).segments).toEqual([]);
        // Assignment also implies Follow, and it is the marker that wins.
        expect(assigned.responsibility?.kind).toBe('assigned');
        expect(projectSessionContextPresentation(assigned).segments).toEqual([
            { kind: 'responsibility', label: 'Assigned to you' },
        ]);
    });

    it('tells a recipient a Session was shared with them, and yields to the stronger reasons', () => {
        const address = { serverId: 'home-b', sessionId: 'session-1' } as const;
        const awareness = makeAwareness({ content: { mode: 'plain' } });
        const shared = buildSessionContextFacts({ address, awareness, viewer: VIEWER_SHARED_DIRECTLY });

        // A direct share is the only reason this row is here, so the row says so.
        expect(shared.responsibility?.kind).toBe('shared_directly');
        expect(projectSessionContextPresentation(shared).segments).toEqual([
            { kind: 'responsibility', label: 'Shared with you' },
        ]);

        // Assignment and Follow already explain the row; the share adds nothing over them.
        const assignedAndShared = buildSessionContextFacts({
            address, awareness,
            viewer: { ...VIEWER_RESPONSIBLE, relevance: { relevant: true, reasons: ['responsible_for_me', 'shared_directly_with_me'] } },
        });
        const followedAndShared = buildSessionContextFacts({
            address, awareness,
            viewer: { ...VIEWER_SHARED_DIRECTLY, follow: { follows: true, notificationLevel: 'important' } },
        });
        expect(assignedAndShared.responsibility?.kind).toBe('assigned');
        expect(followedAndShared.responsibility?.kind).toBe('following');
        expect(projectSessionContextPresentation(followedAndShared).segments).toEqual([]);
    });

    it('never fabricates workspace context its owner withheld', () => {
        const address = { serverId: 'home-b', sessionId: 'session-1' } as const;
        // The awareness owner drops `workspace` for an unopened envelope, so there is nothing to
        // format and nothing to guess: the context line says only what was actually established.
        const pending = projectSessionContextPresentation(buildSessionContextFacts({
            address,
            homeName: 'Home B',
            awareness: makeAwareness({
                content: { mode: 'e2ee', keyState: 'access_pending' },
                workspacePath: '/private/repository',
            }),
            homeDir: '/private',
        }));
        const unknownEnvelope = projectSessionContextPresentation(buildSessionContextFacts({
            address,
            homeName: 'Home B',
            awareness: makeAwareness({ content: { mode: 'e2ee', keyState: 'unknown' } }),
        }));

        expect(pending.contextLine).toBe('Home B · Encrypted access pending');
        expect(pending.workspace).toBeNull();
        expect(pending.mayShowDecryptedContent).toBe(false);

        // An E2EE Session whose envelope state is not observed is unknown, not "preparing".
        expect(unknownEnvelope.contextLine).toBe('Home B');
        expect(unknownEnvelope.workspace).toBeNull();
        expect(unknownEnvelope.mayShowDecryptedContent).toBeNull();
    });

    it('keeps authorized structural context visible while content stays locked', () => {
        const audienceContext = { kind: 'group', teamId: 'team', groupId: 'group' } as const;
        const scope = { serverId: 'home-b', accountId: 'viewer' };
        applyTeamGroupProjection({
            scope, address: { serverId: 'home-b', teamId: 'team' }, observedAt: 1,
            group: { v: 1, id: 'group', teamId: 'team', name: 'Developers', description: null, archivedAt: null,
                memberCount: 2, management: { kind: 'native' }, capabilities: NO_TEAM_GROUP_CAPABILITIES_V1 },
        });

        const locked = projectSessionContextPresentation(buildSessionContextFacts({
            address: { serverId: 'home-b', sessionId: 'session-1' },
            homeName: 'Home B',
            awareness: makeAwareness({ content: { mode: 'e2ee', keyState: 'access_pending' } }),
            viewer: VIEWER_RESPONSIBLE,
            audienceContext,
            audienceScope: scope,
            // Supplied by the incumbent Session workspace-display owner from metadata this device
            // decrypted; a locked transcript does not make the Session's location secret.
            workspaceLabel: '~/project',
        }));

        expect(locked.segments).toEqual([
            { kind: 'home', label: 'Home B' },
            { kind: 'audience', label: 'Developers' },
            { kind: 'responsibility', label: 'Assigned to you' },
            { kind: 'content_availability', label: 'Encrypted access pending' },
            { kind: 'workspace', label: '~/project' },
        ]);
        // Structural context is fully accessible; only content-derived preview/title waits.
        expect(locked.accessibilityContext).toBe(locked.contextLine);
        expect(locked.mayShowDecryptedContent).toBe(false);
    });

    it('projects Home currentness from the canonical Session-list observation, never from a clock', () => {
        const address = { serverId: 'home-b', sessionId: 'session-1' } as const;
        const build = (
            homeObservation: SessionListHomeObservation | null,
            nowMs?: number,
        ) => buildSessionContextFacts({
            address,
            homeName: 'Home B',
            awareness: makeAwareness({ content: { mode: 'plain' } }),
            homeObservation,
            nowMs,
        });

        // A retained offline Home keeps its rows and says so, including when it last succeeded.
        const offline = build({ phase: 'offline', lastSuccessAt: 1_000 }, 1_000 + 18 * 60_000);
        expect(offline.freshness).toEqual({
            state: 'offline', lastSuccessAt: 1_000, label: 'Offline', lastUpdatedLabel: 'Last updated 18m ago',
        });
        expect(projectSessionContextPresentation(offline).segments).toEqual([
            { kind: 'home', label: 'Home B' },
            { kind: 'freshness', label: 'Offline' },
            { kind: 'freshness', label: 'Last updated 18m ago' },
        ]);

        // A failed refresh is stale, not offline and not authoritative emptiness. A caller with no
        // render clock still gets the state; only the "how long ago" words need one.
        expect(build({ phase: 'error', lastSuccessAt: 1_000 }).freshness).toEqual({
            state: 'stale', lastSuccessAt: 1_000, label: "Couldn't refresh", lastUpdatedLabel: null,
        });

        // A reachable Home stays quiet however long ago it last succeeded: this fact comes from
        // the list owner's phase, never from an arbitrary staleness timer.
        const ready = build({ phase: 'ready', lastSuccessAt: 1_000 }, 1_000 + 30 * 24 * 3_600_000);
        expect(ready.freshness).toEqual({
            state: 'current', lastSuccessAt: 1_000, label: null, lastUpdatedLabel: null,
        });
        expect(projectSessionContextPresentation(ready).segments)
            .toEqual([{ kind: 'home', label: 'Home B' }]);

        // No observation is unknown — never "current" and never a fabricated warning.
        expect(build(null).freshness).toEqual({
            state: 'unknown', lastSuccessAt: null, label: null, lastUpdatedLabel: null,
        });
        expect(projectSessionContextPresentation(build(null)).segments)
            .toEqual([{ kind: 'home', label: 'Home B' }]);
    });

    it('keeps the exact Home of the qualified address out of another Home context', () => {
        const homeA = projectSessionContextPresentation(buildSessionContextFacts({
            address: { serverId: 'home-a', sessionId: 'shared-id' },
            homeName: 'Home A',
            awareness: makeAwareness({ content: { mode: 'plain' }, workspacePath: '/srv/a' }),
        }));
        const homeB = projectSessionContextPresentation(buildSessionContextFacts({
            address: { serverId: 'home-b', sessionId: 'shared-id' },
            homeName: 'Home B',
            awareness: makeAwareness({ content: { mode: 'plain' }, workspacePath: '/srv/b' }),
        }));

        expect(homeA.address.serverId).toBe('home-a');
        expect(homeB.address.serverId).toBe('home-b');
        expect(homeA.contextLine).toBe('Home A · /srv/a');
        expect(homeB.contextLine).toBe('Home B · /srv/b');
    });
});
