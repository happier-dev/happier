import { afterEach, describe, expect, it } from 'vitest';
import { storage } from '@/sync/domains/state/storageStore';
import { setScreenSharingPrivacyActive } from '@/desktop/capture/useNativeRecordingActive';

import { createSessionListRenderableSessionFixture } from '@/dev/testkit';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import type { SessionListHomeObservation } from '@/sync/domains/session/listing/sessionListHomeObservation';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';

import { projectActionOperationSourceContext } from './actionOperationSourceContext';

type ActionOperationSnapshot = ActionOperationProjection['snapshot'];

const NOW_MS = 1_000 + 18 * 60 * 1_000;

function snapshot(overrides: Partial<ActionOperationSnapshot> = {}): ActionOperationSnapshot {
    return {
        version: 1,
        operationId: 'operation-1',
        revision: 1,
        actionId: 'plugin.example.deploy',
        state: 'running',
        scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 'session-1' },
        title: 'Deploy preview',
        createdAt: 1_000,
        startedAt: 1_010,
        cancellation: 'unsupported',
        ...overrides,
    };
}

const HOME_B: ServerProfile = {
    id: 'home-b',
    name: 'Home B',
    serverUrl: 'https://home-b.example',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: 1,
};

function project(params: Readonly<{
    homeObservation: SessionListHomeObservation | null;
    session?: ReturnType<typeof createSessionListRenderableSessionFixture> | null;
}>) {
    return projectActionOperationSourceContext({
        serverId: 'home-b',
        snapshot: snapshot(),
        session: params.session === undefined
            ? createSessionListRenderableSessionFixture({ id: 'session-1' })
            : params.session,
        machine: null,
        serverProfile: HOME_B,
        homeObservation: params.homeObservation,
        nowMs: NOW_MS,
    });
}

describe('projectActionOperationSourceContext home observation', () => {
    afterEach(() => setScreenSharingPrivacyActive(false));
    it('withholds a hidden source title and path while keeping the operation address', () => {
        const original = storage.getState();
        try {
            storage.getState().applySettingsLocal({ sessionListHiddenTagIdsWhileRecording: { 'home-b': ['private'] } });
            storage.getState().setSessionTagAssignmentsOptimistic('home-b', 'session-1', ['private']);
            setScreenSharingPrivacyActive(true);
            const context = project({ homeObservation: null });
            expect(context.contextLine).not.toContain('~/project');
            expect(context.address).toEqual({ serverId: 'home-b', sessionId: 'session-1' });
        } finally { storage.setState(original, true); }
    });
    it('shows the exact Home and its offline freshness for a retained secondary-Home operation', () => {
        const context = project({ homeObservation: { phase: 'offline', lastSuccessAt: 1_000 } });

        expect(context.contextLine).toBe('Home B · Offline · Last updated 18m ago · ~/project');
        expect(context.accessibilityContext).toBe('Home B · Offline · Last updated 18m ago · ~/project');
        expect(context.address).toEqual({ serverId: 'home-b', sessionId: 'session-1' });
    });

    it('dates staleness from the canonical Home observation, never from Session timestamps', () => {
        const context = project({
            homeObservation: { phase: 'error', lastSuccessAt: 1_000 },
            // A Session the list happens to have touched recently must not make the Home look current.
            session: createSessionListRenderableSessionFixture({
                id: 'session-1',
                createdAt: NOW_MS,
                updatedAt: NOW_MS,
                activeAt: NOW_MS,
            }),
        });

        expect(context.contextLine).toBe("Home B · Couldn't refresh · Last updated 18m ago · ~/project");
    });

    it('keeps a reachable Home free of any offline or stale claim', () => {
        const context = project({ homeObservation: { phase: 'ready', lastSuccessAt: 1_000 } });

        expect(context.contextLine).toBe('Home B · ~/project');
    });

    it('retains safe Home and freshness context for locked content while withholding the title', () => {
        const context = project({
            homeObservation: { phase: 'offline', lastSuccessAt: 1_000 },
            session: createSessionListRenderableSessionFixture({
                id: 'session-1',
                encryptionMode: 'e2ee',
                encryptedContentAvailability: 'encrypted_access_pending',
            }),
        });

        expect(context.sessionTitle).toBeNull();
        expect(context.contextLine).toBe('Home B · Offline · Last updated 18m ago · Encrypted access pending');
    });

    it('leaves currentness unknown rather than assumed when the Home has no observation', () => {
        const context = project({ homeObservation: null });

        expect(context.contextLine).toBe('Home B · ~/project');
    });
});
