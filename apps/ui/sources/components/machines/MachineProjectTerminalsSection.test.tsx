import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { MachineProjectTerminalsSection } from './MachineProjectTerminalsSection';
const push = vi.hoisted(() => vi.fn());
vi.mock('expo-router', async () => { const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router'); return createExpoRouterMock({ router: { push } }).module; });
vi.mock('react-native', async () => { const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative'); return createReactNativeWebMock(); });
vi.mock('react-native-unistyles', async () => { const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles'); return createUnistylesMock(); });
describe('Machine to admitted Project terminal', () => {
    it('offers only this requester’s accepted roots on the qualified Machine and opens the canonical Project terminal surface', async () => {
        const home = await serveActionHomes({ homes: [{ key: 'machine', serverUrl: 'https://machine-project-terminal.test', accountId: 'bob' }], route: () => undefined });
        try {
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
            const serverId = home.homes.machine!.id;
            const accepted = { id: 'accepted', machineId: 'machine', rootPath: '/admitted', serverId, createdAtMs: 1 };
            applyProjectAccountRowsFixture(storage, { workspaceRefs: [accepted, { ...accepted, id: 'elsewhere', machineId: 'other-machine' },
                { ...accepted, id: 'other-home', serverId: 'another-home' }] });
            push.mockReset();
            const screen = await renderScreen(<MachineProjectTerminalsSection machineId="machine" serverId={serverId} />);
            expect(screen.findByTestId('machine-project-terminal-elsewhere')).toBeNull();
            expect(screen.findByTestId('machine-project-terminal-other-home')).toBeNull();
            await screen.pressByTestIdAsync('machine-project-terminal-accepted');
            const route = new URL(push.mock.calls[0][0], 'https://happier.test');
            expect(route.pathname).toBe('/projects/accepted/overview');
            expect(route.searchParams.get('mobileSurface')).toBe('terminal');
            expect(route.searchParams.get('serverId')).toBe(serverId);
            await screen.unmount();
        } finally { home.dispose(); }
    });
});
