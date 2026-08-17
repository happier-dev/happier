import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useServerRetentionPolicy = vi.fn();
const resolveSessionListLookupSessionServerId = vi.fn();

vi.mock('@/hooks/server/useServerRetentionPolicy', () => ({
    useServerRetentionPolicy,
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, params?: { count?: number }) => {
            if (key === 'server.retention.title') return 'Retention policy';
            if (key === 'server.retention.sessionNotice') return `This server deletes inactive sessions after ${params?.count ?? 0} days of inactivity.`;
            return key;
        },
    });
});

vi.mock('@/sync/domains/session/listing/sessionListLookupState', async () => {
    const actual = await vi.importActual<typeof import('@/sync/domains/session/listing/sessionListLookupState')>(
        '@/sync/domains/session/listing/sessionListLookupState',
    );

    return {
        ...actual,
        resolveSessionListLookupSessionServerId,
    };
});

async function renderSessionRetentionNotice(sessionId: string) {
    const { SessionRetentionNotice } = await import('./SessionRetentionNotice');
    return renderScreen(React.createElement(SessionRetentionNotice, { sessionId }));
}

describe('SessionRetentionNotice', () => {
    it('renders nothing when the session server cannot be resolved', async () => {
        resolveSessionListLookupSessionServerId.mockReturnValue(null);
        useServerRetentionPolicy.mockReturnValue(null);

        const screen = await renderSessionRetentionNotice('session-a');

        expect(screen.findByTestId('session-retention-notice')).toBeNull();
    });

    it('renders a session retention notice when the server deletes inactive sessions', async () => {
        resolveSessionListLookupSessionServerId.mockReturnValue('server-a');
        useServerRetentionPolicy.mockReturnValue({
            enabled: true,
            sessions: {
                mode: 'delete_inactive',
                inactivityDays: 30,
                requires: ['updatedAt', 'lastActiveAt'],
            },
            accountChanges: { mode: 'keep_forever' },
            voiceSessionLeases: { mode: 'keep_forever' },
            userFeedItems: { mode: 'keep_forever' },
            sessionShareAccessLogs: { mode: 'keep_forever' },
            publicShareAccessLogs: { mode: 'keep_forever' },
            terminalAuthRequests: { mode: 'keep_forever' },
            accountAuthRequests: { mode: 'keep_forever' },
            authPairingSessions: { mode: 'keep_forever' },
            repeatKeys: { mode: 'keep_forever' },
            globalLocks: { mode: 'keep_forever' },
            automationRuns: { mode: 'keep_forever' },
            automationRunEvents: { mode: 'keep_forever' },
        });

        const screen = await renderSessionRetentionNotice('session-a');

        const retentionNotice = screen.findByTestId('session-retention-notice');
        expect(retentionNotice).not.toBeNull();
        expect(screen.findByTestId('session-retention-notice-icon')).not.toBeNull();
        expect(screen.getTextContent()).toContain('server.retention.sessions');
        expect(screen.getTextContent()).toContain('This server deletes inactive sessions after 30 days of inactivity.');
    });

    it('recomputes the resolved server id when the storage snapshot changes between renders', async () => {
        resolveSessionListLookupSessionServerId.mockReturnValueOnce('server-a');
        resolveSessionListLookupSessionServerId.mockReturnValueOnce('server-b');
        useServerRetentionPolicy.mockImplementation((serverId) => {
            if (serverId === 'server-b') {
                return {
                    enabled: true,
                    sessions: {
                        mode: 'delete_inactive',
                        inactivityDays: 14,
                        requires: ['updatedAt', 'lastActiveAt'],
                    },
                    accountChanges: { mode: 'keep_forever' },
                    voiceSessionLeases: { mode: 'keep_forever' },
                    userFeedItems: { mode: 'keep_forever' },
                    sessionShareAccessLogs: { mode: 'keep_forever' },
                    publicShareAccessLogs: { mode: 'keep_forever' },
                    terminalAuthRequests: { mode: 'keep_forever' },
                    accountAuthRequests: { mode: 'keep_forever' },
                    authPairingSessions: { mode: 'keep_forever' },
                    repeatKeys: { mode: 'keep_forever' },
                    globalLocks: { mode: 'keep_forever' },
                    automationRuns: { mode: 'keep_forever' },
                    automationRunEvents: { mode: 'keep_forever' },
                };
            }

            return null;
        });

        const screen = await renderSessionRetentionNotice('session-a');
        expect(screen.findByTestId('session-retention-notice')).toBeNull();

        await screen.update(React.createElement((await import('./SessionRetentionNotice')).SessionRetentionNotice, { sessionId: 'session-a' }));

        expect(screen.findByTestId('session-retention-notice')).not.toBeNull();
        expect(screen.getTextContent()).toContain('This server deletes inactive sessions after 14 days of inactivity.');
    });
});
