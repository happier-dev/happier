import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSessionTurnsProjectionV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';

import { createSessionFixture, flushHookEffects, renderScreen } from '@/dev/testkit';
import { createHydratedPlainMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { storage } from '@/sync/domains/state/storageStore';
import { installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';

let routeParams: { id: string; serverId?: string } = { id: 'session-a' };
let revalidating = false;
const reads: { machineId: string; input: unknown; serverUrl: string | undefined }[] = [];
installSessionRouteCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return { ...createExpoRouterMock().module, useLocalSearchParams: () => routeParams };
    },
});
const runtime = installSessionPaneRuntimeTestHarness({
    sessionId: 'session-a',
    // A target Home temporarily unavailable during a different Home's publication is a real HTTP failure.
    request: async (url) => revalidating && new URL(String(url)).pathname.startsWith('/v2/sessions/')
        ? new Response('{}', { status: 503 }) : null,
    rpc: async (method, input, machineId, context) => {
        if (method !== 'daemon.session.log.tail') return { success: false, errorCode: 'FEATURE_UNSUPPORTED' };
        reads.push({ machineId, input, serverUrl: context.serverUrl });
        return { success: true, path: '/target/session.log', tail: 'target tail' };
    },
});
const { SessionLogScreen } = await import('@/app/(app)/session/[id]/log');

beforeEach(() => { reads.length = 0; revalidating = false; });

describe('Session log Home targeting', () => {
    it.each(['ambient', 'explicit'] as const)('keeps %s log reads on their Session Home', async scope => {
        routeParams = { id: 'session-a', ...(scope === 'explicit' ? { serverId: runtime.serverId } : {}) };
        const targetMachine = createHydratedPlainMachineFixture({ id: 'machine-target', accountId: 'account-a', machine: { activeAt: Date.now() } });
        const otherMachine = createHydratedPlainMachineFixture({ id: 'machine-other', accountId: 'account-a', machine: { activeAt: Date.now() } });
        const target = createSessionFixture({ id: 'session-a', serverId: runtime.serverId, seq: 1,
            metadata: { machineId: targetMachine.id, path: '/target', host: 'target', sessionLogPath: '/target/session.log' },
            sessionTurns: buildSessionTurnsProjectionV1({ sessionId: 'session-a', updatedAt: 1, turns: [] }) });
        storage.setState({ sessions: { 'session-a': target }, machines: { [targetMachine.id]: targetMachine, [otherMachine.id]: otherMachine },
            machineListByServerId: { [runtime.serverId]: [targetMachine, otherMachine] } });
        await renderScreen(<SessionLogScreen />, { wrapper: runtime.Wrapper });
        await vi.waitFor(() => expect(reads).toEqual([
            { machineId: targetMachine.id, input: { path: '/target/session.log', maxBytes: 200_000 }, serverUrl: 'https://session-pane.test' },
        ]));
        if (scope === 'ambient') return;

        revalidating = true;
        const other = createSessionFixture({ id: target.id, serverId: 'other-home', seq: 1,
            metadata: { machineId: otherMachine.id, path: '/other', host: 'other', sessionLogPath: '/other/session.log' },
            sessionTurns: buildSessionTurnsProjectionV1({ sessionId: target.id, updatedAt: 1, turns: [] }) });
        await act(async () => storage.setState({ sessions: { [other.id]: other },
            machines: { [targetMachine.id]: targetMachine, [otherMachine.id]: otherMachine },
            machineListByServerId: { [runtime.serverId]: [targetMachine, otherMachine], 'other-home': [otherMachine] } }));
        await flushHookEffects();
        expect(reads).toEqual([
            { machineId: targetMachine.id, input: { path: '/target/session.log', maxBytes: 200_000 }, serverUrl: 'https://session-pane.test' },
        ]);
    });
});
