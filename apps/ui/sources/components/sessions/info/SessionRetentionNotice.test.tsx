import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useServerRetentionPolicy = vi.fn();
const resolveServerIdForSessionIdFromLocalCache = vi.fn();

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

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache', () => ({
    resolveServerIdForSessionIdFromLocalCache,
}));

async function renderSessionRetentionNotice(sessionId: string) {
    const { SessionRetentionNotice } = await import('./SessionRetentionNotice');
    return renderScreen(React.createElement(SessionRetentionNotice, { sessionId }));
}

describe('SessionRetentionNotice', () => {
    it('renders nothing when the session server cannot be resolved', async () => {
        resolveServerIdForSessionIdFromLocalCache.mockReturnValue(null);
        useServerRetentionPolicy.mockReturnValue(null);

        const screen = await renderSessionRetentionNotice('session-a');

        expect(screen.findByTestId('session-retention-notice')).toBeNull();
    });

    it('renders a session retention notice when the server deletes inactive sessions', async () => {
        resolveServerIdForSessionIdFromLocalCache.mockReturnValue('server-a');
        useServerRetentionPolicy.mockReturnValue({
            enabled: true,
            completeness: 'complete',
            domains: [{
                id: 'sessions',
                policy: { mode: 'delete_inactive', inactivityDays: 30 },
            }],
        });

        const screen = await renderSessionRetentionNotice('session-a');

        const retentionNotice = screen.findByTestId('session-retention-notice');
        expect(retentionNotice).not.toBeNull();
        expect(screen.findByTestId('session-retention-notice-icon')).not.toBeNull();
        expect(screen.getTextContent()).toContain('server.retention.sessions');
        expect(screen.getTextContent()).toContain('This server deletes inactive sessions after 30 days of inactivity.');
    });
});
