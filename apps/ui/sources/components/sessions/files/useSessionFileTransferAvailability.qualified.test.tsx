import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from './views/sessionFilesViewTestkit';
import '@/components/workspaces/files/repositoryTree/repositoryUploadBrowserTestFixture';

installSessionFilesViewBoundaries();
// The canonical fixture replaces only the external Iroh SDK; lifecycle/probe decisions stay real.

describe('Session transfer availability qualifies its Machine', () => {
    let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>> | undefined;
    beforeAll(prepareSessionFilesViewTestkit);
    afterEach(async () => { standardCleanup(); await fixture?.dispose(); });
    it('rejects a same-id active Machine outside the addressed Home and recovers only its own projection', async () => {
        fixture = await createSessionFilesViewFixture({ rootPath: '/qualified-transfer-browser' });
        const { installTransferProjection, transferMachine } = await import('./sessionFileTransferTestkit');
        const { useSessionFileTransferAvailability } = await import('./useSessionFileTransferAvailability');
        const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
        const { setActiveServer } = await import('@/sync/domains/server/serverRuntime');
        const activeHome = (await upsertServerProfile({ serverUrl: 'https://other-transfer-home.test' })).id;
        const machine = transferMachine({ id: fixture.scope.machineId, active: true, activeAt: Date.now() });
        installTransferProjection({ serverId: fixture.scope.serverId, session: fixture.session, machine: null, globalMachine: machine });
        await setActiveServer({ serverId: activeHome });
        fixture.storage.setState({ machineListByServerId: { [activeHome]: [machine], [fixture.scope.serverId]: [] } });
        let available: boolean | undefined;
        const session = fixture.session;
        const serverId = fixture.scope.serverId;
        function Reader() { available = useSessionFileTransferAvailability(session.id, serverId); return null; }
        await fixture.render(<Reader />);
        expect(available).toBe(false);
        await act(async () => installTransferProjection({ serverId, session, machine }));
        await vi.waitFor(() => expect(available).toBe(true));
    });
});
