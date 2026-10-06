import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createSessionFixture, renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/components/ui/avatar/Avatar', () => ({ Avatar: 'Avatar' }));
vi.mock('../presentation/SessionAgentCatalogIdentityIcon', () => ({
    SessionAgentCatalogIdentityIcon: 'SessionAgentCatalogIdentityIcon',
}));

describe('SessionListIdentity', () => {
    it('projects the selected provider logo with the exact Home context', async () => {
        const { SessionListIdentity } = await import('./SessionListIdentity');
        const session = createSessionFixture({
            metadata: {
                path: '/repo',
                machineId: 'machine-a',
                flavor: 'codex',
            } as ReturnType<typeof createSessionFixture>['metadata'],
        });
        const screen = await renderScreen(
            <SessionListIdentity
                session={session}
                display="agentLogo"
                serverId="server-a"
                color="currentColor"
                avatarSize={28}
                agentLogoSize={22}
                connected={true}
                testID="identity"
            />,
        );

        expect(screen.tree.root.findByType('SessionAgentCatalogIdentityIcon').props).toMatchObject({
            agentId: 'codex',
            machineId: 'machine-a',
            serverId: 'server-a',
            size: 22,
            testID: 'identity',
        });
        expect(screen.tree.root.findAllByType('Avatar')).toHaveLength(0);
    });

    it('leaves an unresolved list-only provider to the catalog identity fallback', async () => {
        const { SessionListIdentity } = await import('./SessionListIdentity');
        const session = {
            id: 'background-session',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            metadataVersion: 1,
            agentStateVersion: 1,
            metadata: { path: '/repo', machineId: 'machine-b', flavor: null },
            thinking: false,
            thinkingAt: 0,
            presence: 'online' as const,
        };
        const screen = await renderScreen(
            <SessionListIdentity
                session={session}
                display="agentLogo"
                serverId="server-b"
                color="currentColor"
                avatarSize={28}
                agentLogoSize={22}
                connected={false}
            />,
        );

        expect(screen.tree.root.findByType('SessionAgentCatalogIdentityIcon').props).toMatchObject({
            agentId: '',
            machineId: 'machine-b',
            serverId: 'server-b',
        });
        expect(screen.tree.root.findAllByType('Avatar')).toHaveLength(0);
    });
});
