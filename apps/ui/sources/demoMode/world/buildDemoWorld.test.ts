import {
    readLinkedExternalSessionV1FromMetadata,
    readServerEnabledBit,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { readSessionWorkspaceContext } from '@/sync/domains/session/readSessionWorkspaceContext';
import { deriveSessionRuntimePresentationState } from '@/sync/domains/session/attention/runtimePresentation';
import { getSessionStorageKind } from '@/sync/domains/session/sessionStorageKind';
import {
    buildDemoWorld,
    createDemoExternalSessionBrowseCandidateFixture,
    DEMO_RICH_SESSION_ID,
} from './buildDemoWorld';
import {
    DEMO_MACHINE_ID,
    DEMO_OPEN_CODE_PROVIDER_SESSION_ID,
    DEMO_PROJECT_PATH,
    DEMO_REVIEW_SESSION_ID,
} from './constants';

describe('buildDemoWorld', () => {
    it('builds the canonical production-safe demo world', () => {
        const world = buildDemoWorld();
        const richSession = world.sessions.find((session) => session.id === DEMO_RICH_SESSION_ID);

        expect(world.sessions.length).toBeGreaterThanOrEqual(9);
        expect(world.machines.length).toBeGreaterThanOrEqual(2);
        expect(richSession?.encryptionMode).toBe('plain');
        expect(richSession?.metadata?.sessionModelsV1).toMatchObject({
            agentId: 'opencode',
            currentModelId: expect.any(String),
            availableModels: expect.arrayContaining([expect.objectContaining({ id: expect.any(String) })]),
        });
        expect(richSession?.metadata?.sessionConfigOptionsV1).toMatchObject({
            agentId: 'opencode',
            configOptions: expect.arrayContaining([expect.objectContaining({ id: expect.any(String) })]),
        });
        expect(getSessionStorageKind(richSession)).toBe('direct');
        expect(readLinkedExternalSessionV1FromMetadata(richSession?.metadata)).toMatchObject({
            v: 1,
            agentId: 'opencode',
            machineId: DEMO_MACHINE_ID,
            remoteSessionId: DEMO_OPEN_CODE_PROVIDER_SESSION_ID,
            source: {
                kind: 'opencodeServer',
                directory: DEMO_PROJECT_PATH,
            },
            qualifiedIdentity: {
                v: 1,
                agent: {
                    pluginId: 'happier.agent.opencode',
                    localId: 'opencode',
                },
                source: {
                    kind: 'opencodeServer',
                    contractVersion: 1,
                },
            },
        });
        expect(richSession?.metadata?.directSessionV1).toMatchObject({
            v: 1,
            providerId: 'opencode',
            machineId: DEMO_MACHINE_ID,
            remoteSessionId: DEMO_OPEN_CODE_PROVIDER_SESSION_ID,
        });
        expect(richSession?.metadata?.directSessionV1).not.toHaveProperty('qualifiedIdentity');
        expect(richSession?.metadata?.directSessionV1).not.toHaveProperty('linkData');

        const browseCandidate = createDemoExternalSessionBrowseCandidateFixture();
        expect(browseCandidate).toMatchObject({
            remoteSessionId: DEMO_OPEN_CODE_PROVIDER_SESSION_ID,
            details: {
                machineId: DEMO_MACHINE_ID,
                path: DEMO_PROJECT_PATH,
                source: {
                    kind: 'opencodeServer',
                    directory: DEMO_PROJECT_PATH,
                },
            },
        });
        const richMessages = world.messages[DEMO_RICH_SESSION_ID] ?? [];
        expect(richMessages.length).toBeGreaterThanOrEqual(8);
        expect(richMessages.some((message) =>
            message.role === 'agent' && message.content.some((content) => content.type === 'tool-call')
        )).toBe(true);
        const transcriptText = richMessages
            .flatMap((message) => Array.isArray(message.content)
                ? message.content.map((content) => content.type === 'text' ? content.text : '')
                : [message.content.type === 'text' ? message.content.text : ''])
            .join('\n');
        expect(transcriptText).toContain('```tsx');
        expect(transcriptText).toContain('+');
        expect(transcriptText).toContain('-');

        const workingSessions = world.sessions.filter((session) => session.active || session.thinking);
        const visiblyWorkingSessions = world.sessions.filter((session) => (
            deriveSessionRuntimePresentationState({ ...session, nowMs: Date.now() }).working
        ));
        const needsAttentionSessions = world.sessions.filter((session) => (session.pendingBlockedCount ?? 0) > 0);
        expect(workingSessions.length).toBeGreaterThanOrEqual(2);
        expect(workingSessions.length).toBeLessThanOrEqual(3);
        expect(visiblyWorkingSessions.length).toBeGreaterThanOrEqual(2);
        expect(visiblyWorkingSessions.length).toBeLessThanOrEqual(3);
        expect(needsAttentionSessions.length).toBeGreaterThanOrEqual(2);
        expect(needsAttentionSessions.length).toBeLessThanOrEqual(3);
        expect(richSession).toMatchObject({
            lastViewedSessionSeq: richSession?.seq,
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 1,
        });
        expect(richSession?.metadata?.readStateV1).toMatchObject({
            sessionSeq: richSession?.seq,
            pendingActivityAt: expect.any(Number),
        });
        expect(richSession?.metadata).not.toHaveProperty('machineId');
        expect(world.pending[DEMO_RICH_SESSION_ID]?.messages).toHaveLength(1);
        expect(world.pending[DEMO_RICH_SESSION_ID]?.messages[0]).toMatchObject({
            source: 'local_outbound',
            deliveryStatus: 'queued',
            pendingDeliveryStatus: 'server_queued',
        });
        expect(world.reviewComments[DEMO_RICH_SESSION_ID]?.[0]).toMatchObject({
            source: 'diff',
            includeInPrompt: true,
        });
        expect(world.serverFeatures.features.sessions.folders.enabled).toBe(false);
        // A12 subscriptions/accounts beat: connected services enabled so the real
        // screen shows the service catalog + pools instead of the disabled stub.
        expect(world.serverFeatures.features.connectedServices.enabled).toBe(true);
        expect(readServerEnabledBit(world.serverFeatures, 'connectedServices.accountGroups')).toBe(true);

        // A8 review beat: a distinct seeded review session with a diff transcript
        // and two line-anchored review comment drafts (the diff-and-notes loop).
        const reviewMessages = world.messages[DEMO_REVIEW_SESSION_ID] ?? [];
        expect(reviewMessages.length).toBeGreaterThanOrEqual(3);
        expect(reviewMessages.some((message) =>
            message.role === 'agent' && message.content.some((content) => content.type === 'tool-call')
        )).toBe(true);
        expect(world.reviewComments[DEMO_REVIEW_SESSION_ID]).toHaveLength(2);
        expect(world.reviewComments[DEMO_REVIEW_SESSION_ID]?.[0]).toMatchObject({
            source: 'diff',
            includeInPrompt: true,
        });
        expect(world.settings).toMatchObject({
            featureToggles: {
                'execution.runs': false,
                'sessions.direct': true,
            },
            hideInactiveSessions: false,
            sessionListAttentionPromotionModeV1: 'global',
            sessionListWorkingPlacementModeV1: 'global',
            sessionListDensity: 'narrow',
            sessionListSectionModeV1: 'single',
        });

        for (const session of world.sessions) {
            expect(session.encryptionMode).toBe('plain');
            expect(session.metadata).not.toHaveProperty('workspacePath');
            expect(readSessionWorkspaceContext({ sessions: { [session.id]: session } }, session.id).workspacePath)
                .toBe(session.id === DEMO_RICH_SESSION_ID ? DEMO_PROJECT_PATH : null);
        }
        for (const machine of world.machines) {
            expect(machine.active).toBe(false);
            expect(machine.metadata).not.toHaveProperty('workspacePath');
        }
    });
});
