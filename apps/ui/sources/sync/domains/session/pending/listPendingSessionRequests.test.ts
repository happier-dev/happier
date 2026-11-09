import { afterEach, describe, expect, it } from 'vitest';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import type { Message } from '@happier-dev/session-core/messages';
import type { Metadata } from '@happier-dev/session-core/state';
import { readSessionPresentationCompletedRequests } from '@/sync/domains/session/presentation/readSessionPresentationCompletedRequests';
import { derivePendingRequestFlagsFromSession, listPendingSessionRequests } from './listPendingSessionRequests';
import { sessionRuntimeObservations } from '../sessionRuntimeObservation';

afterEach(() => sessionRuntimeObservations.clear());

describe('pending request facts adapter', () => {
    it.each([undefined, 1_200])('orders projected pending fallback against the full-publication witness (observedAt %s)', observedAt => {
        const session = createSessionFixture({ id: 'pending-witness', serverId: 'pending-witness-home',
            active: true, updatedAt: 1_000, metadata: null, agentState: null,
            pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 0,
            ...(observedAt !== undefined ? { pendingRequestObservedAt: observedAt } : {}) });
        const messages: Message[] = [{ id: 'terminal-permission', kind: 'tool-call', localId: null, createdAt: 1_500,
            tool: { id: 'terminal-tool', name: 'Bash', state: 'completed', input: {}, createdAt: 1_500,
                startedAt: 1_500, completedAt: 1_600, description: null,
                permission: { id: 'terminal-permission', status: 'approved' } }, children: [] }];
        const address = { serverId: 'pending-witness-home', sessionId: session.id };
        sessionRuntimeObservations.observe(address, { active: true, activeAt: 1_000 });
        sessionRuntimeObservations.recordFullPublication(address, 2_000);

        expect(derivePendingRequestFlagsFromSession(session, messages).hasPendingPermissionRequests).toBe(observedAt === undefined);
        expect(derivePendingRequestFlagsFromSession({ ...session, serverId: 'different-home' }, messages).hasPendingPermissionRequests).toBe(false);
        expect(derivePendingRequestFlagsFromSession({ ...session, serverId: undefined }, messages).hasPendingPermissionRequests).toBe(false);
        expect(session.updatedAt).toBe(1_000);
    });

    it('uses stored public completions for recipients, ignoring additive fields but rejecting invalid known fields', () => {
        const requestId = 'permission-publicly-completed';
        const createdAt = 1_000;
        const messages: Message[] = [{
            id: 'message-publicly-completed',
            kind: 'tool-call',
            localId: null,
            createdAt,
            tool: {
                id: 'tool-publicly-completed',
                name: 'Bash',
                state: 'running',
                input: { command: 'git status' },
                createdAt,
                startedAt: createdAt,
                completedAt: null,
                description: null,
                permission: {
                    id: requestId,
                    status: 'pending',
                },
            },
            children: [],
        }];
        const completedRequests = {
            [requestId]: {
                tool: 'Bash',
                kind: 'permission',
                createdAt,
                completedAt: createdAt + 100,
                status: 'approved',
            },
        };
        const sharedMetadata = {
            v: 1,
            publicAgentState: {
                completedRequests,
            },
        } as unknown as Metadata;

        const recipient = createSessionFixture({
            active: true,
            accessLevel: 'view',
            metadataLayoutVersion: 1,
            metadata: sharedMetadata,
            agentState: null,
        });
        const owner = createSessionFixture({
            active: true,
            metadataLayoutVersion: 1,
            metadata: sharedMetadata,
            agentState: {
                requests: {},
                completedRequests: {},
            },
        });
        const additiveRecipient = createSessionFixture({
            active: true,
            accessLevel: 'view',
            metadataLayoutVersion: 1,
            metadata: {
                ...sharedMetadata,
                path: '/private/path-must-not-pass',
            },
            agentState: null,
        });
        const malformedRecipient = createSessionFixture({
            ...additiveRecipient,
            metadata: {
                ...sharedMetadata,
                path: '/private/path-must-not-pass',
                publicAgentState: {
                    completedRequests: {
                        [requestId]: {
                            ...completedRequests[requestId],
                            status: 'invalid-status',
                        },
                    },
                },
            },
        });

        expect(readSessionPresentationCompletedRequests(recipient)).toEqual(
            completedRequests,
        );
        expect(listPendingSessionRequests(recipient, messages)).toEqual([]);
        expect(listPendingSessionRequests(owner, messages)).toEqual([
            expect.objectContaining({ id: requestId, tool: 'Bash' }),
        ]);
        expect(readSessionPresentationCompletedRequests(additiveRecipient)).toEqual(completedRequests);
        expect(listPendingSessionRequests(additiveRecipient, messages)).toEqual([]);
        expect(readSessionPresentationCompletedRequests(malformedRecipient)).toBeNull();
        expect(listPendingSessionRequests(malformedRecipient, messages)).toEqual([
            expect.objectContaining({ id: requestId, tool: 'Bash' }),
        ]);
    });

});
