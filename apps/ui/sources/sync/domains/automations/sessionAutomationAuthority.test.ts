import { describe, expect, it } from 'vitest';

import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { captureSessionAutomationAuthority } from './sessionAutomationAuthority';

function createAccountLifetime() {
    let current = true;
    const lifetime: ActiveServerAccountScopeLifetime = {
        scope: { serverId: 'server-1', accountId: 'account-1' },
        isCurrent: () => current,
        onRetire: () => ({ dispose() {} }),
    };
    return { lifetime, retire: () => { current = false; } };
}

describe('captureSessionAutomationAuthority', () => {
    it('accepts only the hydrated Session owner on the active server and Account lifetime', () => {
        const { lifetime: accountLifetime } = createAccountLifetime();
        const current = {
            session: { id: 'session-1', serverId: 'server-1' },
            routeSessionId: 'session-1',
            routeServerId: 'server-1',
            activeServerId: 'server-1',
            automationsEnabled: true,
        };

        const authority = captureSessionAutomationAuthority({
            ...current,
            accountLifetime,
            readCurrent: () => current,
        });

        expect(authority).toMatchObject({ sessionId: 'session-1', serverId: 'server-1' });
        expect(authority?.isCurrent()).toBe(true);
    });

    it('does not promote a route server hint over the hydrated Session owner', () => {
        const { lifetime: accountLifetime } = createAccountLifetime();

        expect(captureSessionAutomationAuthority({
            session: { id: 'session-1', serverId: 'server-1' },
            routeSessionId: 'session-1',
            routeServerId: 'server-2',
            activeServerId: 'server-2',
            automationsEnabled: true,
            accountLifetime,
            readCurrent: () => ({
                session: { id: 'session-1', serverId: 'server-1' },
                routeSessionId: 'session-1',
                routeServerId: 'server-2',
                activeServerId: 'server-2',
                automationsEnabled: true,
            }),
        })).toBeNull();
    });

    it('becomes stale when the Session, route, server, feature decision, or Account lifetime changes', () => {
        const { lifetime: accountLifetime, retire } = createAccountLifetime();
        const current = {
            session: { id: 'session-1', serverId: 'server-1' } as { id: string; serverId: string },
            routeSessionId: 'session-1' as string | null,
            routeServerId: 'server-1' as string | null,
            activeServerId: 'server-1' as string | null,
            automationsEnabled: true,
        };
        const authority = captureSessionAutomationAuthority({
            ...current,
            accountLifetime,
            readCurrent: () => current,
        });
        expect(authority?.isCurrent()).toBe(true);

        current.session = { id: 'session-2', serverId: 'server-1' };
        expect(authority?.isCurrent()).toBe(false);
        current.session = { id: 'session-1', serverId: 'server-1' };
        current.automationsEnabled = false;
        expect(authority?.isCurrent()).toBe(false);
        current.automationsEnabled = true;
        retire();
        expect(authority?.isCurrent()).toBe(false);
    });
});
