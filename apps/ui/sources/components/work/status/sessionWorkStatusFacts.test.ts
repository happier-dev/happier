import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

import { createSessionAccessFixture, createSessionFixture, createSessionListRenderableSessionFixture, createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionOwnerMetadataV1, projectSessionOwnerCompatibilityViewV1, projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { parseDecryptedSessionMetadata } from '@/sync/engine/sessions/parsePlainSessionPayload';
import { buildSessionFromListRenderable } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { getSessionStatus } from '@/utils/sessions/sessionUtils';

import { resolveWorkStatusTone } from './resolveWorkStatusTone';
import { readSessionWorkStalled, readSessionWorkStatusFacts, sessionWorkStatusFactsFromStatus, withOutstandingReports } from './sessionWorkStatusFacts';

const NOW = 1_000_000;

describe('readSessionWorkStatusFacts', () => {
    it.each(['permission', 'user_action'] as const)('carries the exact %s address from a compact list row without Session hydration', kind => {
        const source = createSessionFixture({ id: 'list-request', serverId: 'home-a', active: true, activeAt: NOW,
            viewer: createSessionViewerFixture({ attention: { needsAttention: true,
                reasons: [kind === 'permission' ? 'permission_required' : 'user_action_required'],
                primary: kind === 'permission' ? 'permission_required' : 'user_action_required', presentation: 'full' } }),
            agentState: { requests: {
                newer: { kind, tool: kind === 'permission' ? 'Bash' : 'AskUserQuestion', arguments: { private: 'new body' },
                    createdAt: NOW, turnId: 'new-turn' },
                oldest: { kind, tool: kind === 'permission' ? 'Bash' : 'AskUserQuestion', arguments: { private: 'old body' },
                    createdAt: NOW - 1, turnId: 'current-turn' },
            } },
        });
        const row = buildSessionListRenderableFromSession(source, undefined, []);
        expect(row).not.toHaveProperty('agentState');
        const facts = readSessionWorkStatusFacts(row, NOW);
        expect(facts.currentRequestRef).toEqual({ kind: kind === 'permission' ? 'permission' : 'question',
            requestId: 'oldest', turnId: 'current-turn' });
        expect(row.currentRequestRef).toBe(facts.currentRequestRef);
        expect(facts.currentRequest).toBeUndefined();
        // The status slot names the request in one short word (lab `clicon:word`), not "Action required".
        expect(facts.word).toBe(kind === 'permission' ? 'workStatus.words.permission' : 'workStatus.words.question');
    });

    it('carries admitted C1 attention beside awareness while preserving the existing viewer reference', () => {
        const quietViewer = createSessionViewerFixture();
        const row = createSessionListRenderableSessionFixture({ active: true, activeAt: NOW,
            hasPendingPermissionRequests: true, pendingRequestObservedAt: NOW, viewer: quietViewer });
        const quiet = readSessionWorkStatusFacts(row, NOW);
        expect(quiet.viewer).toBe(quietViewer);
        expect(quiet.attentionType).toBeNull();
        const viewer = createSessionViewerFixture({ attention: { needsAttention: true,
            reasons: ['failed', 'permission_required'], primary: 'failed', presentation: 'full' } });
        const admitted = readSessionWorkStatusFacts({ ...row, viewer }, NOW);
        expect(admitted.viewer).toBe(viewer);
        expect(admitted.attentionType).toBe('approval');
        expect(resolveWorkStatusTone({ kind: 'session', facts: admitted }))
            .toMatchObject({ state: 'failed', tone: 'danger', attentionType: 'approval' });
    });

    it.each(['manager', 'continue'] as const)('keeps an admitted %s question quiet using its held request owner', kind => {
        const questionV1 = kind === 'continue'
            ? { mode: 'continue' as const, assumption: 'Continue with the safe default', type: 'decision' as const, lasting: false }
            : { mode: 'wait' as const, type: 'decision' as const, lasting: false };
        const currentHandler = kind === 'manager' ? { kind: 'session' as const, sessionId: 'manager' } : { kind: 'person' as const };
        const session = createSessionFixture({ active: true, activeAt: NOW,
            viewer: createSessionViewerFixture({ attention: { needsAttention: true,
                reasons: ['user_action_required'], primary: 'user_action_required', presentation: 'full' } }),
            agentState: { requests: { question: { tool: 'AskUserQuestion', kind: 'user_action', arguments: {},
                createdAt: NOW, questionV1, currentHandler } } },
        });
        const facts = readSessionWorkStatusFacts(session, NOW);
        expect(facts.currentRequest?.id).toBe('question');
        expect(facts.requestFollowEvent).toMatchObject({ kind: 'needs_you', type: 'decision', mode: questionV1.mode });
        expect(resolveWorkStatusTone({ kind: 'session', facts }))
            .toMatchObject({ attentionType: 'decision', tone: 'neutral' });
    });
    it('reads layout-1 stopped evidence from authorized owner metadata, leaving recipients offline', () => {
        const metadata = { path: '/repo', host: 'devbox', lifecycleState: 'stopped', lifecycleStateSince: NOW };
        const owner = createSessionOwnerMetadataV1({ metadata });
        if (!owner.ok) throw new Error('Expected valid owner metadata');
        const sharedMetadata = projectSessionSharedMetadataV1({ metadata });
        const source = createSessionFixture({ metadataLayoutVersion: 1, active: false, presence: undefined,
            metadata: parseDecryptedSessionMetadata(sharedMetadata, 1),
            ownerMetadataView: parseDecryptedSessionMetadata(projectSessionOwnerCompatibilityViewV1({
                sharedMetadata, ownerMetadata: owner.ownerMetadata,
            })) });
        const row = buildSessionListRenderableFromSession(source);
        for (const session of [source, row, buildSessionFromListRenderable(row)]) {
            expect(getSessionStatus(session, NOW).statusText).toBe('sessionWork.states.stopped');
            expect(readSessionWorkStatusFacts(session, NOW).word).toBe('sessionWork.states.stopped');
        }
        // Recipient access cannot borrow an old owner-only view still held on the object.
        const recipient = { ...source, access: createSessionAccessFixture('view'), accessLevel: 'view' as const };
        for (const session of [recipient, buildSessionListRenderableFromSession(recipient)]) {
            expect(readSessionWorkStatusFacts(session, NOW).word).toBe('status.offline');
        }
    });

    it('presents a confirmed stopped process consistently through hydrated, list and preprojected status paths', () => {
        const stopped = createSessionFixture({ active: false, activeAt: NOW - 3_600_000, presence: undefined,
            metadata: { path: '/repo', host: 'devbox', lifecycleState: 'stopped', lifecycleStateSince: NOW - 1_000 } });
        const row = buildSessionListRenderableFromSession(stopped);
        for (const session of [stopped, row, buildSessionFromListRenderable(row)]) {
            const facts = readSessionWorkStatusFacts(session, NOW);
            expect(resolveWorkStatusTone({ kind: 'session', facts }))
                .toMatchObject({ state: 'stopped', bucket: 'idle', tone: 'neutral', word: 'sessionWork.states.stopped' });
            const status = getSessionStatus(session, NOW);
            expect(status).toMatchObject({ state: 'stopped', isConnected: false, isPulsing: false,
                statusText: 'sessionWork.states.stopped' });
            expect(sessionWorkStatusFactsFromStatus(session, status).word).toBe(facts.word);
        }

        // Startup can publish running before presence reconnects; equal-version row projection
        // must replace the old terminal word rather than retain a stale metadata reference.
        const restarting = buildSessionListRenderableFromSession({ ...stopped,
            metadata: { ...stopped.metadata!, lifecycleState: 'running' } }, row);
        expect(readSessionWorkStatusFacts(restarting, NOW).word).toBe('status.offline');
        const stoppedAgain = buildSessionListRenderableFromSession(stopped, restarting);
        expect(readSessionWorkStatusFacts(stoppedAgain, NOW).word).toBe('sessionWork.states.stopped');

        const running = { ...stopped, active: true, activeAt: NOW, presence: 'online' as const,
            thinking: true, thinkingAt: NOW, latestTurnStatus: 'in_progress' as const,
            metadata: { ...stopped.metadata!, lifecycleState: 'running', lifecycleStateSince: NOW } };
        const resumedRow = buildSessionListRenderableFromSession(running, row);
        expect(readSessionWorkStatusFacts(resumedRow, NOW).word).toBe('status.working');
        expect(getSessionStatus(resumedRow, NOW).statusText).toBe('status.working');
        // Presence and explicit resume still win if the prior stopped marker is briefly retained.
        expect(readSessionWorkStatusFacts({ ...running, metadata: stopped.metadata }, NOW).word).toBe('status.working');
        expect(readSessionWorkStatusFacts({ ...stopped, resumingAt: NOW }, NOW).word).toBe('session.resuming');
    });

    it.each([undefined, 'running', 'crashed', 'unknown', 'STOPPED', 'stopped '])(
        'keeps disconnected lifecycle %s offline instead of inferring a process stop', (lifecycleState) => {
            const source = createSessionFixture({ active: false, presence: undefined, activeAt: NOW - 3_600_000,
                metadata: { path: '/repo', host: 'devbox', lifecycleState } });
            const row = buildSessionListRenderableFromSession(source);
            expect(readSessionWorkStatusFacts(row, NOW).word).toBe('status.offline');
            expect(getSessionStatus(row, NOW).statusText).toMatch(/^status\.lastSeen\(/);
        },
    );

    it('keeps an HTTP-loaded inactive row offline before and after unchanged details hydrate', () => {
        const row = createSessionListRenderableSessionFixture({
            encryptionMode: 'e2ee', encryptedContentAvailability: undefined, metadata: null,
            presence: undefined, active: false, activeAt: NOW - 3_600_000,
            hasPendingPermissionRequests: undefined, hasPendingUserActionRequests: undefined,
        });
        const cold = buildSessionFromListRenderable(row, { serverId: 'home-a' });
        const status = resolveWorkStatusTone({ kind: 'session', facts: readSessionWorkStatusFacts(cold, NOW) });
        expect(status).toMatchObject({ bucket: 'offline', tone: 'neutral', word: 'status.offline' });
        // The content remains unavailable during hydration; a public runtime word grants no read.
        expect(readSessionWorkStatusFacts(cold, NOW).awareness.encryption).toBe('unknown');
        const hydrated = createSessionFixture({ ...cold, encryptedContentAvailability: 'ready',
            metadata: createSessionFixture().metadata, presence: 0 });
        expect(resolveWorkStatusTone({ kind: 'session', facts: readSessionWorkStatusFacts(hydrated, NOW) })).toEqual(status);
    });

    it('keeps an unhydrated identity quiet while retaining a real unknown runtime after content settles', () => {
        const row = createSessionListRenderableSessionFixture({
            encryptionMode: 'e2ee', encryptedContentAvailability: undefined, metadata: null,
            active: true, presence: undefined,
        });
        for (const source of [row, buildSessionFromListRenderable(row),
            { ...row, encryptionMode: 'plain' as const, encryptedContentAvailability: 'ready' as const }]) {
            const pending = resolveWorkStatusTone({ kind: 'session', facts: readSessionWorkStatusFacts(source, NOW) });
            expect(pending).toMatchObject({ bucket: 'idle', tone: 'neutral', word: '' });
        }
        const hydrated = { ...row, encryptionMode: 'plain' as const, encryptedContentAvailability: 'ready' as const,
            metadata: { path: '/repo', host: 'work' } };
        const status = resolveWorkStatusTone({ kind: 'session', facts: readSessionWorkStatusFacts(hydrated, NOW) });
        expect(status).toMatchObject({ bucket: 'idle', tone: 'neutral', word: 'status.unknownState' });
    });

    it('keeps observer loss offline, including an idle runtime after a cancelled turn', () => {
        // A hydrated row the Home marked inactive, with no device-observed presence.
        const detached = createSessionListRenderableSessionFixture({ active: false, presence: undefined, activeAt: NOW - 3_600_000 });
        const facts = readSessionWorkStatusFacts(detached, NOW);
        expect(facts.word).toBe('status.offline');
        expect(resolveWorkStatusTone({ kind: 'session', facts }).bucket).toBe('offline');

        const lost = createSessionListRenderableSessionFixture({ active: false, activeAt: NOW, presence: 0,
            latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: NOW });
        expect(readSessionWorkStalled(lost, NOW)).toBe(true);
        expect(readSessionWorkStatusFacts(lost, NOW).word).toBe('status.offline');

        const cancelled = createSessionListRenderableSessionFixture({ active: true, activeAt: NOW, presence: 'online',
            latestTurnStatus: 'cancelled', latestTurnStatusObservedAt: NOW - 1 });
        expect(readSessionWorkStatusFacts(cancelled, NOW).awareness.runtime).toBe('idle');
        expect(readSessionWorkStatusFacts({ ...cancelled, active: false, presence: undefined }, NOW + 3_600_000).word)
            .toBe('status.offline');
    });

    it('does not turn an idle runtime heartbeat expiry into a confirmed stop', () => {
        const idle = createSessionListRenderableSessionFixture({ active: true, activeAt: NOW, presence: 'online' });
        expect(readSessionWorkStatusFacts(idle, NOW).awareness.runtime).toBe('idle');
        // The Home expires the publisher heartbeat; it has not observed a process exit or cancellation.
        const expired = { ...idle, active: false, presence: undefined };
        const facts = readSessionWorkStatusFacts(expired, NOW + 3_600_000);
        expect(facts.awareness.runtime).toBe('offline');
        expect(facts.word).toBe('status.offline');
    });

    it('reads a list row the way the Session owner does: a pending permission needs you, a turn in flight is not settled', () => {
        const waiting = createSessionListRenderableSessionFixture({
            active: true, activeAt: NOW, hasPendingPermissionRequests: true, pendingRequestObservedAt: NOW,
        });
        expect(resolveWorkStatusTone({ kind: 'session', facts: readSessionWorkStatusFacts(waiting, NOW) }).bucket).toBe('needs_you');

        const working = createSessionListRenderableSessionFixture({
            active: true, activeAt: NOW, thinking: true, thinkingAt: NOW, latestTurnStatus: 'in_progress',
        });
        const workingFacts = readSessionWorkStatusFacts(working, NOW);
        expect(workingFacts.settled).toBe(false);
        expect(resolveWorkStatusTone({ kind: 'session', facts: workingFacts }).bucket).toBe('working');

    });

    it('reads Finished from the Session settlement even after runtime detach, Idle otherwise', () => {
        const bucketOf = (overrides: Parameters<typeof createSessionListRenderableSessionFixture>[0]) =>
            resolveWorkStatusTone({
                kind: 'session',
                facts: readSessionWorkStatusFacts(createSessionListRenderableSessionFixture(overrides), NOW),
            }).bucket;

        // Quiet is not settled: no turn in flight says nothing about the work being done.
        expect(bucketOf({ active: true, activeAt: NOW })).toBe('idle');
        // The owner's own settlement: its latest turn completed and it says Ready.
        expect(bucketOf({ active: true, activeAt: NOW, latestTurnStatus: 'completed' })).toBe('finished');
        // Runtime detach does not invalidate the completed turn's authoritative settlement.
        expect(bucketOf({ presence: 1, active: false, activeAt: 1, latestTurnStatus: 'completed' })).toBe('finished');
        expect(bucketOf({ presence: 1, active: false, activeAt: 1 })).toBe('offline');
    });

    it('never calls a lead settled while its reports are still outstanding (R-10), whoever counts them', () => {
        const lead = createSessionListRenderableSessionFixture({
            active: true, activeAt: NOW, latestTurnStatus: 'completed', managedSessions: { total: 2, working: 1, needsYou: 0, stalled: 0, finished: 0, attentionPrimary: 'thinking' },
        });
        // The server's count of the lead's reports, read from the Session itself.
        const fromAwareness = readSessionWorkStatusFacts(lead, NOW);
        expect(fromAwareness.settled).toBe(false);
        expect(resolveWorkStatusTone({ kind: 'session', facts: fromAwareness }).bucket).not.toBe('finished');

        // The Work projection, which counts the subtree it holds, supplies its own count.
        const ready = createSessionListRenderableSessionFixture({ active: true, activeAt: NOW, latestTurnStatus: 'completed' });
        const settled = readSessionWorkStatusFacts(ready, NOW);
        expect(settled.settled).toBe(true);
        expect(withOutstandingReports(settled, 1).settled).toBe(false);
        expect(withOutstandingReports(settled, 0)).toBe(settled);

        const doneReports = createSessionListRenderableSessionFixture({
            active: true, activeAt: NOW, latestTurnStatus: 'completed', managedSessions: { total: 2, working: 0, needsYou: 0, stalled: 0, finished: 2, attentionPrimary: null },
        });
        expect(readSessionWorkStatusFacts(doneReports, NOW).settled).toBe(true);
    });

    it('calls a Session stalled only when it is offline with a turn in flight, never because of its reports (O7)', () => {
        // An offline lead whose reports still work, with no turn of its own in flight: not settled (R-10),
        // and not stalled either.
        const offlineLead = createSessionListRenderableSessionFixture({
            presence: 1, active: false, activeAt: 1, managedSessions: { total: 2, working: 1, needsYou: 0, stalled: 0, finished: 0, attentionPrimary: 'thinking' },
        });
        expect(readSessionWorkStatusFacts(offlineLead, NOW).settled).toBe(false);
        expect(readSessionWorkStalled(offlineLead, NOW)).toBe(false);

        const offlineMidTurn = createSessionListRenderableSessionFixture({
            presence: 1, active: false, activeAt: 1, latestTurnStatus: 'in_progress',
        });
        expect(readSessionWorkStalled(offlineMidTurn, NOW)).toBe(true);

        const onlineMidTurn = createSessionListRenderableSessionFixture({
            active: true, activeAt: NOW, thinking: true, thinkingAt: NOW, latestTurnStatus: 'in_progress',
        });
        expect(readSessionWorkStalled(onlineMidTurn, NOW)).toBe(false);
    });
});
