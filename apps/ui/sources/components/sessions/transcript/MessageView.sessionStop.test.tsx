import * as React from 'react';
import { describe, expect, it, onTestFinished } from 'vitest';
import { SessionSystemRecordStoredSchema } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';
import { buildSessionStopSystemRecordLocalId } from '@happier-dev/protocol/sessions/system/records/activity/activitySystemRecordKinds';
import { normalizeRawMessage } from '@happier-dev/session-core/raw';
import { createReducer, reducer } from '@happier-dev/session-core/reducer';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
    createSessionSystemRecordHttpFixture,
    installDisconnectedServerSocketBoundary,
    restoreServerAccountForTest,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';

installMessageViewCommonModuleMocks();
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { MessageView } = await import('./MessageView');
const { AppSessionTranscriptSourceProvider } = await import('./source/appSessionTranscriptSource');
const { storage } = await import('@/sync/domains/state/storage');

describe('MessageView stop record Home scope', () => {
    it('renders the settled record at the message address instead of its requested sidecar', async () => {
        const previous = storage.getState();
        const at = new Date(2026, 9, 10, 13, 40).getTime();
        const localId = buildSessionStopSystemRecordLocalId({ at });
        const requested = { v: 1, status: 'requested', at, rule: 'idle_sessions', idleMs: 7_200_000 };
        // Captured Guard producer shape (qa-fgd1v): the ordinary event keeps requested
        // intent while the same-address Session system record advances to stopped.
        const normalized = normalizeRawMessage('stop-event', localId, at, {
            role: 'agent', content: { type: 'event', id: localId,
                data: { type: 'message', message: 'Happier requested this session to stop.', sessionStopV1: requested } },
        }, { seq: 1 });
        expect(normalized).not.toBeNull();
        const message = reducer(createReducer(), [normalized!]).messages[0]!;
        expect(message.kind).toBe('agent-event');
        const record = SessionSystemRecordStoredSchema.parse({
            id: 'settled-stop',
            address: { owner: 'host', namespace: 'activity', kind: 'session_stop.v1', localId },
            content: { t: 'plain', v: { ...requested, status: 'stopped', freedBytes: 820 * 1024 ** 2 } },
            revision: 'ssr1.AAAACHN5c3JlY18xAAAAAg',
            createdAt: new Date(at).toISOString(), updatedAt: new Date(at + 1000).toISOString(),
        });
        const http = createSessionSystemRecordHttpFixture({ sessionId: 'stopped-session', records: [record] });
        const account = createHomeHubArtifactHttpBoundary('account-a');
        const connection = await restoreServerAccountForTest({
            serverUrl: 'https://message-stop-home.test', request: async (input, init) => {
                const path = new URL(String(input)).pathname;
                if (path.startsWith('/v2/sessions/') && path !== '/v2/sessions/query') return http.request(input, init);
                return createEmptyAccountBootstrapHttpResponse(path, init) ?? account.request(input, init);
            },
        });
        onTestFinished(async () => {
            standardCleanup();
            await connection.dispose();
            storage.setState(previous, true);
        });
        const screen = await renderScreen(
            <AppSessionTranscriptSourceProvider sessionId="stopped-session" serverId={connection.serverId}>
                <MessageView sessionId="stopped-session" serverId={connection.serverId} metadata={null} message={message} />
            </AppSessionTranscriptSourceProvider>,
        );
        await expect.poll(() => screen.getTextContent()).toContain('machineGuard.session.markerIdle');
        expect(screen.findByTestId('transcript-event-session-stop')).not.toBeNull();
        expect(screen.getTextContent()).not.toContain('machineGuard.session.markerRequested');
        // One mounted marker demands one exact record, through the real Sync binding,
        // repository and decoder; it never scans the Session record inventory.
        expect(http.recordReads).toEqual([localId]);
    });
});
